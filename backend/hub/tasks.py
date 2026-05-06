"""
Hub background tasks: telemetry retention, command cleanup, audit cleanup, backup scheduler.
"""
import asyncio
import logging
from datetime import datetime, timedelta

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


async def backup_scheduler_task(interval_minutes: int = 5):
    """Check for due backup schedules and dispatch backup.run to online agents."""
    while True:
        await asyncio.sleep(interval_minutes * 60)
        try:
            from core.database import async_session_maker
            from hub.backups.service import get_due_schedules, resolve_schedule_instances, get_repo
            from hub.ws import dispatcher as disp
            from config import get_settings

            settings = get_settings()
            now = datetime.utcnow()

            async with async_session_maker() as session:
                schedules = await get_due_schedules(session, now)

                for sched in schedules:
                    repo = await get_repo(session, sched.repo_id)
                    if not repo:
                        continue

                    instances = await resolve_schedule_instances(session, sched)

                    for inst in instances:
                        if not inst.ws_connected:
                            continue
                        try:
                            # Agent always uploads to hub via HTTP; hub transfers to repo.
                            params: dict = {
                                "remote_protocol": "http",
                                "remote_host": (
                                    f"{settings.hub_public_url}/api/instances/{inst.id}/backups/upload"
                                    f"?repo_id={repo.id}"
                                ),
                                "remote_password": "__agent_self_token__",
                            }

                            await disp.dispatch(
                                session,
                                instance_id=inst.id,
                                action="backup.run",
                                params=params,
                                requested_by="scheduler",
                                timeout=300,
                            )
                            logger.info(f"Scheduled backup dispatched to {inst.id}")
                        except Exception as e:
                            logger.error(f"Scheduled backup failed for {inst.id}: {e}")

                    sched.last_run = now
                    sched.next_run = now + timedelta(hours=sched.interval_hours)
                    session.add(sched)
                    await session.commit()

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Backup scheduler error: {e}")
