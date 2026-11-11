"""
Agent endpoints (/agent/*), served by nginx on the agent port (:8443) only.

Without a client certificate: GET /agent/ca.pem, POST /agent/enroll,
POST /agent/register, GET /agent/register/<id> (with X-Request-Secret).
Everything else requires the instance certificate (auth.py).
"""
import asyncio
import hashlib
import hmac
import json
import logging
import os
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.websockets import WebSocketDisconnect

from config import MANAGER_VERSION
from core.auth.rate_limiter import login_rate_limiter
from core.database import async_session_maker, get_session
from core.http import get_client_ip

from manager import pki
from manager.enrollment import service as enrollment_service
from manager.models import AgentCertificate, Backup, Command, EnrollmentToken, Instance
from manager.instances.service import apply_facts, record_addresses, revoke_instance
from . import dispatcher, protocol
from .auth import authenticate
from .reconcile import reconcile
from .registry import AgentConnection, registry

logger = logging.getLogger("madmin_manager.agents")

router = APIRouter(prefix="/agent", include_in_schema=False)

_HELLO_TIMEOUT = 15
MAX_BACKUP_SIZE = 2 * 1024 ** 3


async def require_agent(request: Request, session: AsyncSession = Depends(get_session)):
    found = await authenticate(session, request)
    if found is None:
        raise HTTPException(403, "Certificato non valido o istanza revocata")
    return found


async def require_agent_or_suspended(request: Request, session: AsyncSession = Depends(get_session)):
    """Also a suspended instance: renewal and unenroll keep working."""
    found = await authenticate(session, request, allow_suspended=True)
    if found is None:
        raise HTTPException(403, "Certificato non valido o istanza revocata")
    return found


# --- Enrollment ---

@router.get("/ca.pem")
async def get_ca():
    return Response(pki.ca_pem(), media_type="application/x-pem-file")


class EnrollRequest(BaseModel):
    token_id: str = Field(max_length=32)
    secret: str = Field(max_length=128)
    csr: str = Field(max_length=8192)
    protocol: int
    facts: dict = Field(default_factory=dict)


@router.post("/enroll")
async def enroll(body: EnrollRequest, request: Request, session: AsyncSession = Depends(get_session)):
    client_ip = get_client_ip(request)
    limit_key = f"enroll:{client_ip}"
    login_rate_limiter.begin_attempt(limit_key)

    async def reject(detail: str, code: int = 401):
        await login_rate_limiter.record_failure(session, limit_key)
        await session.commit()
        raise HTTPException(code, detail)

    if body.protocol != protocol.PROTOCOL_VERSION:
        raise HTTPException(400, f"Versione di protocollo {body.protocol} non supportata")

    token = (await session.execute(
        select(EnrollmentToken).where(EnrollmentToken.id == body.token_id).with_for_update()
    )).scalar_one_or_none()
    digest = hashlib.sha256(body.secret.encode()).hexdigest()
    if token is None or not hmac.compare_digest(digest, token.secret_hash):
        await reject("Token di enrollment non valido")
    if token.revoked or token.expires_at <= datetime.utcnow():
        await reject("Token di enrollment scaduto o revocato")
    if token.max_uses is not None and token.uses >= token.max_uses:
        await reject("Token di enrollment già utilizzato")
    if token.bind_ip and not _same_ip(client_ip, token.bind_ip):
        await reject("Token non utilizzabile da questo indirizzo")

    facts = body.facts if isinstance(body.facts, dict) else {}
    fields = enrollment_service.token_fields(token)
    instance = await enrollment_service.target_instance(session, facts, fields, token.reenroll_instance_id)
    result = await enrollment_service.issue_identity(
        session, instance, body.csr, facts, fields, client_ip, body.protocol)
    token.uses += 1
    token.last_used_at = datetime.utcnow()
    session.add(token)
    await login_rate_limiter.record_success(session, limit_key)
    await session.commit()
    logger.info("Instance %s (%s) enrolled from %s with token %s",
                instance.name, instance.id, client_ip, token.id)
    return result


def _same_ip(a: str, b: str) -> bool:
    from manager.netutil import ip_allowed
    return ip_allowed(a, b)


# --- Registration without a token (approved later) ---

class RegisterRequest(BaseModel):
    csr: str = Field(max_length=8192)
    protocol: int
    ca_pinned: bool = False
    facts: dict = Field(default_factory=dict)


