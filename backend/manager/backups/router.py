"""
Instance backups (UI). Limited to the caller's scope: listing them needs
scope.view; running, downloading, deleting and restoring need scope.manage.
"""
import os
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from manager.agents import protocol
from manager.agents.dispatcher import check_capability, queue_command
from manager.instances.router import get_instance_or_404
from manager.models import Backup
from .service import apply_retention, backup_file, delete_backup

router = APIRouter(prefix="/api", tags=["Backups"])


async def _backup_or_404(session, backup_id: str, user: User):
    """The backup and its instance, or 404 when either is missing or out of scope."""
    backup = await session.get(Backup, backup_id)
    if backup is None:
        raise HTTPException(404, "Backup non trovato")
    try:
        instance = await get_instance_or_404(session, backup.instance_id, user)
    except HTTPException:
        raise HTTPException(404, "Backup non trovato")
    return backup, instance


@router.get("/instances/{instance_id}/backups")
async def list_backups(instance_id: str, session: AsyncSession = Depends(get_session),
                       user: User = Depends(require_permission("scope.view"))):
    await get_instance_or_404(session, instance_id, user)
    rows = (await session.execute(
        select(Backup).where(Backup.instance_id == instance_id).order_by(Backup.created_at.desc())
    )).scalars().all()
    return [b.model_dump() for b in rows]


@router.post("/instances/{instance_id}/backups", status_code=202)
async def run_backup(instance_id: str, session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("scope.manage"))):
    instance = await get_instance_or_404(session, instance_id, user)
    if instance.status != "active":
        raise HTTPException(409, "Istanza non attiva")
    check_capability(instance.id, protocol.CMD_BACKUP_RUN)
    cmd = await queue_command(session, instance.id, protocol.CMD_BACKUP_RUN, {},
                              operator=user.username, ttl=timedelta(hours=1))
    return {"command_id": cmd.id, "status": cmd.status}


@router.get("/backups/{backup_id}/download")
async def download(backup_id: str, session: AsyncSession = Depends(get_session),
                   user: User = Depends(require_permission("scope.manage"))):
    backup, _ = await _backup_or_404(session, backup_id, user)
    if not os.path.exists(backup_file(backup)):
        raise HTTPException(404, "Backup non trovato")
    # Encrypted with the instance passphrase: usable only by a restore
    name = backup.archive_name or f"{backup.id}.tar.gz.enc"
    return FileResponse(backup_file(backup), media_type="application/octet-stream", filename=name)


@router.delete("/backups/{backup_id}", status_code=204)
async def remove(backup_id: str, session: AsyncSession = Depends(get_session),
                 user: User = Depends(require_permission("scope.manage"))):
    backup, _ = await _backup_or_404(session, backup_id, user)
    await delete_backup(session, backup)
    await session.commit()


class RestoreRequest(BaseModel):
    confirm_name: str = Field(max_length=100)
    reason: str = Field(min_length=3, max_length=500)


@router.post("/backups/{backup_id}/restore", status_code=202)
async def restore(backup_id: str, body: RestoreRequest, session: AsyncSession = Depends(get_session),
                  user: User = Depends(require_permission("scope.manage"))):
    backup, instance = await _backup_or_404(session, backup_id, user)
    if body.confirm_name != instance.name:
        raise HTTPException(400, "Il nome di conferma non corrisponde al nome dell'istanza")
    if instance.status != "active":
        raise HTTPException(409, "Istanza non attiva")
    check_capability(instance.id, protocol.CMD_BACKUP_RESTORE)
    # Short TTL: a restore must not start hours later when the instance
    # comes back online
    cmd = await queue_command(session, instance.id, protocol.CMD_BACKUP_RESTORE,
                              {"backup_id": backup.id}, operator=user.username,
                              ttl=timedelta(minutes=30))
    return {"command_id": cmd.id, "status": cmd.status}


__all__ = ["router", "apply_retention"]
