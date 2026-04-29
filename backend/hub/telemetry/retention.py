"""
Retention cleanup: delete old telemetry rows and expired commands.
"""
import logging
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import InstanceCommand, InstanceTelemetry

logger = logging.getLogger(__name__)


async def cleanup_telemetry(session: AsyncSession, retention_days: int) -> int:
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    result = await session.execute(
        delete(InstanceTelemetry).where(InstanceTelemetry.ts < cutoff)
    )
    await session.commit()
    n = result.rowcount or 0
    if n:
        logger.info(f"Telemetry retention: removed {n} rows older than {retention_days}d")
    return n


async def cleanup_expired_commands(session: AsyncSession) -> int:
    now = datetime.utcnow()
    result = await session.execute(
        delete(InstanceCommand).where(
            InstanceCommand.expires_at < now,
            InstanceCommand.status.in_(["done", "failed", "timeout"]),
        )
    )
    await session.commit()
    return result.rowcount or 0