@router.post("/register")
async def register(body: RegisterRequest, request: Request, session: AsyncSession = Depends(get_session)):
    from manager.enrollment.requests import create_request
    client_ip = get_client_ip(request)
    limit_key = f"register:{client_ip}"
    # Counted per attempt, reset by every accepted call: many instances
    # behind one NAT address keep working, a flood of bad requests does not
    login_rate_limiter.begin_attempt(limit_key)
    if body.protocol != protocol.PROTOCOL_VERSION:
        raise HTTPException(400, f"Versione di protocollo {body.protocol} non supportata")
    result = await create_request(session, body.csr, body.facts if isinstance(body.facts, dict) else {},
                                  body.protocol, client_ip, body.ca_pinned)
    await login_rate_limiter.record_success(session, limit_key)
    await session.commit()
    return result


@router.get("/register/{request_id}")
async def registration_status(request_id: str, request: Request, session: AsyncSession = Depends(get_session)):
    from manager.enrollment.requests import poll_request
    client_ip = get_client_ip(request)
    limit_key = f"register:{client_ip}"
    login_rate_limiter.begin_attempt(limit_key)
    result = await poll_request(session, request_id[:36], request.headers.get("x-request-secret", ""))
    if result is None:
        await login_rate_limiter.record_failure(session, limit_key)
        await session.commit()
        raise HTTPException(404, "Richiesta non trovata")
    await login_rate_limiter.record_success(session, limit_key)
    await session.commit()
    return result


class RenewRequest(BaseModel):
    csr: str = Field(max_length=8192)


@router.post("/renew")
async def renew(body: RenewRequest, agent=Depends(require_agent_or_suspended), session: AsyncSession = Depends(get_session)):
    instance, _ = agent
    try:
        cert_pem, fp, serial, nb, na = pki.sign_agent_csr(body.csr, instance.id)
    except pki.PKIError as e:
        raise HTTPException(400, str(e))
    # The previous certificate stays valid until it expires: the agent may
    # not have saved the new one yet
    session.add(AgentCertificate(instance_id=instance.id, fingerprint=fp, serial=serial,
                                 not_before=nb.replace(tzinfo=None), not_after=na.replace(tzinfo=None)))
    await session.commit()
    out = {"cert_pem": cert_pem.decode()}
    bundle = pki.ca_bundle()   # during a CA rotation only
    if bundle:
        out["ca_bundle"] = bundle
    return out


@router.post("/unenroll")
async def unenroll(agent=Depends(require_agent_or_suspended), session: AsyncSession = Depends(get_session)):
    instance, _ = agent
    instance = await session.get(Instance, instance.id)
    await revoke_instance(session, instance, by="instance", status="decommissioned")
    return {}


# --- Backups ---

def backup_path(instance_id: str, backup_id: str) -> str:
    from config import get_settings
    return os.path.join(get_settings().data_dir, "backups", instance_id, f"{backup_id}.bin")


@router.post("/backups")
async def upload_backup(request: Request, agent=Depends(require_agent),
                        session: AsyncSession = Depends(get_session)):
    instance, _ = agent
    expected = request.headers.get("x-content-sha256", "").lower()
    backup_id = str(uuid.uuid4())
    path = backup_path(instance.id, backup_id)
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + ".part"
    h = hashlib.sha256()
    size = 0
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_BACKUP_SIZE:
                    raise HTTPException(413, "Archivio troppo grande")
                h.update(chunk)
                await asyncio.to_thread(f.write, chunk)
        if not expected or h.hexdigest() != expected:
            raise HTTPException(400, "sha256 dell'archivio non corrispondente")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    cmd_id = request.headers.get("x-command-id", "")[:36] or None
    trigger, created_by = "manual", ""
    if cmd_id:
        cmd = await session.get(Command, cmd_id)
        if cmd is not None and cmd.instance_id == instance.id:
            created_by = cmd.operator
            trigger = "scheduled" if cmd.operator == "scheduler" else "manual"
    session.add(Backup(
        id=backup_id, instance_id=instance.id, size=size, sha256=h.hexdigest(),
        archive_name=request.headers.get("x-archive-name", "")[:200],
        madmin_version=instance.madmin_version, trigger=trigger, created_by=created_by,
        command_id=cmd_id,
    ))
    await session.commit()
    from manager.backups.service import apply_retention
    await apply_retention(session, instance.id)
    return {"backup_id": backup_id}


@router.get("/backups/{backup_id}")
async def download_backup(backup_id: str, agent=Depends(require_agent),
                          session: AsyncSession = Depends(get_session)):
    instance, _ = agent
    backup = await session.get(Backup, backup_id)
    # Only this instance's backups
    if backup is None or backup.instance_id != instance.id:
        raise HTTPException(404, "Backup non trovato")
    path = backup_path(instance.id, backup.id)
    if not os.path.exists(path):
        raise HTTPException(404, "File del backup mancante")
    return FileResponse(path, media_type="application/octet-stream",
                        headers={"X-Content-SHA256": backup.sha256})


