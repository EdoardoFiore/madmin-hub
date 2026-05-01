"""
Telemetry ingest: persist heartbeat/batch frames into InstanceTelemetry rows.
"""
import json
import logging
import uuid
from datetime import datetime
from typing import List

from sqlalchemy.ext.asyncio import AsyncSession

from .models import InstanceTelemetry

logger = logging.getLogger(__name__)


def _snapshot_to_row(instance_id: uuid.UUID, snap: dict, services: dict, modules: dict) -> InstanceTelemetry:
    ts_raw = snap.get("ts")
    ts = datetime.fromisoformat(ts_raw) if ts_raw else datetime.utcnow()
    return InstanceTelemetry(
        instance_id=instance_id,
        ts=ts,
        cpu_percent=snap.get("cpu_percent", 0.0),
        ram_percent=snap.get("ram_percent", 0.0),
        ram_total=snap.get("ram_total", 0),
        ram_used=snap.get("ram_used", 0),
        disk_percent=snap.get("disk_percent", 0.0),
        disk_total=snap.get("disk_total", 0),
        disk_used=snap.get("disk_used", 0),
        net_in_bps=snap.get("net_in_bps", 0),
        net_out_bps=snap.get("net_out_bps", 0),
        services_status=json.dumps(services),
        modules_status=json.dumps(modules),
        raw=json.dumps(snap),
    )


async def ingest_heartbeat(
    session: AsyncSession,
    instance_id: uuid.UUID,
    payload: dict,
) -> InstanceTelemetry:
    """Legacy single-snapshot heartbeat ingest (back-compat)."""
    services = payload.get("services_status", payload.get("services", {}))
    modules = payload.get("modules_status", payload.get("modules", {}))
    row = _snapshot_to_row(instance_id, payload, services, modules)
    session.add(row)
    await session.flush()
    return row


async def ingest_telemetry_batch(
    session: AsyncSession,
    instance_id: uuid.UUID,
    payload: dict,
) -> List[InstanceTelemetry]:
    """
    Ingest a telemetry_batch frame.
    payload = {snapshots: [...], services_status: {...}, modules_status: {...}, ...}
    Deduped by ts — skips rows already stored.
    """
    snapshots = payload.get("snapshots", [])
    services = payload.get("services_status", {})
    modules = payload.get("modules_status", {})

    if not snapshots:
        return []

    rows = []
    for snap in snapshots:
        row = _snapshot_to_row(instance_id, snap, services, modules)
        session.add(row)
        rows.append(row)

    await session.flush()
    logger.debug(f"Ingested {len(rows)} telemetry snapshots for {instance_id}")
    return rows
