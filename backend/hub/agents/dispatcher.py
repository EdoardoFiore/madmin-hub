"""
Commands to instances.

Persistent commands (Command table) survive disconnections and hub restarts:
queued while the instance is offline, sent when it connects, re-sent after
every reconnect until a result arrives (the agent deduplicates by id and
answers a repeat with the cached result), expired when not answered in time.

Ephemeral commands (tunnel.open) are not stored: they only make sense now.
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import update
from sqlmodel import select

from core.database import async_session_maker

from hub.models import Command
from . import protocol
from .registry import registry

logger = logging.getLogger(__name__)

DEFAULT_TTL = timedelta(minutes=10)
EXPIRE_INTERVAL = 60


def _frame(cmd_id: str, name: str, args: dict, operator: str, expires_at: datetime) -> str:
    return protocol.frame(protocol.CMD, {
        "name": name,
        "args": args,
        "operator": operator,
        "exp": int(expires_at.replace(tzinfo=timezone.utc).timestamp()),  # naive UTC in the DB
    }, cmd_id)


def check_capability(instance_id: str, name: str) -> None:
    """409 when the connected agent does not implement `name` (an older or
    newer MADMIN): better than a command that waits until it expires."""
    conn = registry.get(instance_id)
    if conn is not None and name not in conn.capabilities:
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
    return conn.send(_frame(cmd.id, cmd.name, json.loads(cmd.args_json), cmd.operator, cmd.expires_at))


async def queue_command(session, instance_id: str, name: str, args: Optional[dict] = None,
                        operator: str = "", ttl: timedelta = DEFAULT_TTL) -> Command:
    cmd = Command(
        instance_id=instance_id, name=name, args_json=json.dumps(args or {}),
        operator=operator[:100], expires_at=datetime.utcnow() + ttl,
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
        raise HTTPException(502, f"Comando fallito sull'istanza: {result.get('error') or 'errore'}")
    return result.get("data") or {}


async def send_ephemeral(instance_id: str, name: str, args: dict, operator: str = "hub",
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
    """After a (re)connect: everything not answered yet, oldest first."""
    async with async_session_maker() as session:
        rows = (await session.execute(
            select(Command).where(
                Command.instance_id == instance_id,
                Command.status.in_(("queued", "sent")),
                Command.expires_at > datetime.utcnow(),
            ).order_by(Command.created_at)
        )).scalars().all()
    sent = [cmd.id for cmd in rows if _send(cmd)]
    await _mark_sent(sent)


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
            cmd.error = str(payload.get("error") or "errore")[:1000]
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
            async with async_session_maker() as session:
                await session.execute(
                    update(Command).where(
                        Command.status.in_(("queued", "sent")),
                        Command.expires_at <= datetime.utcnow(),
                    ).values(status="expired", finished_at=datetime.utcnow())
                )
                await session.commit()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Command expiry error")