# --- Releases (madmin.update) ---

@router.get("/releases/{release_id}")
async def download_release(release_id: str, agent=Depends(require_agent)):
    from manager.releases.service import ReleaseError, stored
    try:
        path = stored(release_id)
    except ReleaseError:
        path = None
    if path is None:
        raise HTTPException(404, "Release non trovata")
    return FileResponse(path, media_type="application/octet-stream")


# --- Control channel ---

# Abilities of this manager that are not commands (hello_ack.features)
FEATURES: list = []


def _capabilities(raw) -> dict:
    """hello.capabilities: {command: version}; malformed entries are dropped."""
    if not isinstance(raw, dict):
        return {}
    caps = {}
    for name, version in list(raw.items())[:200]:
        if isinstance(version, int) and not isinstance(version, bool) and version >= 1:
            caps[str(name)[:50]] = version
    return caps


async def _handle_hello(ws: WebSocket, instance_id: str, source_ip: str) -> AgentConnection:
    raw = await asyncio.wait_for(ws.receive_text(), _HELLO_TIMEOUT)
    msg = protocol.parse(raw)
    if msg["type"] != protocol.HELLO:
        raise protocol.ProtocolError("first frame must be hello")
    p = msg["payload"]
    if p.get("instance_id") != instance_id:
        raise protocol.ProtocolError("instance_id does not match the certificate")
    revision = protocol.negotiate_revision(p.get("revision_min"), p.get("revision_max"))
    if revision is None:
        raise protocol.ProtocolError(
            f"no common revision (agent {p.get('revision_min')!r}-{p.get('revision_max')!r}, "
            f"manager {protocol.PROTOCOL_REVISION_MIN}-{protocol.PROTOCOL_REVISION})")
    caps = _capabilities(p.get("capabilities"))
    features = p.get("features") if isinstance(p.get("features"), list) else []
    features = {str(f)[:50] for f in features[:200]}
    facts = p.get("facts") if isinstance(p.get("facts"), dict) else None
    async with async_session_maker() as session:
        from core.settings.router import get_system_settings
        settings = await get_system_settings(session)
        config = {
            "heartbeat_interval": settings.agent_heartbeat_interval,
            "facts_interval": settings.agent_facts_interval,
            "backoff_max": settings.agent_backoff_max,
        }
        instance = await session.get(Instance, instance_id)
        instance.capabilities_json = json.dumps(caps, sort_keys=True)
        instance.features_json = json.dumps(sorted(features))
        instance.protocol = protocol.PROTOCOL_VERSION
        instance.protocol_revision = revision
        state = p.get("state") if isinstance(p.get("state"), dict) else {}
        trusted = state.get("ca")
        if isinstance(trusted, list):
            instance.trusted_ca_json = json.dumps(sorted(str(f)[:64] for f in trusted[:10]))
        update = state.get("update")
        if isinstance(update, dict):
            instance.update_json = json.dumps(update)[:8000]
        instance.last_seen_at = datetime.utcnow()
        if facts is not None:
            apply_facts(instance, facts)
        await record_addresses(session, instance, source_ip, facts)
        session.add(instance)
        await session.commit()
    ack = {
        "instance_id": instance_id,
        "server_time": int(datetime.utcnow().timestamp()),
        "revision": revision,
        "features": FEATURES,
        "config": config,
        "manager_version": MANAGER_VERSION,
    }
    bundle = pki.ca_bundle()   # during a CA rotation only
    if bundle:
        ack["ca_bundle"] = bundle
    # An instance that reaches the manager after an update confirms it: the
    # updater's health gate waits for this before committing
    update = (p.get("state") or {}).get("update") if isinstance(p.get("state"), dict) else None
    if isinstance(update, dict) and update.get("result") == "verifying" and update.get("release_id"):
        ack["update_confirm"] = str(update["release_id"])[:80]
        logger.info("Instance %s: update to %s confirmed", instance_id, ack["update_confirm"])
    await ws.send_text(protocol.frame(protocol.HELLO_ACK, ack))
    state = p.get("state") if isinstance(p.get("state"), dict) else {}
    return AgentConnection(instance_id=instance_id, ws=ws, source_ip=source_ip,
                           capabilities=caps, features=features, revision=revision, hello_state=state)


