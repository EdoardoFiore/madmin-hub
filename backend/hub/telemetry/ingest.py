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
    # Agent sends flat keys: cpu_percent, ram_percent, ram_total, disk_percent, disk_total,
    # net_in_bps, net_out_bps, services_status, modules_status.
    # Nested format (cpu.percent, memory.percent...) is not used.
    services = payload.get("services_status", payload.get("services", {}))
    modules = payload.get("modules_status", payload.get("modules", {}))

    row = InstanceTelemetry(
        instance_id=instance_id,
        cpu_percent=payload.get("cpu_percent", 0.0),
        ram_percent=payload.get("ram_percent", 0.0),
        ram_total=payload.get("ram_total", 0),
        ram_used=0,
        disk_percent=payload.get("disk_percent", 0.0),
        disk_total=payload.get("disk_total", 0),
        disk_used=0,
        net_in_bps=payload.get("net_in_bps", 0),
        net_out_bps=payload.get("net_out_bps", 0),
        services_status=json.dumps(services),
        modules_status=json.dumps(modules),
        raw=json.dumps(payload),
    )
    session.add(row)
    await session.flush()
    return row
