"""
Command dispatcher: send command to agent via WS and await result.

If agent is offline, command queued in InstanceCommand table and
executed on reconnect (agent picks pending queue on connect).
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings
from hub.telemetry.models import InstanceCommand

from .manager import ws_manager
from .protocol import FRAME_COMMAND, CommandFrame

logger = logging.getLogger(__name__)

# correlation_id → asyncio.Future (waiting for result frame)
_pending: dict[str, asyncio.Future] = {}


def register_pending(correlation_id: str, future: asyncio.Future) -> None:
    _pending[correlation_id] = future


def resolve_pending(correlation_id: str, result: dict) -> bool:
    fut = _pending.pop(correlation_id, None)
    if fut and not fut.done():
        fut.set_result(result)
        return True
    return False


def reject_pending(correlation_id: str, error: str) -> bool:
    fut = _pending.pop(correlation_id, None)
    if fut and not fut.done():
        fut.set_exception(Exception(error))
        return True
    return False


async def dispatch(
    session: AsyncSession,
    *,
    instance_id: uuid.UUID,
    action: str,
    params: dict = None,
    requested_by: Optional[str] = None,
    timeout: Optional[int] = None,
) -> dict:
    """
    Send command to agent. Waits for result up to timeout seconds.
    If agent offline, queues command (returns immediately with status=queued).
    """
    settings = get_settings()
    timeout = timeout or settings.command_timeout_seconds
    params = params or {}

    cmd = CommandFrame(action=action, params=params, timeout_seconds=timeout)
    expires_at = datetime.utcnow() + timedelta(seconds=timeout + 30)

    # Persist command for audit + offline queueing
    record = InstanceCommand(
        instance_id=instance_id,
        correlation_id=cmd.correlation_id,
        action=action,
        payload=json.dumps(params),
        status="queued",
        expires_at=expires_at,
        requested_by=requested_by,
    )
    session.add(record)
    await session.flush()

    if not ws_manager.is_connected(instance_id):
        # Offline: command stays queued, picked up on reconnect
        await session.commit()
        return {
            "status": "queued",
            "correlation_id": cmd.correlation_id,
            "detail": "Istanza offline. Comando in coda — eseguito alla riconnessione.",
        }

    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    register_pending(cmd.correlation_id, fut)

    frame = {
        "type": FRAME_COMMAND,
        "payload": {
            "correlation_id": cmd.correlation_id,
            "action": cmd.action,
            "params": cmd.params,
            "timeout_seconds": cmd.timeout_seconds,
        },
    }

    sent = await ws_manager.send(instance_id, frame)
    if not sent:
        _pending.pop(cmd.correlation_id, None)
        record.status = "failed"
        record.error = "WS send failed"
        await session.commit()
        return {"status": "failed", "error": "Impossibile inviare il comando (WS disconnesso)"}

    record.status = "sent"
    record.sent_at = datetime.utcnow()
    await session.commit()

    try:
        result = await asyncio.wait_for(fut, timeout=float(timeout))
        record.status = "done" if result.get("success") else "failed"
        record.result = json.dumps(result.get("result") or {})
        record.error = result.get("error")
        record.finished_at = datetime.utcnow()
        await session.commit()
        return result
    except asyncio.TimeoutError:
        _pending.pop(cmd.correlation_id, None)
        record.status = "timeout"
        record.error = f"Timeout dopo {timeout}s"
        record.finished_at = datetime.utcnow()
        await session.commit()
        return {"status": "timeout", "error": f"Nessuna risposta dall'agente in {timeout}s"}
    except Exception as e:
        record.status = "failed"
        record.error = str(e)
        record.finished_at = datetime.utcnow()
        await session.commit()
        return {"status": "failed", "error": str(e)}


async def flush_pending_commands(session: AsyncSession, instance_id: uuid.UUID) -> int:
    """
    On WS connect: send queued commands to newly-connected agent.
    Returns count dispatched.
    """
    now = datetime.utcnow()
    result = await session.execute(
        select(InstanceCommand).where(
            InstanceCommand.instance_id == instance_id,
            InstanceCommand.status == "queued",
            InstanceCommand.expires_at > now,
        ).order_by(InstanceCommand.created_at.asc())
    )
    pending = result.scalars().all()
    dispatched = 0
    for cmd in pending:
        params = json.loads(cmd.payload or "{}")
        frame = {
            "type": FRAME_COMMAND,
            "payload": {
                "correlation_id": cmd.correlation_id,
                "action": cmd.action,
                "params": params,
                "timeout_seconds": 30,
            },
        }
        if await ws_manager.send(instance_id, frame):
            cmd.status = "sent"
            cmd.sent_at = datetime.utcnow()
            session.add(cmd)
            dispatched += 1
    if dispatched:
        await session.commit()
    return dispatched
