"""
Backup service: BackupRepo and InstanceBackup business logic.
"""
import json
import logging
import os
import uuid
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings
from core.auth.service import encrypt_secret, decrypt_secret
from hub.instances.models import ManagedInstance, InstanceGroup

from .models import BackupRepo, BackupSchedule, InstanceBackup

logger = logging.getLogger(__name__)


# ── Repos ─────────────────────────────────────────────────────────────────────

async def list_repos(session: AsyncSession) -> List[BackupRepo]:
    res = await session.execute(select(BackupRepo).order_by(BackupRepo.is_default.desc(), BackupRepo.name))
    return res.scalars().all()


async def get_repo(session: AsyncSession, repo_id: uuid.UUID) -> Optional[BackupRepo]:
    return await session.get(BackupRepo, repo_id)


async def get_default_repo(session: AsyncSession) -> Optional[BackupRepo]:
    res = await session.execute(select(BackupRepo).where(BackupRepo.is_default == True).limit(1))
    return res.scalar_one_or_none()


async def create_repo(
    session: AsyncSession,
    *,
    name: str,
    type: str,
    host: Optional[str] = None,
    port: Optional[int] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
    remote_path: str = "/backups",
    local_path: Optional[str] = None,
    retention_days: int = 30,
    is_default: bool = False,
    created_by: Optional[str] = None,
) -> BackupRepo:
    if type not in ("local", "sftp", "ftp", "scp"):
        raise ValueError(f"Tipo repo non valido: {type}")

    # Encrypt password if provided
    enc_password = encrypt_secret(password, purpose="backup_repo") if password else None

    if is_default:
        # Remove default flag from existing default
        existing = await get_default_repo(session)
        if existing:
            existing.is_default = False
            session.add(existing)

    repo = BackupRepo(
        name=name,
        type=type,
        host=host,
        port=port,
        username=username,
        password=enc_password,
        remote_path=remote_path,
        local_path=local_path,
        retention_days=retention_days,
        is_default=is_default,
        created_by=created_by,
    )
    session.add(repo)
    await session.flush()
    await session.refresh(repo)
    return repo


async def update_repo(
    session: AsyncSession,
    repo: BackupRepo,
    *,
    name: Optional[str] = None,
    host: Optional[str] = None,
    port: Optional[int] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
    remote_path: Optional[str] = None,
    local_path: Optional[str] = None,
    retention_days: Optional[int] = None,
    is_default: Optional[bool] = None,
) -> BackupRepo:
    if name is not None:
        repo.name = name
    if host is not None:
        repo.host = host
    if port is not None:
        repo.port = port
    if username is not None:
        repo.username = username
    if password is not None:
        repo.password = encrypt_secret(password, purpose="backup_repo")
    if remote_path is not None:
        repo.remote_path = remote_path
    if local_path is not None:
        repo.local_path = local_path
    if retention_days is not None:
        repo.retention_days = retention_days
    if is_default is True:
        existing = await get_default_repo(session)
        if existing and existing.id != repo.id:
            existing.is_default = False
            session.add(existing)
        repo.is_default = True
    session.add(repo)
    return repo


def repo_to_dict(repo: BackupRepo) -> dict:
    return {
        "id": str(repo.id),
        "name": repo.name,
        "type": repo.type,
        "is_default": repo.is_default,
        "host": repo.host,
        "port": repo.port,
        "username": repo.username,
        "has_password": bool(repo.password),
        "remote_path": repo.remote_path,
        "local_path": repo.local_path,
        "retention_days": repo.retention_days,
        "created_at": repo.created_at.isoformat() if repo.created_at else None,
        "created_by": repo.created_by,
    }


def get_repo_plaintext_password(repo: BackupRepo) -> Optional[str]:
    if not repo.password:
        return None
    try:
        return decrypt_secret(repo.password, purpose="backup_repo")
    except Exception:
        return None


def get_local_storage_path(repo: BackupRepo) -> str:
    if repo.local_path:
        return repo.local_path
    return get_settings().backup_storage_path


async def transfer_to_repo(
    repo: BackupRepo,
    temp_path: str,
    filename: str,
    instance_id: uuid.UUID,
) -> str:
    """
    Move file from temp_path to repo destination.
    Returns storage_path (absolute for local, remote path for sftp/ftp/scp).
    """
    import shutil

    if repo.type == "local":
        base = get_local_storage_path(repo)
        dest_dir = os.path.join(base, str(instance_id))
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, filename)
        shutil.move(temp_path, dest)
        return dest

    password = get_repo_plaintext_password(repo)
    host = repo.host or ""
    port = repo.port
    username = repo.username or ""
    remote_dir = f"{repo.remote_path}/{instance_id}".replace("\\", "/")
    remote_path = f"{remote_dir}/{filename}".replace("\\", "/")

    if repo.type in ("sftp", "scp"):
        import asyncssh
        async with asyncssh.connect(
            host,
            port=port or 22,
            username=username,
            password=password,
            known_hosts=None,
        ) as conn:
            await conn.run(f'mkdir -p "{remote_dir}"', check=False)
            await asyncssh.scp(temp_path, (conn, remote_path))
        return remote_path

    if repo.type == "ftp":
        import aioftp
        async with aioftp.Client.context(
            host, port=port or 21, user=username, password=password or ""
        ) as client:
            try:
                await client.make_directory(remote_dir)
            except Exception:
                pass
            await client.upload(temp_path, remote_path)
        return remote_path

    raise ValueError(f"Tipo repo non supportato per il trasferimento: {repo.type}")


