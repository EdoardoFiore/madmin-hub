"""
WebSocket endpoint handler.

Auth: agent token in Authorization header or `token` query param (WS clients
can't send custom headers in all environments).
"""
import json
import logging
from typing import Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from core.database import async_session_maker
from hub.instances.enrollment import verify_agent_token
from hub.instances.models import ManagedInstance
from hub.instances.service import mark_ws_connected, mark_ws_disconnected, update_last_seen
from hub.telemetry.ingest import ingest_heartbeat, ingest_telemetry_batch

from . import dispatcher as disp
from .manager import ws_manager
from .protocol import (
    FRAME_COMMAND_RESULT,
    FRAME_EVENT,
    FRAME_HEARTBEAT,
    FRAME_PING,
    FRAME_PONG,
)

FRAME_TELEMETRY_BATCH = "telemetry_batch"

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Agents WS"])


async def _authenticate_agent(token: str) -> Optional[ManagedInstance]:
    """Validate agent token, return ManagedInstance or None."""
    async with async_session_maker() as session:
        result = await session.execute(
            select(ManagedInstance).where(
                ManagedInstance.enrollment_status == "active"
            )
        )
        instances = result.scalars().all()
        for inst in instances:
            if verify_agent_token(token, inst.agent_token_hash):
                return inst
    return None


@router.websocket("/api/agents/ws")
async def ws_endpoint(
    websocket: WebSocket,
    token: Optional[str] = Query(default=None),
):
    # --- Auth ---
    raw_token = token
    if not raw_token:
        auth_header = websocket.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            raw_token = auth_header[7:]

    if not raw_token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    instance = await _authenticate_agent(raw_token)
    if not instance:
        logger.warning("WS auth failed — unknown or invalid agent token")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    instance_id = instance.id

    # Reject if already connected (double-connect race)
    if ws_manager.is_connected(instance_id):
        logger.warning(f"WS duplicate connection from {instance_id}, closing new one")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    ws_manager.register(instance_id, websocket)

    client_ip = websocket.client.host if websocket.client else None
    async with async_session_maker() as session:
        result = await session.execute(
            select(ManagedInstance).where(ManagedInstance.id == instance_id)
        )
        inst = result.scalar_one_or_none()
        if inst:
            await mark_ws_connected(session, inst, ip=client_ip)
            # Flush any queued commands
            flushed = await disp.flush_pending_commands(session, instance_id)
            if flushed:
                logger.info(f"Flushed {flushed} queued commands to {instance_id}")

    logger.info(f"Agent connected: {instance_id} ({instance.name})")

    try:
        while True:
            data = await websocket.receive_json()
            frame_type = data.get("type")
            payload = data.get("payload", {})

            if frame_type == FRAME_HEARTBEAT:
                async with async_session_maker() as session:
                    result = await session.execute(
                        select(ManagedInstance).where(ManagedInstance.id == instance_id)
                    )
                    inst = result.scalar_one_or_none()
                    if inst:
                        await ingest_heartbeat(session, instance_id, payload)
                        await update_last_seen(session, inst)

            elif frame_type == FRAME_TELEMETRY_BATCH:
                async with async_session_maker() as session:
                    result = await session.execute(
                        select(ManagedInstance).where(ManagedInstance.id == instance_id)
                    )
                    inst = result.scalar_one_or_none()
                    if inst:
                        await ingest_telemetry_batch(session, instance_id, payload)
                        # Update instance version/os_info/ip if provided
                        if payload.get("version"):
                            inst.version = payload["version"]
                        if payload.get("os_info"):
                            import json as _json
                            inst.os_info = _json.dumps(payload["os_info"])
                        if payload.get("public_ip"):
                            inst.ip_address = payload["public_ip"]
                        await update_last_seen(session, inst)

            elif frame_type == FRAME_COMMAND_RESULT:
                correlation_id = payload.get("correlation_id")
                if correlation_id:
                    result_data = {
                        "success": payload.get("success", False),
                        "result": payload.get("result"),
                        "error": payload.get("error"),
                    }
                    if not disp.resolve_pending(correlation_id, result_data):
                        # Arrived after timeout — update DB record anyway
                        async with async_session_maker() as session:
                            from sqlalchemy import select as sa_select
                            from hub.telemetry.models import InstanceCommand
                            res = await session.execute(
                                sa_select(InstanceCommand).where(
                                    InstanceCommand.correlation_id == correlation_id
                                )
                            )
                            cmd = res.scalar_one_or_none()
                            if cmd and cmd.status == "timeout":
                                cmd.status = "done" if result_data["success"] else "failed"
                                cmd.result = json.dumps(result_data.get("result") or {})
                                cmd.error = result_data.get("error")
                                session.add(cmd)
                                await session.commit()

            elif frame_type == FRAME_EVENT:
                event_type = payload.get("event_type", "unknown")
                severity = payload.get("severity", "info")
                message = payload.get("message", "")
                logger.info(f"Agent event [{severity}] {instance_id}: {event_type} — {message}")
                # M2: feed into alert engine here

            elif frame_type == FRAME_PONG:
                pass  # keep-alive ack

            else:
                logger.debug(f"Unknown frame type from {instance_id}: {frame_type}")

    except WebSocketDisconnect:
        logger.info(f"Agent disconnected: {instance_id} ({instance.name})")
    except Exception as e:
        logger.error(f"WS error for {instance_id}: {e}", exc_info=True)
    finally:
        ws_manager.unregister(instance_id)
        async with async_session_maker() as session:
            result = await session.execute(
                select(ManagedInstance).where(ManagedInstance.id == instance_id)
            )
            inst = result.scalar_one_or_none()
            if inst:
                await mark_ws_disconnected(session, inst)

