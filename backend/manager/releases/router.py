"""
Releases API (superuser): upload, channel, delete, and the update of an
instance to a release. The agents download from /agent/releases/<id>
(agents/router.py).
"""
import asyncio
import json
import os
import uuid
from datetime import timedelta
from typing import Optional
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session
from core.settings.router import get_system_settings

from manager.agents import protocol
from manager.agents.dispatcher import check_capability, queue_command
from manager.instances.router import get_instance_or_404
from manager.models import Instance, Release
from . import service

router = APIRouter(prefix="/api", tags=["Releases"])

UPDATE_TTL = timedelta(days=1)
UPDATE_TIMEOUT = 1800


def release_out(r: Release, installed: int = 0) -> dict:
    d = r.model_dump(exclude={"manifest_json"})
    d["manifest"] = service.manifest_summary(r.manifest_json)
    d["installed_on"] = installed
    return d


@router.get("/releases")
async def list_releases(session: AsyncSession = Depends(get_session),
                        user: User = Depends(require_permission("manager.view"))):
    rows = (await session.execute(select(Release).order_by(Release.uploaded_at.desc()))).scalars().all()
    builds = (await session.execute(select(Instance.build).where(Instance.status == "active"))).scalars().all()
    count = {}
    for b in builds:
        count[b] = count.get(b, 0) + 1
    return [release_out(r, count.get(r.build, 0)) for r in rows]


@router.post("/releases", status_code=201)
async def upload(request: Request, session: AsyncSession = Depends(get_session),
                 user: User = Depends(require_permission("manager.manage"))):
    """The body is the .release file itself (not multipart)."""
    tmp = os.path.join(service.releases_dir(), f".upload-{uuid.uuid4().hex}")
    size = 0
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > service.MAX_SIZE:
                    raise HTTPException(413, "File troppo grande")
                await asyncio.to_thread(f.write, chunk)
        keys = (await get_system_settings(session)).release_keys
        try:
            manifest, signed_by = await asyncio.to_thread(service.inspect, tmp, keys)
        except (service.ReleaseError, ValueError) as e:
            raise HTTPException(400, f"Release rifiutata: {e}")
        rid = manifest["release_id"]
        if await session.get(Release, rid) is not None:
            raise HTTPException(409, f"Release {rid} già presente")
        digest = await asyncio.to_thread(service.file_sha256, tmp)
        os.replace(tmp, service.release_path(rid))
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    row = Release(id=rid, version=str(manifest["version"])[:30], build=str(manifest["build"])[:40],
                  size=size, sha256=digest, manifest_json=json.dumps(manifest), signed_by=signed_by,
                  notes=unquote(request.headers.get("x-release-notes") or "")[:1000], uploaded_by=user.username)
    session.add(row)
    await session.commit()
    return release_out(row)


class ReleasePatch(BaseModel):
    channel: Optional[str] = Field(default=None, pattern="^(candidate|stable)$")
    notes: Optional[str] = Field(default=None, max_length=1000)


@router.patch("/releases/{release_id}")
async def patch_release(release_id: str, body: ReleasePatch, session: AsyncSession = Depends(get_session),
                        user: User = Depends(require_permission("manager.manage"))):
    row = await session.get(Release, release_id)
    if row is None:
        raise HTTPException(404, "Release non trovata")
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(row, k, v)
    session.add(row)
    await session.commit()
    return release_out(row)


@router.delete("/releases/{release_id}", status_code=204)
async def delete_release(release_id: str, session: AsyncSession = Depends(get_session),
                         user: User = Depends(require_permission("manager.manage"))):
    row = await session.get(Release, release_id)
    if row is None:
        raise HTTPException(404, "Release non trovata")
    await session.delete(row)
    await session.commit()
    service.remove_file(release_id)


class UpdateIn(BaseModel):
    release_id: str = Field(max_length=80)
    # Health gate on the instance (seconds); default: the updater's (5 minutes)
    deadline: Optional[int] = Field(default=None, ge=60, le=3600)


@router.post("/instances/{instance_id}/update", status_code=202)
async def update_instance(instance_id: str, body: UpdateIn, session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("manager.manage"))):
    """One instance to a release (candidate or stable). The outcome arrives
    in the instance's update state (hello.state.update, update.status)."""
    instance = await get_instance_or_404(session, instance_id, user)
    if instance.status != "active":
        raise HTTPException(409, "Istanza non attiva")
    if instance.layout < 1:
        raise HTTPException(409, "Installazione senza updater (layout precedente): reinstallare l'istanza")
    row = await session.get(Release, body.release_id)
    if row is None or not service.stored(row.id):
        raise HTTPException(404, "Release non trovata")
    if instance.build == row.build:
        raise HTTPException(409, "Release già installata")
    os_id = (json.loads(instance.facts_json or "{}").get("os_id"))
    manifest = json.loads(row.manifest_json)
    if os_id and os_id not in (manifest.get("os") or []):
        raise HTTPException(409, f"Release per {', '.join(manifest.get('os') or [])}, l'istanza è {os_id}")
    check_capability(instance.id, protocol.CMD_UPDATE)
    args = {"release_id": row.id, "sha256": row.sha256}
    if body.deadline:
        args["deadline"] = body.deadline
    cmd = await queue_command(session, instance.id, protocol.CMD_UPDATE, args, operator=user.username,
                              ttl=UPDATE_TTL, timeout=UPDATE_TIMEOUT)
    return {"command_id": cmd.id, "status": cmd.status, "release_id": row.id}
