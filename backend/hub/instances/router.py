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
from .models import EnrollmentToken, InstanceGroup, ManagedInstance, Tag

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
    return await inst_svc.instance_to_dict_full(session, i)


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


class InstanceTagsSet(BaseModel):
    tag_names: List[str]


@router.put("/api/instances/{instance_id}/tags")
async def set_instance_tags(
    request: Request,
    instance_id: uuid.UUID,
    payload: InstanceTagsSet,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    i = await inst_svc.get_instance(session, instance_id)
    if not i:
        raise HTTPException(status_code=404, detail=tr("instance_not_found", lang))
    tags = await inst_svc.set_instance_tags(session, instance_id, payload.tag_names)
    return {"tags": tags}


@router.delete("/api/instances/{instance_id}")
async def delete_instance(
    request: Request,
    instance_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
    purge: bool = False,
):
    from hub.ws.manager import ws_manager

    lang = get_lang(request)
    i = await inst_svc.get_instance(session, instance_id)
    if not i:
        raise HTTPException(status_code=404, detail=tr("instance_not_found", lang))

    # Close WS if connected
    ws = ws_manager.get(instance_id)
    if ws:
        try:
            await ws.close(code=1000)
        except Exception:
            pass
        ws_manager.unregister(instance_id)

    if purge:
        if i.enrollment_status != "revoked":
            raise HTTPException(status_code=400, detail="Revoca l'istanza prima di eliminarla definitivamente")
        await session.delete(i)
        await session.flush()
        return {"detail": "Istanza eliminata definitivamente"}
    # Soft revoke
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
    return await inst_svc.list_groups(session)


@router.post("/api/groups")
async def create_group(
    payload: GroupCreate,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    g = await inst_svc.create_group(session, payload.name, payload.description, payload.color)
    return inst_svc.group_to_dict(g, 0)


class GroupPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None


@router.get("/api/groups/{group_id}")
async def get_group_detail(
    request: Request,
    group_id: uuid.UUID,
    user: User = Depends(require_permission("hub.view")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    g = await inst_svc.get_group(session, group_id)
    if not g:
        raise HTTPException(status_code=404, detail=tr("group_not_found", lang))
    members = await inst_svc.list_instances(session, group_id=group_id)
    return {
        **inst_svc.group_to_dict(g, len(members)),
        "instances": [inst_svc.instance_to_dict(i) for i in members],
    }


@router.patch("/api/groups/{group_id}")
async def patch_group(
    request: Request,
    group_id: uuid.UUID,
    payload: GroupPatch,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    g = await inst_svc.get_group(session, group_id)
    if not g:
        raise HTTPException(status_code=404, detail=tr("group_not_found", lang))
    for k, v in payload.dict(exclude_unset=True).items():
        setattr(g, k, v)
    session.add(g)
    return inst_svc.group_to_dict(g)


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
    name: Optional[str] = None
    token_type: str = "one_time"  # one_time | reusable
    max_uses: int = 1
    target_group_id: Optional[uuid.UUID] = None
    default_tags: List[str] = []
    ttl_minutes: Optional[int] = None  # overrides system default if set


def _token_to_dict(t: EnrollmentToken) -> dict:
    now = datetime.utcnow()
    is_revoked = t.revoked_at is not None
    is_expired = t.expires_at < now
    if t.token_type == "reusable":
        is_used = t.use_count >= t.max_uses
    else:
        is_used = t.used_at is not None
    if is_revoked:
        status = "revoked"
    elif is_expired:
        status = "expired"
    elif is_used:
        status = "used"
    else:
        status = "valid"
    return {
        "id": str(t.id),
        "name": t.name,
        "token_type": t.token_type,
        "max_uses": t.max_uses,
        "use_count": t.use_count,
        "expires_at": t.expires_at.isoformat(),
        "used_at": t.used_at.isoformat() if t.used_at else None,
        "used_by_instance_id": str(t.used_by_instance_id) if t.used_by_instance_id else None,
        "target_group_id": str(t.target_group_id) if t.target_group_id else None,
        "default_tags": json.loads(t.default_tags or "[]"),
        "created_by": t.created_by,
        "created_at": t.created_at.isoformat(),
        "revoked_at": t.revoked_at.isoformat() if t.revoked_at else None,
        "is_used": is_used,
        "is_expired": is_expired,
        "is_revoked": is_revoked,
        "status": status,
    }


@router.get("/api/enrollment/tokens")
async def list_enrollment_tokens(
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(EnrollmentToken).order_by(EnrollmentToken.created_at.desc()).limit(100)
    )
    items = result.scalars().all()
    return [_token_to_dict(t) for t in items]


@router.post("/api/enrollment/tokens")
async def create_enrollment_token(
    request: Request,
    payload: EnrollmentTokenCreate,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    from core.settings.models import SystemSettings
    res = await session.execute(select(SystemSettings).where(SystemSettings.id == 1))
    sys_settings = res.scalar_one_or_none()
    hub_url = (sys_settings.hub_url if sys_settings else None) or ""
    if not hub_url.strip():
        raise HTTPException(status_code=400, detail="hub_url_not_set")

    ttl = payload.ttl_minutes
    if ttl is None or ttl <= 0:
        ttl = sys_settings.default_token_ttl_minutes if sys_settings else 15

    if payload.token_type not in ("one_time", "reusable"):
        raise HTTPException(status_code=400, detail="invalid_token_type")

    try:
        raw, record = await enroll_svc.create_enrollment_token(
            session,
            target_group_id=payload.target_group_id,
            default_tags=payload.default_tags,
            created_by=user.username,
            name=payload.name,
            token_type=payload.token_type,
            max_uses=payload.max_uses,
            ttl_minutes=ttl,
            hub_url=hub_url.rstrip("/"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "token": raw,  # shown ONCE
        **_token_to_dict(record),
        "hub_url": hub_url.rstrip("/"),
        "install_command": (
            f"curl -fsSL {hub_url.rstrip('/')}/install.sh | sudo bash -s -- "
            f"--token {raw}"
        ),
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
    if t.revoked_at is None:
        t.revoked_at = datetime.utcnow()
        session.add(t)
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
    from core.settings.models import SystemSettings

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

    # Prefer hub_url from SystemSettings (set by admin in UI); fall back to env
    res = await session.execute(select(SystemSettings).where(SystemSettings.id == 1))
    sys_settings = res.scalar_one_or_none()
    base_url = (sys_settings.hub_url if sys_settings and sys_settings.hub_url else None) or settings.hub_public_url
    ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = f"{ws_url.rstrip('/')}/api/agents/ws"
    return AgentEnrollResponse(
        instance_id=instance.id,
        agent_token=agent_token,
        ws_url=ws_url,
        heartbeat_interval_seconds=settings.heartbeat_interval_seconds,
    )


# --- Tags ---

class TagCreate(BaseModel):
    name: str
    color: str = "#6c757d"
    description: Optional[str] = None


class TagPatch(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    description: Optional[str] = None


@router.get("/api/tags")
async def list_tags(
    user: User = Depends(require_permission("hub.view")),
    session: AsyncSession = Depends(get_session),
):
    return await inst_svc.list_tags(session)


@router.post("/api/tags")
async def create_tag(
    payload: TagCreate,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    tag = await inst_svc.create_tag(session, payload.name, payload.color, payload.description)
    return {"id": str(tag.id), "name": tag.name, "color": tag.color, "description": tag.description}


@router.patch("/api/tags/{tag_id}")
async def patch_tag(
    request: Request,
    tag_id: uuid.UUID,
    payload: TagPatch,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    tag = await inst_svc.update_tag(session, tag_id, **payload.dict(exclude_unset=True))
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    return {"id": str(tag.id), "name": tag.name, "color": tag.color, "description": tag.description}


@router.delete("/api/tags/{tag_id}")
async def delete_tag(
    tag_id: uuid.UUID,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    ok = await inst_svc.delete_tag(session, tag_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Tag not found")
    return {"detail": "deleted"}


# --- Bulk operations ---

class BulkUpdate(BaseModel):
    instance_ids: List[uuid.UUID]
    action: str  # set_group | add_tag | remove_tag | revoke
    value: Optional[str] = None  # group UUID, tag string, or None for revoke


@router.post("/api/instances/bulk")
async def bulk_update(
    request: Request,
    payload: BulkUpdate,
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    valid_actions = {"set_group", "add_tag", "remove_tag", "revoke"}
    if payload.action not in valid_actions:
        raise HTTPException(status_code=400, detail=tr("invalid_bulk_action", lang))
    try:
        results = await inst_svc.bulk_update_instances(
            session, payload.instance_ids, payload.action, payload.value
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"detail": tr("bulk_done", lang), **results}
