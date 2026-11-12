"""
Support sessions: temporary superuser UI and root SSH on an instance.

UI:  support.ui.open creates a hidden superuser on the instance (expiring
     with the session) and returns a one-time ticket; the operator opens
     https://<support_host>:<port>/login.html#manager-ticket=<ticket>. The ticket
     is handed to the operator who asked and never stored here.
SSH: support.ssh.grant lets the instance accept the support principal for
     root until the expiry; the manager signs one of the operator's approved
     keys (manager.keys) for that principal, valid from 127.0.0.1 only (the
     tunnel end) and until then. The key id of the certificate names the
     operator and the key, so the sshd log of the instance says who it was.

Opening a session asks for a fresh TOTP code (router), and a user has at most
MAX_OPEN_PER_USER sessions open at once, UI and SSH together.

Each session has its own port, open only to the operator's IP (the address
the request came from, unless given). Sessions expire by themselves on both
sides; closing one early tells the instance too.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlsplit

from fastapi import HTTPException
from sqlmodel import select

from config import get_settings
from core.database import async_session_maker
from core.settings.router import get_system_settings

from manager import pki
from manager.agents import protocol
from manager.agents.dispatcher import queue_command, run_command
from manager.models import Instance, SupportSession, UserSshKey
from . import tunnels

logger = logging.getLogger("madmin_manager.support")

EXPIRY_INTERVAL = 30
MAX_OPEN_PER_USER = 4


async def check_limit(session, operator: str, replacing_on: Optional[str] = None) -> None:
    """At most MAX_OPEN_PER_USER open sessions per user. An SSH session that
    replaces the caller's own one on the same instance does not count twice."""
    rows = (await session.execute(
        select(SupportSession, Instance.name).join(Instance, Instance.id == SupportSession.instance_id)
        .where(SupportSession.operator == operator, SupportSession.status == "open")
        .order_by(SupportSession.created_at)
    )).all()
    counted = [(r, n) for r, n in rows
               if not (replacing_on and r.kind == "ssh" and r.instance_id == replacing_on)]
    if len(counted) >= MAX_OPEN_PER_USER:
        listed = ", ".join(f"{r.kind.upper()} su {n} (scade {r.expires_at:%d/%m %H:%M} UTC)" for r, n in counted)
        raise HTTPException(409, f"Hai già {len(counted)} sessioni di supporto aperte (massimo "
                                 f"{MAX_OPEN_PER_USER}): chiuderne una. Aperte: {listed}")


async def approved_key(session, user, key_id: str) -> UserSshKey:
    key = await session.get(UserSshKey, key_id)
    if key is None or key.user_id != user.id:
        raise HTTPException(404, "Chiave SSH non trovata tra le tue")
    if key.status != "approved":
        raise HTTPException(409, "Chiave SSH non ancora approvata da un altro superuser")
    return key


def stop_listener(session_id: str) -> None:
    tunnels.stop_listener(session_id)


async def _support_host(session) -> str:
    s = await get_system_settings(session)
    return s.support_host or urlsplit(s.agent_url).hostname or ""


async def _allocate_port(session) -> int:
    s = await get_system_settings(session)
    used = tunnels.ports_in_use()
    rows = (await session.execute(select(SupportSession.port).where(SupportSession.status == "open"))).all()
    used.update(r[0] for r in rows)
    for port in range(s.support_port_min, s.support_port_max + 1):
        if port not in used:
            return port
    raise HTTPException(503, "Nessuna porta di supporto libera: chiudere una sessione")


async def _start(row: SupportSession) -> None:
    listener = tunnels.Listener(
        session_id=row.id, instance_id=row.instance_id, target=row.kind,
        port=row.port, allowed_ip=row.allowed_ip, operator=row.operator,
    )
    try:
        await tunnels.start_listener(listener, get_settings().support_bind)
    except OSError as e:
        raise HTTPException(503, f"Porta {row.port} non disponibile: {e.strerror}")


async def open_ui(session, instance: Instance, operator: str, minutes: int,
                  allowed_ip: str, reason: str) -> dict:
    port = await _allocate_port(session)
    data = await run_command(session, instance.id, protocol.CMD_SUPPORT_UI_OPEN,
                             {"minutes": minutes}, operator=operator)
    row = SupportSession(
        instance_id=instance.id, kind="ui", operator=operator, reason=reason, port=port,
        allowed_ip=allowed_ip, username=str(data.get("username", ""))[:60],
        expires_at=datetime.utcnow() + timedelta(minutes=minutes),
    )
    session.add(row)
    await session.commit()
    try:
        await _start(row)
    except HTTPException:
        await close(session, row, by=operator)
        raise
    host = await _support_host(session)
    return {"session": row, "url": _ui_url(host, port, data), "ticket_ttl": data.get("ticket_ttl")}


def _ui_url(host: str, port: int, data: dict) -> str:
    return f"https://{host}:{port}{data.get('login_path', '/login.html')}#manager-ticket={data.get('ticket', '')}"


