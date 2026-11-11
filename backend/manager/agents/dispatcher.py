"""
Commands to instances.

Persistent commands (Command table) survive disconnections and manager restarts:
queued while the instance is offline, sent when it connects, re-sent after
every reconnect until a result arrives (the agent deduplicates by id and
answers a repeat with the cached result), expired when not started before
expires_at. A long command reports cmd_progress when it starts (running):
from then on it has its execution timeout, and is failed with "timeout" only
when that passes (plus a margin) without a result.

Ephemeral commands (tunnel.open) are not stored: they only make sense now.
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import and_, or_, update
from sqlmodel import select

from core.database import async_session_maker

from manager.models import Command
from . import protocol
from .registry import registry

logger = logging.getLogger(__name__)

DEFAULT_TTL = timedelta(minutes=10)
EXPIRE_INTERVAL = 60
# A running command without its own timeout: the agent's limits are lower
RUNNING_LIMIT = 3600
RUNNING_MARGIN = 300


def _frame(cmd_id: str, name: str, args: dict, operator: str, expires_at: datetime,
           timeout: Optional[int] = None) -> str:
    payload = {
        "name": name,
        "args": args,
        "operator": operator,
        "exp": int(expires_at.replace(tzinfo=timezone.utc).timestamp()),  # naive UTC in the DB
    }
    if timeout:
        payload["timeout"] = timeout
    return protocol.frame(protocol.CMD, payload, cmd_id)


# HTTP status for a failed command, by protocol error code
_HTTP_STATUS = {
    protocol.ERR_UNSUPPORTED: 409,
    protocol.ERR_PRECONDITION: 409,
    protocol.ERR_BUSY: 409,
    protocol.ERR_EXPIRED: 504,
    protocol.ERR_TIMEOUT: 504,
}


def check_capability(instance_id: str, name: str, min_version: int = 1) -> None:
    """409 when the connected agent does not implement `name`, or implements
    an older version of it (an older MADMIN): better than a command that
    waits until it expires."""
    conn = registry.get(instance_id)
    if conn is not None and not conn.supports(name, min_version):
        raise HTTPException(409, f"L'istanza non supporta il comando {name} (aggiornare MADMIN)")


async def _mark_sent(cmd_ids: list) -> None:
    if not cmd_ids:
        return
    async with async_session_maker() as session:
        await session.execute(
            update(Command).where(Command.id.in_(cmd_ids), Command.status == "queued")
            .values(status="sent", sent_at=datetime.utcnow())
        )
        await session.commit()


def _send(cmd: Command) -> bool:
    conn = registry.get(cmd.instance_id)
    if conn is None or cmd.name not in conn.capabilities:
        return False
    return conn.send(_frame(cmd.id, cmd.name, json.loads(cmd.args_json), cmd.operator, cmd.expires_at,
                            cmd.timeout))


async def queue_command(session, instance_id: str, name: str, args: Optional[dict] = None,
                        operator: str = "", ttl: timedelta = DEFAULT_TTL,
                        timeout: Optional[int] = None) -> Command:
    """ttl: how long the command may wait to be started; timeout: how long
    its execution may take (None = the agent's own limit)."""
    cmd = Command(
        instance_id=instance_id, name=name, args_json=json.dumps(args or {}),
        operator=operator[:100], expires_at=datetime.utcnow() + ttl, timeout=timeout,
    )
    session.add(cmd)
    await session.commit()
    if _send(cmd):
        await _mark_sent([cmd.id])
        cmd.status = "sent"
    return cmd


async def run_command(session, instance_id: str, name: str, args: Optional[dict] = None,
                      operator: str = "", timeout: float = 30) -> dict:
    """Send a persistent command and wait for its result (the instance must
    be online). Returns the result data; raises HTTPException on failure."""
    if not registry.is_online(instance_id):
        raise HTTPException(409, "Istanza non connessa")
    check_capability(instance_id, name)
    cmd = Command(
        instance_id=instance_id, name=name, args_json=json.dumps(args or {}),
        operator=operator[:100], expires_at=datetime.utcnow() + timedelta(seconds=timeout + 30),
        timeout=int(timeout),
    )
    session.add(cmd)
    await session.commit()
    fut = registry.waiter(cmd.id)
    if not _send(cmd):
        registry.drop_waiter(cmd.id)
        raise HTTPException(409, "Istanza non connessa")
    await _mark_sent([cmd.id])
    try:
        result = await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        registry.drop_waiter(cmd.id)
        raise HTTPException(504, "L'istanza non ha risposto in tempo")
    if not result.get("ok"):
        code, message = protocol.error_parts(result)
        raise HTTPException(_HTTP_STATUS.get(code, 502), f"Comando fallito sull'istanza: {message or code}")
    return result.get("data") or {}


async def send_ephemeral(instance_id: str, name: str, args: dict, operator: str = "manager",
                         ttl: float = 20) -> asyncio.Future:
    """Not stored. The future resolves with the cmd_result payload."""
    import uuid
    conn = registry.get(instance_id)
    if conn is None or name not in conn.capabilities:
        raise ConnectionError("istanza non connessa o comando non supportato")
    cmd_id = str(uuid.uuid4())
    fut = registry.waiter(cmd_id)
    if not conn.send(_frame(cmd_id, name, args, operator, datetime.utcnow() + timedelta(seconds=ttl))):
        registry.drop_waiter(cmd_id)
        raise ConnectionError("coda dell'istanza piena")
    return fut


async def resend_pending(instance_id: str) -> None:
    """After a (re)connect: everything not answered yet, oldest first. A
    running command is re-sent past its exp: the agent answers with its
    progress or its cached result, never starts it again."""
    async with async_session_maker() as session:
        rows = (await session.execute(
            select(Command).where(
                Command.instance_id == instance_id,
                or_(Command.status == "running",
                    and_(Command.status.in_(("queued", "sent")), Command.expires_at > datetime.utcnow())),
            ).order_by(Command.created_at)
        )).scalars().all()
    sent = [cmd.id for cmd in rows if _send(cmd)]
    await _mark_sent(sent)


async def handle_progress(instance_id: str, cmd_id: str, payload: dict) -> None:
    """cmd_progress: the command started (running) and what it is doing."""
    async with async_session_maker() as session:
        cmd = (await session.execute(
            select(Command).where(Command.id == cmd_id, Command.instance_id == instance_id)
        )).scalar_one_or_none()
        if cmd is None or cmd.status not in ("queued", "sent", "running"):
            return  # ephemeral, not this instance's, or already finished
        cmd.status = "running"
        cmd.started_at = cmd.started_at or datetime.utcnow()
        keep = {k: payload[k] for k in ("state", "step", "percent", "message") if k in payload}
        cmd.progress_json = json.dumps(keep)[:1000]
        session.add(cmd)
        await session.commit()


async def handle_result(instance_id: str, cmd_id: str, payload: dict) -> None:
    registry.resolve(cmd_id, payload)
    ok = bool(payload.get("ok"))
    async with async_session_maker() as session:
        cmd = (await session.execute(
            select(Command).where(Command.id == cmd_id, Command.instance_id == instance_id)
        )).scalar_one_or_none()
        if cmd is None:
            return  # ephemeral, or not this instance's
        # A late result still closes the command, even after it expired
        cmd.status = "done" if ok else "failed"
        cmd.finished_at = datetime.utcnow()
        if ok:
            cmd.result_json = json.dumps(_redact(cmd.name, payload.get("data") or {}))[:100_000]
        else:
            code, message = protocol.error_parts(payload)
            cmd.error_code = code
            cmd.error = (message or code)[:1000]
        session.add(cmd)
        await session.commit()


def _redact(name: str, data: dict) -> dict:
    """Credentials in results are returned to the operator who asked, never stored."""
    if name == protocol.CMD_SUPPORT_UI_OPEN and "ticket" in data:
        data = {**data, "ticket": "***"}
    return data


async def expire_task() -> None:
    while True:
        await asyncio.sleep(EXPIRE_INTERVAL)
        try:
            now = datetime.utcnow()
            async with async_session_maker() as session:
                await session.execute(
                    update(Command).where(
                        Command.status.in_(("queued", "sent")),
                        Command.expires_at <= now,
                    ).values(status="expired", finished_at=now)
                )
                running = (await session.execute(
                    select(Command).where(Command.status == "running")
                )).scalars().all()
                for cmd in running:
                    limit = (cmd.timeout or RUNNING_LIMIT) + RUNNING_MARGIN
                    if cmd.started_at and cmd.started_at + timedelta(seconds=limit) <= now:
                        cmd.status = "failed"
                        cmd.finished_at = now
                        cmd.error_code = protocol.ERR_TIMEOUT
                        cmd.error = f"nessun risultato entro {limit // 60} minuti dall'avvio"
                        session.add(cmd)
                await session.commit()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Command expiry error")
