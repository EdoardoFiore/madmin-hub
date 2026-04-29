"""
Telemetry service: query helpers for history + fleet aggregation.
"""
import uuid
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import InstanceTelemetry


async def get_history(
    session: AsyncSession,
    instance_id: uuid.UUID,
    hours: int = 6,
    max_points: int = 360,
) -> List[InstanceTelemetry]:
    since = datetime.utcnow() - timedelta(hours=hours)
    result = await session.execute(
        select(InstanceTelemetry)
        .where(
            InstanceTelemetry.instance_id == instance_id,
            InstanceTelemetry.ts >= since,
        )
        .order_by(InstanceTelemetry.ts.asc())
        .limit(max_points)
    )
    return result.scalars().all()


async def get_latest(
    session: AsyncSession, instance_id: uuid.UUID
) -> Optional[InstanceTelemetry]:
    result = await session.execute(
        select(InstanceTelemetry)
        .where(InstanceTelemetry.instance_id == instance_id)
        .order_by(InstanceTelemetry.ts.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


def telemetry_to_dict(t: InstanceTelemetry) -> dict:
    import json

    return {
        "ts": t.ts.isoformat(),
        "cpu_percent": t.cpu_percent,
        "ram_percent": t.ram_percent,
        "ram_total": t.ram_total,
        "ram_used": t.ram_used,
        "disk_percent": t.disk_percent,
        "disk_total": t.disk_total,
        "disk_used": t.disk_used,
        "net_in_bps": t.net_in_bps,
        "net_out_bps": t.net_out_bps,
        "services_status": json.loads(t.services_status or "{}"),
        "modules_status": json.loads(t.modules_status or "[]"),
    }
