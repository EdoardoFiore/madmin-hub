"""
Instances router: registry CRUD, groups, enrollment tokens, agent enrollment endpoint.
"""
import json
import logging
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import get_current_user, require_permission
from core.auth.models import User
from core.database import get_session
from core.i18n import get_lang, tr

from . import enrollment as enroll_svc
from . import service as inst_svc
from .models import EnrollmentToken, InstanceGroup, ManagedInstance

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Instances"])


# --- Instances ---

class InstancePatch(BaseModel):
    name: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[List[str]] = None
    group_id: Optional[uuid.UUID] = None


@router.get("/api/instances")
async def list_instances(
    user: User = Depends(require_permission("hub.view")),
    session: AsyncSession = Depends(get_session),
    group_id: Optional[uuid.UUID] = None,
    tag: Optional[str] = None,
):
    items = await inst_svc.list_instances(session, group_id=group_id, tag=tag)
    return [inst_svc.instance_to_dict(i) for i in items]


@router.get("/api/instances/{instance_id}")
async def get_instance(
    request: Request,
    instance_id: uuid.UUID,
    user: User = Depends(require_permission("hub.view")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    i = await inst_svc.get_instance(session, instance_id)
    if not i:
        raise HTTPException(status_code=404, detail=tr("instance_not_found", lang))
    return inst_svc.instance_to_dict(i)


@router.patch("/api/instances/{instance_id}")
async def patch_instance(
    request: Request,
    instance_id: uuid.UUID,
    payload: InstancePatch,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    i = await inst_svc.get_instance(session, instance_id)
    if not i:
        raise HTTPException(status_code=404, detail=tr("instance_not_found", lang))
    data = payload.dict(exclude_unset=True)
    if "tags" in data:
        i.tags = json.dumps(data.pop("tags"))
    for k, v in data.items():
        setattr(i, k, v)
    i.updated_at = datetime.utcnow()
    session.add(i)
    return inst_svc.instance_to_dict(i)


@router.delete("/api/instances/{instance_id}")
async def delete_instance(
    request: Request,
    instance_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    i = await inst_svc.get_instance(session, instance_id)
    if not i:
        raise HTTPException(status_code=404, detail=tr("instance_not_found", lang))
    # Mark revoked instead of hard delete to preserve audit trail
    i.enrollment_status = "revoked"
    i.ws_connected = False
    session.add(i)
    return {"detail": tr("instance_revoked", lang)}


# --- Groups ---

class GroupCreate(BaseModel):
    name: str
    description: Optional[str] = None
    color: str = "#206bc4"


@router.get("/api/groups")
async def list_groups(
    user: User = Depends(require_permission("hub.view")),
    session: AsyncSession = Depends(get_session),
):
    groups = await inst_svc.list_groups(session)
    return groups


@router.post("/api/groups")
async def create_group(
    payload: GroupCreate,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    g = await inst_svc.create_group(session, payload.name, payload.description, payload.color)
    return g


@router.delete("/api/groups/{group_id}")
async def delete_group(
    request: Request,
    group_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    result = await session.execute(select(InstanceGroup).where(InstanceGroup.id == group_id))
    g = result.scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail=tr("group_not_found", lang))
    # Detach instances from this group
    instances = await inst_svc.list_instances(session, group_id=group_id)
    for i in instances:
        i.group_id = None
        session.add(i)
    await session.delete(g)
    return {"detail": tr("group_deleted", lang)}


# --- Enrollment tokens ---

class EnrollmentTokenCreate(BaseModel):
    target_group_id: Optional[uuid.UUID] = None
    default_tags: List[str] = []


@router.get("/api/enrollment/tokens")
async def list_enrollment_tokens(
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(EnrollmentToken).order_by(EnrollmentToken.created_at.desc()).limit(100)
    )
    items = result.scalars().all()
    out = []
    for t in items:
        out.append(
            {
                "id": str(t.id),
                "expires_at": t.expires_at.isoformat(),
                "used_at": t.used_at.isoformat() if t.used_at else None,
                "used_by_instance_id": str(t.used_by_instance_id) if t.used_by_instance_id else None,
                "target_group_id": str(t.target_group_id) if t.target_group_id else None,
                "default_tags": json.loads(t.default_tags or "[]"),
                "created_by": t.created_by,
                "created_at": t.created_at.isoformat(),
                "is_used": t.used_at is not None,
                "is_expired": t.expires_at < datetime.utcnow(),
            }
        )
    return out


@router.post("/api/enrollment/tokens")
async def create_enrollment_token(
    payload: EnrollmentTokenCreate,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    raw, record = await enroll_svc.create_enrollment_token(
        session,
        target_group_id=payload.target_group_id,
        default_tags=payload.default_tags,
        created_by=user.username,
    )
    return {
        "token": raw,  # shown ONCE
        "id": str(record.id),
        "expires_at": record.expires_at.isoformat(),
    }


@router.delete("/api/enrollment/tokens/{token_id}")
async def revoke_enrollment_token(
    request: Request,
    token_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    result = await session.execute(select(EnrollmentToken).where(EnrollmentToken.id == token_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail=tr("token_not_found", lang))
    await session.delete(t)
    return {"detail": tr("token_revoked", lang)}


# --- Agent enrollment endpoint (called by agent on remote instance) ---

class AgentEnrollPayload(BaseModel):
    enrollment_token: str
    name: str
    fingerprint: str
    version: Optional[str] = None
    os_info: dict = {}


class AgentEnrollResponse(BaseModel):
    instance_id: uuid.UUID
    agent_token: str  # long-lived, returned ONCE
    ws_url: str
    heartbeat_interval_seconds: int


@router.post("/api/agents/enroll", response_model=AgentEnrollResponse)
async def agent_enroll(
    payload: AgentEnrollPayload,
    session: AsyncSession = Depends(get_session),
):
    """Public endpoint (auth via one-time enrollment token in payload)."""
    from config import get_settings

    settings = get_settings()
    try:
        instance, agent_token = await enroll_svc.enroll_instance(
            session,
            enrollment_token_raw=payload.enrollment_token,
            name=payload.name,
            fingerprint=payload.fingerprint,
            version=payload.version,
            os_info=payload.os_info,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    ws_url = settings.hub_public_url.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = f"{ws_url.rstrip('/')}/api/agents/ws"
    return AgentEnrollResponse(
        instance_id=instance.id,
        agent_token=agent_token,
        ws_url=ws_url,
        heartbeat_interval_seconds=settings.heartbeat_interval_seconds,
    )
