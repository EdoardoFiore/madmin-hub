"""
SSH router: key vault CRUD, assignment push/revoke.
"""
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from . import service as ssh_svc
from .models import SSHKey, SSHKeyAssignment

router = APIRouter(prefix="/api/ssh", tags=["SSH Keys"])


# --- Key vault ---

class KeyCreate(BaseModel):
    name: str
    public_key: str
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


@router.delete("/keys/{key_id}")
async def delete_key(
    key_id: uuid.UUID,
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
):
    # Block deletion if active assignments exist
    result = await session.execute(
        select(SSHKeyAssignment).where(
            SSHKeyAssignment.ssh_key_id == key_id,
            SSHKeyAssignment.status == "active",
        )
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Revoca prima le assegnazioni attive")
    deleted = await ssh_svc.delete_key(session, key_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Chiave non trovata")
    return {"detail": "Chiave eliminata"}


# --- Assignments ---

class AssignCreate(BaseModel):
    ssh_key_id: uuid.UUID
    target_type: str  # instance | group
    target_id: uuid.UUID
    target_user: str = "madmin"
    allow_source_ips: List[str] = []


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
            "assigned_by": a.assigned_by,
            "created_at": a.created_at.isoformat(),
        }
        for a in items
    ]


@router.post("/assignments")
async def create_assignment(
    payload: AssignCreate,
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
):
    import json

    if payload.target_type not in ("instance", "group"):
        raise HTTPException(status_code=400, detail="target_type deve essere 'instance' o 'group'")

    # Check key exists
    result = await session.execute(select(SSHKey).where(SSHKey.id == payload.ssh_key_id))
    key = result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=404, detail="Chiave SSH non trovata")

    assignment = SSHKeyAssignment(
        ssh_key_id=payload.ssh_key_id,
        target_type=payload.target_type,
        target_id=payload.target_id,
        target_user=payload.target_user,
        allow_source_ips=json.dumps(payload.allow_source_ips),
        assigned_by=user.username,
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
    assignment_id: uuid.UUID,
    user: User = Depends(require_permission("hub.ssh")),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(SSHKeyAssignment).where(SSHKeyAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assegnazione non trovata")
    if assignment.status == "revoked":
        raise HTTPException(status_code=400, detail="Già revocata")

    key_result = await session.execute(
        select(SSHKey).where(SSHKey.id == assignment.ssh_key_id)
    )
    key = key_result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=404, detail="Chiave SSH non trovata")

    results = await ssh_svc.revoke_assignment(session, assignment, key, requested_by=user.username)
    return {"status": "revoked", "revoke_results": results}
