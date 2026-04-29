"""
Hub background tasks: telemetry retention, command cleanup, audit cleanup.
"""
import asyncio
import logging

logger = logging.getLogger(__name__)


async def telemetry_retention_task(interval_hours: int = 6):
    """Purge old telemetry rows based on configured retention_days."""
    while True:
        await asyncio.sleep(interval_hours * 3600)
        try:
            from config import get_settings
            from core.database import async_session_maker
            from core.settings.models import SystemSettings
            from hub.telemetry.retention import cleanup_expired_commands, cleanup_telemetry
            from sqlalchemy import select

            settings = get_settings()

            async with async_session_maker() as session:
                result = await session.execute(select(SystemSettings).where(SystemSettings.id == 1))
                sys_settings = result.scalar_one_or_none()
                retention_days = (
                    sys_settings.telemetry_retention_days
                    if sys_settings
                    else settings.telemetry_retention_days
                )
                await cleanup_telemetry(session, retention_days)
                await cleanup_expired_commands(session)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Telemetry retention error: {e}")


async def audit_cleanup_task(interval_hours: int = 24):
    """Purge old audit log entries."""
    while True:
        await asyncio.sleep(interval_hours * 3600)
        try:
            from core.audit.service import cleanup_old_logs
            from core.database import async_session_maker
            from core.settings.models import SystemSettings
            from sqlalchemy import select

            async with async_session_maker() as session:
                result = await session.execute(select(SystemSettings).where(SystemSettings.id == 1))
                s = result.scalar_one_or_none()
                retention_days = s.audit_retention_days if s else 90
                await cleanup_old_logs(session, retention_days)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Audit cleanup error: {e}")
