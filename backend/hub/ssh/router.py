"""
SSH router: key vault CRUD, assignment push/revoke.
"""
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session
from core.i18n import get_lang, tr

from . import service as ssh_svc
from .models import SSHKey, SSHKeyAssignment

router = APIRouter(prefix="/api/ssh", tags=["SSH Keys"])


# --- Key vault ---

class KeyCreate(BaseModel):
    name: str
    public_key: str
    notes: Optional[str] = None


class KeyUpdate(BaseModel):
    name: Optional[str] = None
    notes: Optional[str] = None


@router.get("/keys")
async def list_keys(
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
):
    keys = await ssh_svc.list_keys(session)
    return [
        {
            "id": str(k.id),
            "name": k.name,
            "fingerprint": k.fingerprint,
            "owner": k.owner,
            "notes": k.notes,
            "created_at": k.created_at.isoformat(),
        }
        for k in keys
    ]


@router.post("/keys")
async def create_key(
    payload: KeyCreate,
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
):
    try:
        key = await ssh_svc.create_key(
            session,
            name=payload.name,
            public_key=payload.public_key,
            owner=user.username,
            notes=payload.notes,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "id": str(key.id),
        "name": key.name,
        "fingerprint": key.fingerprint,
        "created_at": key.created_at.isoformat(),
    }


@router.patch("/keys/{key_id}")
async def update_key(
    key_id: uuid.UUID,
    body: KeyUpdate,
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(SSHKey).where(SSHKey.id == key_id))
    key = result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=404, detail="Chiave non trovata")
    if body.name is not None:
        key.name = body.name
    if body.notes is not None:
        key.notes = body.notes
    session.add(key)
    return {"id": str(key.id), "name": key.name, "notes": key.notes}


@router.delete("/keys/{key_id}")
async def delete_key(
    request: Request,
    key_id: uuid.UUID,
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    # Block deletion if active assignments exist
    result = await session.execute(
        select(SSHKeyAssignment).where(
            SSHKeyAssignment.ssh_key_id == key_id,
            SSHKeyAssignment.status == "active",
        )
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail=tr("active_assignments_exist", lang))
    deleted = await ssh_svc.delete_key(session, key_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=tr("key_not_found", lang))
    return {"detail": tr("key_deleted", lang)}


# --- Assignments ---

class AssignCreate(BaseModel):
    ssh_key_id: uuid.UUID
    target_type: str  # instance | group
    target_id: uuid.UUID
    target_user: str = "root"
    allow_source_ips: List[str] = []
    expires_at: Optional[datetime] = None


@router.get("/assignments")
async def list_assignments(
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
    key_id: Optional[uuid.UUID] = None,
    target_id: Optional[uuid.UUID] = None,
    status: Optional[str] = None,
):
    stmt = select(SSHKeyAssignment).order_by(SSHKeyAssignment.created_at.desc())
    if key_id:
        stmt = stmt.where(SSHKeyAssignment.ssh_key_id == key_id)
    if target_id:
        stmt = stmt.where(SSHKeyAssignment.target_id == target_id)
    if status:
        stmt = stmt.where(SSHKeyAssignment.status == status)
    result = await session.execute(stmt)
    items = result.scalars().all()
    return [
        {
            "id": str(a.id),
            "ssh_key_id": str(a.ssh_key_id),
            "target_type": a.target_type,
            "target_id": str(a.target_id),
            "target_user": a.target_user,
            "status": a.status,
            "pushed_at": a.pushed_at.isoformat() if a.pushed_at else None,
            "revoked_at": a.revoked_at.isoformat() if a.revoked_at else None,
            "expires_at": a.expires_at.isoformat() if a.expires_at else None,
            "assigned_by": a.assigned_by,
            "created_at": a.created_at.isoformat(),
        }
        for a in items
    ]


@router.post("/assignments")
async def create_assignment(
    request: Request,
    payload: AssignCreate,
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
):
    import json

    lang = get_lang(request)
    if payload.target_type not in ("instance", "group"):
        raise HTTPException(status_code=400, detail=tr("invalid_target_type", lang))

    # Check key exists
    result = await session.execute(select(SSHKey).where(SSHKey.id == payload.ssh_key_id))
    key = result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=404, detail=tr("ssh_key_not_found", lang))

    assignment = SSHKeyAssignment(
        ssh_key_id=payload.ssh_key_id,
        target_type=payload.target_type,
        target_id=payload.target_id,
        target_user=payload.target_user,
        allow_source_ips=json.dumps(payload.allow_source_ips),
        assigned_by=user.username,
        expires_at=payload.expires_at.replace(tzinfo=None) if payload.expires_at else None,
    )
    session.add(assignment)
    await session.flush()
    await session.refresh(assignment)

    results = await ssh_svc.push_assignment(session, assignment, key, requested_by=user.username)
    return {
        "assignment_id": str(assignment.id),
        "status": assignment.status,
        "push_results": results,
    }


@router.delete("/assignments/{assignment_id}")
async def revoke_assignment(
    request: Request,
    assignment_id: uuid.UUID,
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    result = await session.execute(
        select(SSHKeyAssignment).where(SSHKeyAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()
    if not assignment:
        raise HTTPException(status_code=404, detail=tr("assignment_not_found", lang))
    if assignment.status == "revoked":
        raise HTTPException(status_code=400, detail=tr("already_revoked", lang))

    key_result = await session.execute(
        select(SSHKey).where(SSHKey.id == assignment.ssh_key_id)
    )
    key = key_result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=404, detail=tr("ssh_key_not_found", lang))

    results = await ssh_svc.revoke_assignment(session, assignment, key, requested_by=user.username)
    return {"status": "revoked", "revoke_results": results}