# ── InstanceBackup ────────────────────────────────────────────────────────────

async def list_backups(
    session: AsyncSession,
    instance_id: Optional[uuid.UUID] = None,
    repo_id: Optional[uuid.UUID] = None,
    limit: int = 50,
) -> List[InstanceBackup]:
    q = select(InstanceBackup).order_by(InstanceBackup.created_at.desc()).limit(limit)
    if instance_id:
        q = q.where(InstanceBackup.instance_id == instance_id)
    if repo_id:
        q = q.where(InstanceBackup.repo_id == repo_id)
    res = await session.execute(q)
    return res.scalars().all()


async def create_backup_record(
    session: AsyncSession,
    *,
    instance_id: uuid.UUID,
    repo_id: uuid.UUID,
    filename: str,
    storage_path: str,
    size_bytes: Optional[int] = None,
    triggered_by: Optional[str] = None,
    schedule_id: Optional[uuid.UUID] = None,
    status: str = "ok",
    errors: Optional[List[str]] = None,
) -> InstanceBackup:
    rec = InstanceBackup(
        instance_id=instance_id,
        repo_id=repo_id,
        filename=filename,
        storage_path=storage_path,
        size_bytes=size_bytes,
        triggered_by=triggered_by,
        schedule_id=schedule_id,
        status=status,
        errors=json.dumps(errors or []),
    )
    session.add(rec)
    await session.flush()
    await session.refresh(rec)
    return rec


def backup_to_dict(b: InstanceBackup, repo_name: Optional[str] = None) -> dict:
    return {
        "id": str(b.id),
        "instance_id": str(b.instance_id),
        "repo_id": str(b.repo_id),
        "repo_name": repo_name,
        "filename": b.filename,
        "size_bytes": b.size_bytes,
        "storage_path": b.storage_path,
        "triggered_by": b.triggered_by,
        "created_at": b.created_at.isoformat() if b.created_at else None,
        "status": b.status,
        "errors": json.loads(b.errors) if b.errors else [],
    }


# ── Schedules ─────────────────────────────────────────────────────────────────

async def list_schedules(session: AsyncSession) -> List[BackupSchedule]:
    res = await session.execute(select(BackupSchedule).order_by(BackupSchedule.created_at.desc()))
    return res.scalars().all()


async def get_schedule(session: AsyncSession, schedule_id: uuid.UUID) -> Optional[BackupSchedule]:
    return await session.get(BackupSchedule, schedule_id)


async def create_schedule(
    session: AsyncSession,
    *,
    name: str,
    repo_id: uuid.UUID,
    instance_ids: Optional[List[str]] = None,
    group_id: Optional[uuid.UUID] = None,
    interval_hours: int = 24,
    enabled: bool = True,
    created_by: Optional[str] = None,
) -> BackupSchedule:
    sched = BackupSchedule(
        name=name,
        repo_id=repo_id,
        instance_ids=json.dumps(instance_ids or []),
        group_id=group_id,
        interval_hours=interval_hours,
        enabled=enabled,
        next_run=datetime.utcnow() + timedelta(hours=interval_hours),
        created_by=created_by,
    )
    session.add(sched)
    await session.flush()
    await session.refresh(sched)
    return sched


def schedule_to_dict(s: BackupSchedule) -> dict:
    return {
        "id": str(s.id),
        "name": s.name,
        "repo_id": str(s.repo_id),
        "instance_ids": json.loads(s.instance_ids) if s.instance_ids else [],
        "group_id": str(s.group_id) if s.group_id else None,
        "interval_hours": s.interval_hours,
        "enabled": s.enabled,
        "last_run": s.last_run.isoformat() if s.last_run else None,
        "next_run": s.next_run.isoformat() if s.next_run else None,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "created_by": s.created_by,
    }


async def get_due_schedules(session: AsyncSession, now: datetime) -> List[BackupSchedule]:
    res = await session.execute(
        select(BackupSchedule).where(
            BackupSchedule.enabled == True,
            BackupSchedule.next_run <= now,
        )
    )
    return res.scalars().all()


async def resolve_schedule_instances(session: AsyncSession, sched: BackupSchedule) -> List[ManagedInstance]:
    ids = json.loads(sched.instance_ids or "[]")
    instances = []

    if ids:
        for raw_id in ids:
            try:
                inst = await session.get(ManagedInstance, uuid.UUID(raw_id))
                if inst and inst.enrollment_status == "active":
                    instances.append(inst)
            except Exception:
                pass
    elif sched.group_id:
        res = await session.execute(
            select(ManagedInstance).where(
                ManagedInstance.group_id == sched.group_id,
                ManagedInstance.enrollment_status == "active",
            )
        )
        instances = res.scalars().all()

    return instances


# ── Default repo bootstrap ────────────────────────────────────────────────────

async def ensure_default_local_repo(session: AsyncSession) -> None:
    """Create the default local repo if none exists."""
    res = await session.execute(select(BackupRepo).limit(1))
    if res.scalar_one_or_none():
        return
    repo = BackupRepo(
        name="Hub locale",
        type="local",
        is_default=True,
        remote_path="/backups",
        retention_days=30,
        created_by="system",
    )
    session.add(repo)
    await session.commit()
    logger.info("Creato repo backup locale di default")
