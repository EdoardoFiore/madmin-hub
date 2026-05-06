"""
Backup router: repos CRUD, backup upload/list/download, restore, schedules.
"""
import json
import logging
import os
import uuid
from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings
from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import async_session_maker, get_session
from hub.instances.enrollment import verify_agent_token
from hub.instances.models import ManagedInstance
from hub.instances.service import get_instance

from . import service as svc
from .models import BackupRepo, InstanceBackup

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Backups"])


# ── Agent auth dependency ─────────────────────────────────────────────────────

async def get_agent_instance(
    instance_id: uuid.UUID,
    authorization: Optional[str] = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> ManagedInstance:
    """Verify agent Bearer token and confirm it matches the given instance_id."""
    raw_token = None
    if authorization and authorization.startswith("Bearer "):
        raw_token = authorization[7:]
    if not raw_token:
        raise HTTPException(status_code=401, detail="Token agente mancante")

    res = await session.execute(
        select(ManagedInstance).where(
            ManagedInstance.id == instance_id,
            ManagedInstance.enrollment_status == "active",
        )
    )
    instance = res.scalar_one_or_none()
    if not instance:
        raise HTTPException(status_code=404, detail="Istanza non trovata")

    if not verify_agent_token(raw_token, instance.agent_token_hash):
        raise HTTPException(status_code=403, detail="Token agente non valido")

    return instance


# ── Request models ────────────────────────────────────────────────────────────

class RepoCreate(BaseModel):
    name: str
    type: str
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None
    remote_path: str = "/backups"
    local_path: Optional[str] = None
    retention_days: int = 30
    is_default: bool = False


class RepoPatch(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None
    remote_path: Optional[str] = None
    local_path: Optional[str] = None
    retention_days: Optional[int] = None
    is_default: Optional[bool] = None


class ScheduleCreate(BaseModel):
    name: str
    repo_id: uuid.UUID
    instance_ids: List[str] = []
    group_id: Optional[uuid.UUID] = None
    interval_hours: int = 24
    enabled: bool = True


class SchedulePatch(BaseModel):
    name: Optional[str] = None
    repo_id: Optional[uuid.UUID] = None
    instance_ids: Optional[List[str]] = None
    group_id: Optional[uuid.UUID] = None
    interval_hours: Optional[int] = None
    enabled: Optional[bool] = None


# ── Repos ─────────────────────────────────────────────────────────────────────

@router.get("/api/backups/repos")
async def list_repos(
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    repos = await svc.list_repos(session)
    return [svc.repo_to_dict(r) for r in repos]


@router.post("/api/backups/repos")
async def create_repo(
    payload: RepoCreate,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    try:
        repo = await svc.create_repo(
            session,
            name=payload.name,
            type=payload.type,
            host=payload.host,
            port=payload.port,
            username=payload.username,
            password=payload.password,
            remote_path=payload.remote_path,
            local_path=payload.local_path,
            retention_days=payload.retention_days,
            is_default=payload.is_default,
            created_by=user.username,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return svc.repo_to_dict(repo)


@router.patch("/api/backups/repos/{repo_id}")
async def patch_repo(
    repo_id: uuid.UUID,
    payload: RepoPatch,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    repo = await svc.get_repo(session, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository non trovato")
    await svc.update_repo(session, repo, **payload.dict(exclude_unset=True))
    return svc.repo_to_dict(repo)


@router.delete("/api/backups/repos/{repo_id}")
async def delete_repo(
    repo_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    repo = await svc.get_repo(session, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository non trovato")
    if repo.is_default:
        raise HTTPException(status_code=400, detail="Non puoi eliminare il repository predefinito")
    await session.delete(repo)
    return {"detail": "Repository eliminato"}


@router.post("/api/backups/repos/{repo_id}/test")
async def test_repo(
    repo_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    repo = await svc.get_repo(session, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository non trovato")

    if repo.type == "local":
        path = svc.get_local_storage_path(repo)
        try:
            os.makedirs(path, exist_ok=True)
            test_file = os.path.join(path, ".test_write")
            with open(test_file, "w") as f:
                f.write("ok")
            os.remove(test_file)
            return {"ok": True, "detail": f"Percorso accessibile: {path}"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}

    password = svc.get_repo_plaintext_password(repo)
    host = repo.host or ""
    port = repo.port or (22 if repo.type in ("sftp", "scp") else 21)
    user_name = repo.username or ""
    remote_path = repo.remote_path or "/backups"

    if repo.type == "sftp":
        try:
            import asyncssh
            async with asyncssh.connect(
                host, port=port, username=user_name, password=password,
                known_hosts=None, connect_timeout=10,
            ) as conn:
                await conn.run(f"ls {remote_path}", check=True)
            return {"ok": True, "detail": "Connessione SFTP riuscita"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}

    if repo.type == "ftp":
        try:
            import aioftp
            async with aioftp.Client.context(host, port=port, user=user_name, password=password or "") as client:
                await client.list(remote_path)
            return {"ok": True, "detail": "Connessione FTP riuscita"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}

    if repo.type == "scp":
        try:
            import asyncssh
            async with asyncssh.connect(
                host, port=port, username=user_name, password=password,
                known_hosts=None, connect_timeout=10,
            ) as conn:
                await conn.run(f"ls {remote_path}", check=True)
            return {"ok": True, "detail": "Connessione SCP riuscita"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}

    return {"ok": False, "detail": "Tipo repo non supportato per il test"}


# ── Backup records ────────────────────────────────────────────────────────────

@router.get("/api/instances/{instance_id}/backups")
async def list_instance_backups(
    instance_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    instance = await get_instance(session, instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="Istanza non trovata")

    backups = await svc.list_backups(session, instance_id=instance_id)

    # Build repo name lookup
    repo_ids = list({str(b.repo_id) for b in backups})
    repos = {}
    for r in repo_ids:
        try:
            repo = await svc.get_repo(session, uuid.UUID(r))
            if repo:
                repos[r] = repo.name
        except Exception:
            pass

    return [svc.backup_to_dict(b, repo_name=repos.get(str(b.repo_id))) for b in backups]


@router.get("/api/backups")
async def list_all_backups(
    repo_id: Optional[uuid.UUID] = None,
    limit: int = 100,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    backups = await svc.list_backups(session, repo_id=repo_id, limit=limit)
    return [svc.backup_to_dict(b) for b in backups]


# ── Agent upload endpoint ─────────────────────────────────────────────────────

@router.post("/api/instances/{instance_id}/backups/upload")
async def upload_backup(
    instance_id: uuid.UUID,
    repo_id: Optional[uuid.UUID] = Query(None),
    file: UploadFile = File(...),
    instance: ManagedInstance = Depends(get_agent_instance),
    session: AsyncSession = Depends(get_session),
):
    """Agent-facing endpoint: receive backup archive, transfer to target repo."""
    import tempfile

    # Resolve target repo
    repo = None
    if repo_id:
        repo = await svc.get_repo(session, repo_id)
    if not repo:
        repo = await svc.get_default_repo(session)
    if not repo:
        raise HTTPException(status_code=500, detail="Nessun repository configurato")

    filename = os.path.basename(file.filename or f"backup_{instance_id}.tar.gz")
    data = await file.read()
    size = len(data)

    suffix = os.path.splitext(filename)[-1] or ".tar.gz"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(data)
        tmp.close()

        storage_path = await svc.transfer_to_repo(repo, tmp.name, filename, instance_id)

        rec = await svc.create_backup_record(
            session,
            instance_id=instance_id,
            repo_id=repo.id,
            filename=filename,
            storage_path=storage_path,
            size_bytes=size,
            triggered_by="agent",
        )
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass

    logger.info(f"Backup istanza {instance_id}: {filename} ({size} B) → repo {repo.name}")
    return {"id": str(rec.id), "filename": filename, "size_bytes": size}


# ── Download ──────────────────────────────────────────────────────────────────

@router.get("/api/instances/{instance_id}/backups/{backup_id}/download")
async def download_backup(
    instance_id: uuid.UUID,
    backup_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    backup = await session.get(InstanceBackup, backup_id)
    if not backup or backup.instance_id != instance_id:
        raise HTTPException(status_code=404, detail="Backup non trovato")

    repo = await svc.get_repo(session, backup.repo_id)
    if not repo or repo.type != "local":
        raise HTTPException(status_code=400, detail="Download diretto disponibile solo per repo locali")

    if not os.path.exists(backup.storage_path):
        raise HTTPException(status_code=404, detail="File backup non trovato sul filesystem")

    return FileResponse(
        path=backup.storage_path,
        filename=backup.filename,
        media_type="application/gzip",
    )


# ── Restore ───────────────────────────────────────────────────────────────────

@router.post("/api/instances/{instance_id}/backups/{backup_id}/restore")
async def restore_backup(
    instance_id: uuid.UUID,
    backup_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    backup = await session.get(InstanceBackup, backup_id)
    if not backup or backup.instance_id != instance_id:
        raise HTTPException(status_code=404, detail="Backup non trovato")

    instance = await get_instance(session, instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="Istanza non trovata")
    if instance.enrollment_status != "active":
        raise HTTPException(status_code=400, detail="Istanza non attiva")

    repo = await svc.get_repo(session, backup.repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository non trovato")

    # Build params for the agent
    params: dict = {"filename": backup.filename}

    if repo.type == "local":
        settings = get_settings()
        download_url = f"{settings.hub_public_url}/api/instances/{instance_id}/backups/{backup_id}/download"
        params["remote_protocol"] = "http"
        params["remote_host"] = download_url
        # Agent uses its own token for the download request
        params["remote_password"] = "__agent_self_token__"
    else:
        password = svc.get_repo_plaintext_password(repo)
        params["remote_protocol"] = repo.type
        params["remote_host"] = repo.host
        params["remote_port"] = repo.port
        params["remote_user"] = repo.username
        params["remote_password"] = password or ""
        params["remote_path"] = f"{repo.remote_path}/{instance_id}"

    from hub.ws import dispatcher as disp
    result = await disp.dispatch(
        session,
        instance_id=instance_id,
        action="backup.restore",
        params=params,
        requested_by=user.username,
        timeout=300,
    )
    return result


# ── Schedules ─────────────────────────────────────────────────────────────────

@router.get("/api/backups/schedules")
async def list_schedules(
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    scheds = await svc.list_schedules(session)
    return [svc.schedule_to_dict(s) for s in scheds]


@router.post("/api/backups/schedules")
async def create_schedule(
    payload: ScheduleCreate,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    repo = await svc.get_repo(session, payload.repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository non trovato")
    sched = await svc.create_schedule(
        session,
        name=payload.name,
        repo_id=payload.repo_id,
        instance_ids=payload.instance_ids,
        group_id=payload.group_id,
        interval_hours=payload.interval_hours,
        enabled=payload.enabled,
        created_by=user.username,
    )
    return svc.schedule_to_dict(sched)


@router.patch("/api/backups/schedules/{schedule_id}")
async def patch_schedule(
    schedule_id: uuid.UUID,
    payload: SchedulePatch,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    sched = await svc.get_schedule(session, schedule_id)
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule non trovato")
    for k, v in payload.dict(exclude_unset=True).items():
        if k == "instance_ids" and v is not None:
            setattr(sched, k, json.dumps(v))
        else:
            setattr(sched, k, v)
    if payload.interval_hours is not None:
        from datetime import datetime, timedelta
        sched.next_run = datetime.utcnow() + timedelta(hours=payload.interval_hours)
    session.add(sched)
    return svc.schedule_to_dict(sched)


@router.delete("/api/backups/schedules/{schedule_id}")
async def delete_schedule(
    schedule_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    sched = await svc.get_schedule(session, schedule_id)
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule non trovato")
    await session.delete(sched)
    return {"detail": "Schedule eliminato"}