async def new_ticket(session, row: SupportSession, operator: str) -> dict:
    data = await run_command(session, row.instance_id, protocol.CMD_SUPPORT_UI_OPEN,
                             {"username": row.username,
                              "minutes": max(5, int((row.expires_at - datetime.utcnow()).total_seconds() // 60))},
                             operator=operator)
    host = await _support_host(session)
    return {"url": _ui_url(host, row.port, data), "ticket_ttl": data.get("ticket_ttl")}


async def open_ssh(session, instance: Instance, operator: str, minutes: int,
                   allowed_ip: str, reason: str, key: UserSshKey, replace: bool = False) -> dict:
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    public_key = key.public_key
    # Validated before anything changes on the instance
    try:
        pki.load_ssh_public_key(public_key)
    except pki.PKIError as e:
        raise HTTPException(400, str(e))
    # One SSH grant per instance (same principal for every session): two open
    # sessions would share it, and closing either would revoke both
    previous = (await session.execute(select(SupportSession).where(
        SupportSession.instance_id == instance.id, SupportSession.kind == "ssh",
        SupportSession.status == "open",
    ))).scalars().all()
    if previous and not replace:
        p = previous[0]
        raise HTTPException(409, f"Sessione SSH già attiva su questa istanza (operatore {p.operator}): "
                                 "confermare la sostituzione per chiuderla")
    port = await _allocate_port(session)
    data = await run_command(session, instance.id, protocol.CMD_SUPPORT_SSH_GRANT,
                             {"minutes": minutes}, operator=operator)
    # Only once the new grant is in place (a failed grant leaves the open
    # session alone). No support.ssh.revoke for the old one: it would remove
    # the grant just written. The grant replaced the principal line with the
    # new expiry; closing the old listener cuts its connections, the only way in.
    for p in previous:
        await close(session, p, by=operator, status="replaced")
    principal = str(data.get("principal", ""))
    cert = pki.sign_ssh_user_cert(public_key, principal, f"{operator} {key.fingerprint} {instance.id}", expires_at)
    row = SupportSession(
        instance_id=instance.id, kind="ssh", operator=operator, reason=reason, port=port,
        allowed_ip=allowed_ip, principal=principal[:100], key_fingerprint=key.fingerprint,
        expires_at=expires_at.replace(tzinfo=None),
    )
    key.last_used_at = datetime.utcnow()
    session.add(key)
    session.add(row)
    await session.commit()
    try:
        await _start(row)
    except HTTPException:
        await close(session, row, by=operator)
        raise
    host = await _support_host(session)
    user = data.get("user", "root")
    return {
        "session": row,
        "certificate": cert,
        # Absolute (~ is expanded by ssh): a relative CertificateFile is looked
        # up in the current directory and, when missing, silently skipped
        "command": (f"ssh -p {port} -o CertificateFile=~/.ssh/madmin-{instance.id[:8]}-cert.pub "
                    f"-o HostKeyAlias=madmin-{instance.id} {user}@{host}"),
    }


async def close(session, row: SupportSession, by: str, status: str = "closed") -> None:
    stop_listener(row.id)
    if row.status != "open":
        return
    row.status = status
    row.closed_at = datetime.utcnow()
    row.closed_by = by[:100]
    session.add(row)
    await session.commit()
    if status == "closed":
        # Ends it on the instance now instead of at the expiry (queued if offline)
        if row.kind == "ui":
            await queue_command(session, row.instance_id, protocol.CMD_SUPPORT_UI_CLOSE,
                                {"username": row.username}, operator=by, ttl=timedelta(hours=1))
        else:
            await queue_command(session, row.instance_id, protocol.CMD_SUPPORT_SSH_REVOKE,
                                {}, operator=by, ttl=timedelta(hours=1))


async def on_instance_expired(instance_id: str, data: dict) -> None:
    """The instance reports accesses it removed at their expiry."""
    async with async_session_maker() as session:
        query = select(SupportSession).where(SupportSession.instance_id == instance_id,
                                             SupportSession.status == "open")
        for row in (await session.execute(query)).scalars().all():
            if (row.kind == "ui" and row.username in (data.get("ui") or [])) or \
                    (row.kind == "ssh" and data.get("ssh")):
                await close(session, row, by="instance", status="expired")


async def restore_listeners() -> None:
    """At startup: listeners of the sessions still open."""
    async with async_session_maker() as session:
        rows = (await session.execute(select(SupportSession).where(SupportSession.status == "open"))).scalars().all()
        for row in rows:
            if row.expires_at <= datetime.utcnow():
                await close(session, row, by="manager", status="expired")
                continue
            try:
                await _start(row)
            except HTTPException as e:
                logger.error("Support session %s not restored: %s", row.id, e.detail)


async def expiry_task() -> None:
    while True:
        await asyncio.sleep(EXPIRY_INTERVAL)
        try:
            async with async_session_maker() as session:
                rows = (await session.execute(select(SupportSession).where(
                    SupportSession.status == "open", SupportSession.expires_at <= datetime.utcnow(),
                ))).scalars().all()
                for row in rows:
                    await close(session, row, by="manager", status="expired")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Support expiry error")
