"""
Instance backups kept by the manager (files in DATA_DIR/backups/<instance_id>/).

The archives are encrypted by the instance with its backup passphrase (see
Instance.backup_passphrase_enc): the manager stores them as they arrive.
"""
import asyncio
import logging
import os
from datetime import datetime, timedelta

from sqlmodel import select

from core.database import async_session_maker
from core.settings.router import get_system_settings

from manager.agents import protocol
from manager.agents.dispatcher import queue_command
from manager.agents.registry import registry
from manager.models import Backup, Command, Instance

logger = logging.getLogger("madmin_manager.backups")

SCHEDULE_INTERVAL = 600


def backup_file(backup: Backup) -> str:
    from manager.agents.router import backup_path
    return backup_path(backup.instance_id, backup.id)


async def delete_backup(session, backup: Backup) -> None:
    try:
        os.unlink(backup_file(backup))
    except FileNotFoundError:
        pass
    await session.delete(backup)


async def apply_retention(session, instance_id: str) -> None:
    keep = (await get_system_settings(session)).backup_retention
    rows = (await session.execute(
        select(Backup).where(Backup.instance_id == instance_id).order_by(Backup.created_at.desc())
    )).scalars().all()
    for old in rows[keep:]:
        await delete_backup(session, old)
    await session.commit()


async def delete_instance_backups(session, instance_id: str) -> None:
    rows = (await session.execute(select(Backup).where(Backup.instance_id == instance_id))).scalars().all()
    for b in rows:
        await delete_backup(session, b)


async def _schedule_once() -> None:
    async with async_session_maker() as session:
        interval = (await get_system_settings(session)).backup_interval_hours
        if interval <= 0:
            return
        due_before = datetime.utcnow() - timedelta(hours=interval)
        instances = (await session.execute(select(Instance).where(
            Instance.status == "active", Instance.backup_enabled == True  # noqa: E712
        ))).scalars().all()
        for inst in instances:
            # Only connected instances: a command queued for an offline one
            # would run all at once when it comes back
            if not registry.is_online(inst.id):
                continue
            conn = registry.get(inst.id)
            if conn is None or protocol.CMD_BACKUP_RUN not in conn.capabilities:
                continue
            last = (await session.execute(
                select(Backup.created_at).where(Backup.instance_id == inst.id)
                .order_by(Backup.created_at.desc()).limit(1)
            )).scalar_one_or_none()
            if last is not None and last > due_before:
                continue
            pending = (await session.execute(select(Command.id).where(
                Command.instance_id == inst.id, Command.name == protocol.CMD_BACKUP_RUN,
                Command.status.in_(("queued", "sent", "running")),
            ).limit(1))).first()
            if pending:
                continue
            await queue_command(session, inst.id, protocol.CMD_BACKUP_RUN, {},
                                operator="scheduler", ttl=timedelta(hours=1))
            logger.info("Scheduled backup requested for %s", inst.name)


async def scheduler_task() -> None:
    while True:
        await asyncio.sleep(SCHEDULE_INTERVAL)
        try:
            await _schedule_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Backup scheduler error")
