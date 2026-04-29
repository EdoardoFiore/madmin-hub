"""
Telemetry ingest: persist heartbeat frames into InstanceTelemetry rows.
"""
import json
import logging
import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from .models import InstanceTelemetry

logger = logging.getLogger(__name__)


async def ingest_heartbeat(
    session: AsyncSession,
    instance_id: uuid.UUID,
    payload: dict,
) -> InstanceTelemetry:
    """
    Parse a heartbeat frame payload (from WS) and persist telemetry row.
    Payload format mirrors madmin /api/system/stats response.
    """
    cpu = payload.get("cpu", {})
    mem = payload.get("memory", {})
    disk = payload.get("disk", {})
    net = payload.get("network", {})
    services = payload.get("services", {})
    modules = payload.get("modules", [])

    row = InstanceTelemetry(
        instance_id=instance_id,
        cpu_percent=cpu.get("percent", 0.0),
        ram_percent=mem.get("percent", 0.0),
        ram_total=mem.get("total", 0),
        ram_used=mem.get("used", 0),
        disk_percent=disk.get("percent", 0.0),
        disk_total=disk.get("total", 0),
        disk_used=disk.get("used", 0),
        net_in_bps=net.get("in_bps", 0),
        net_out_bps=net.get("out_bps", 0),
        services_status=json.dumps(services),
        modules_status=json.dumps(modules),
        raw=json.dumps(payload),
    )
    session.add(row)
    await session.flush()
    return row