async def _handle_heartbeat(conn: AgentConnection, payload: dict) -> None:
    async with async_session_maker() as session:
        instance = await session.get(Instance, conn.instance_id)
        if instance is None:
            return
        instance.last_seen_at = datetime.utcnow()
        stats = payload.get("stats")
        if isinstance(stats, dict):
            instance.stats_json = json.dumps(stats)[:4096]
        facts = payload.get("facts")
        if isinstance(facts, dict):
            apply_facts(instance, facts)
            await record_addresses(session, instance, None, facts)
        session.add(instance)
        await session.commit()


async def _handle_event(conn: AgentConnection, payload: dict) -> None:
    name = payload.get("name")
    if name == protocol.EVENT_SUPPORT_EXPIRED:
        from manager.support.service import on_instance_expired
        await on_instance_expired(conn.instance_id, payload.get("data") or {})
    elif name == protocol.EVENT_UPDATE_STATUS:
        data = payload.get("data")
        if isinstance(data, dict):
            async with async_session_maker() as session:
                instance = await session.get(Instance, conn.instance_id)
                instance.update_json = json.dumps(data)[:8000]
                session.add(instance)
                await session.commit()
            logger.info("Instance %s: update %s %s", conn.instance_id, data.get("release_id"), data.get("result"))
    elif name == protocol.EVENT_CA_UPDATED:
        trusted = (payload.get("data") or {}).get("ca")
        if isinstance(trusted, list):
            async with async_session_maker() as session:
                instance = await session.get(Instance, conn.instance_id)
                instance.trusted_ca_json = json.dumps(sorted(str(f)[:64] for f in trusted[:10]))
                session.add(instance)
                await session.commit()
    else:
        # A newer agent may send events this manager does not know
        logger.info("Instance %s: ignored event %r", conn.instance_id, str(name)[:50])


async def _writer(conn: AgentConnection) -> None:
    while True:
        await conn.ws.send_text(await conn.outbox.get())


@router.websocket("/ws")
async def control_channel(ws: WebSocket):
    source_ip = get_client_ip(ws)
    async with async_session_maker() as session:
        found = await authenticate(session, ws, allow_suspended=True)
    await ws.accept()
    if found is None:
        # Accepted then closed, so the agent sees the code and stops retrying
        await ws.close(code=protocol.CLOSE_REVOKED, reason="revoked")
        return
    instance, _ = found
    if instance.status == "suspended":
        # The agent keeps its identity and access and comes back in 15 minutes
        await ws.close(code=protocol.CLOSE_SUSPENDED, reason="suspended")
        return
    try:
        conn = await _handle_hello(ws, instance.id, source_ip)
    except (protocol.ProtocolError, asyncio.TimeoutError, ValueError) as e:
        logger.warning("Instance %s: bad hello (%s)", instance.id, e)
        await ws.close(code=protocol.CLOSE_PROTOCOL, reason=str(e)[:100])
        return
    except WebSocketDisconnect:
        return

    await registry.register(conn)
    writer = asyncio.create_task(_writer(conn))
    logger.info("Instance %s (%s) connected from %s", instance.name, instance.id, source_ip)
    try:
        await dispatcher.resend_pending(instance.id)
        try:
            await reconcile(instance.id, conn.hello_state)
        except Exception:
            logger.exception("Instance %s: state not reconciled", instance.id)
        while True:
            raw = await ws.receive_text()
            try:
                msg = protocol.parse(raw)
            except protocol.ProtocolError as e:
                logger.warning("Instance %s: bad frame (%s)", instance.id, e)
                continue  # one bad frame does not drop the connection
            try:
                if msg["type"] == protocol.HEARTBEAT:
                    await _handle_heartbeat(conn, msg["payload"])
                elif msg["type"] == protocol.CMD_RESULT:
                    await dispatcher.handle_result(instance.id, msg["id"], msg["payload"])
                elif msg["type"] == protocol.CMD_PROGRESS:
                    await dispatcher.handle_progress(instance.id, msg["id"], msg["payload"])
                elif msg["type"] == protocol.EVENT:
                    await _handle_event(conn, msg["payload"])
                else:
                    logger.debug("Instance %s: ignored frame %s", instance.id, msg["type"])
            except Exception:
                logger.exception("Instance %s: error handling %s", instance.id, msg["type"])
    except WebSocketDisconnect:
        pass
    finally:
        writer.cancel()
        registry.unregister(conn)
        logger.info("Instance %s disconnected", instance.id)


@router.websocket("/tunnel/{conn_id}")
async def tunnel_channel(ws: WebSocket, conn_id: str):
    from manager.support.tunnels import attach_agent
    async with async_session_maker() as session:
        found = await authenticate(session, ws)
    if found is None:
        await ws.close(code=protocol.CLOSE_REVOKED)
        return
    await attach_agent(ws, conn_id, found[0].id)
