"""
Instances API (UI): inventory, address history, commands, groups, dashboard.
"""
import json
from datetime import datetime, timedelta
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import get_current_user, require_permission
from core.auth.models import User
from core.database import get_session

from hub.agents import protocol
from hub.agents.dispatcher import run_command
from hub.agents.registry import registry
from hub.models import (AgentCertificate, Backup, Command, EnrollmentToken, Instance,
                        InstanceAddress, InstanceGroup, License, SupportSession)
from hub import groups as hub_groups
from hub.registration import check_external_ref, check_labels, instance_by_ref
from .service import apply_facts, clone_suspects, revoke_instance

router = APIRouter(prefix="/api", tags=["Instances"])


def _json(raw: str, default):
    try:
        return json.loads(raw) if raw else default
    except ValueError:
        return default


def instance_out(i: Instance, detail: bool = False) -> dict:
    conn = registry.get(i.id)
    out = {
        "id": i.id, "name": i.name, "description": i.description, "group_id": i.group_id,
        "labels": _json(i.labels_json, {}), "external_ref": i.external_ref,
        "status": i.status, "online": conn is not None,
        "connected_at": conn.connected_at.isoformat() if conn else None,
        "last_seen_at": i.last_seen_at.isoformat() if i.last_seen_at else None,
        "last_ip": i.last_ip, "hostname": i.hostname, "madmin_version": i.madmin_version,
        "os": i.os, "protocol": i.protocol, "enrolled_at": i.enrolled_at.isoformat(),
        "backup_enabled": i.backup_enabled,
        "capabilities": sorted(conn.capabilities) if conn else _json(i.capabilities_json, []),
        "stats": _json(i.stats_json, {}),
    }
    if detail:
        out["facts"] = _json(i.facts_json, {})
    return out


async def get_instance_or_404(session, instance_id: str) -> Instance:
    instance = await session.get(Instance, instance_id)
    if instance is None:
        raise HTTPException(404, "Istanza non trovata")
    return instance


@router.get("/dashboard")
async def dashboard(session: AsyncSession = Depends(get_session),
                    user: User = Depends(require_permission("instances.view"))):
    rows = (await session.execute(select(Instance))).scalars().all()
    online = registry.online_ids()
    versions: dict = {}
    for i in rows:
        if i.status == "active":
            versions[i.madmin_version or "?"] = versions.get(i.madmin_version or "?", 0) + 1
    open_sessions = (await session.execute(
        select(func.count()).select_from(SupportSession).where(SupportSession.status == "open")
    )).scalar_one()
    failed = (await session.execute(
        select(func.count()).select_from(Command).where(
            Command.status.in_(("failed", "expired")),
            Command.created_at > datetime.utcnow() - timedelta(days=1),
        )
    )).scalar_one()
    return {
        "total": len(rows),
        "active": sum(1 for i in rows if i.status == "active"),
        "online": sum(1 for i in rows if i.id in online),
        "revoked": sum(1 for i in rows if i.status != "active"),
        "versions": versions,
        "open_support_sessions": open_sessions,
        "failed_commands_24h": failed,
        "offline": [instance_out(i) for i in rows if i.status == "active" and i.id not in online][:20],
    }


@router.get("/instances")
async def list_instances(
    status: Optional[str] = Query(default=None, max_length=20),
    group_id: Optional[str] = Query(default=None, max_length=36),
    q: Optional[str] = Query(default=None, max_length=100),
    label: Optional[str] = Query(default=None, max_length=250, description="chiave=valore"),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(require_permission("instances.view")),
):
    query = select(Instance).order_by(Instance.name)
    if status:
        query = query.where(Instance.status == status)
    if group_id == "none":
        query = query.where(Instance.group_id == None)  # noqa: E711
    elif group_id:
        # A partner includes its customers
        query = query.where(Instance.group_id.in_(await hub_groups.subtree_ids(session, group_id)))
    if q:
        like = f"%{q.lower()}%"
        query = query.where(func.lower(Instance.name).like(like) | func.lower(Instance.hostname).like(like)
                            | Instance.last_ip.like(like) | Instance.id.like(like)
                            | func.lower(Instance.external_ref).like(like)
                            | func.lower(Instance.labels_json).like(like))
    rows = (await session.execute(query)).scalars().all()
    if label:
        k, _, v = label.partition("=")
        rows = [i for i in rows if _json(i.labels_json, {}).get(k.strip().lower()) == v.strip()]
    return [instance_out(i) for i in rows]


@router.get("/instances/{instance_id}")
async def get_instance(instance_id: str, session: AsyncSession = Depends(get_session),
                       user: User = Depends(require_permission("instances.view"))):
    instance = await get_instance_or_404(session, instance_id)
    out = instance_out(instance, detail=True)
    out["clone_suspects"] = await clone_suspects(session, instance)
    cert = (await session.execute(
        select(AgentCertificate).where(AgentCertificate.instance_id == instance.id,
                                       AgentCertificate.revoked == False)  # noqa: E712
        .order_by(AgentCertificate.not_after.desc()).limit(1)
    )).scalar_one_or_none()
    out["certificate_expires_at"] = cert.not_after.isoformat() if cert else None
    return out


class InstanceUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=500)
    group_id: Optional[str] = Field(default=None, max_length=36)
    backup_enabled: Optional[bool] = None
    labels: Optional[Dict[str, str]] = None      # replaces all labels
    external_ref: Optional[str] = None           # "" = none

    @field_validator("labels")
    @classmethod
    def _labels(cls, v):
        return None if v is None else check_labels(v)


@router.patch("/instances/{instance_id}")
async def update_instance(instance_id: str, body: InstanceUpdate,
                          session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("instances.manage"))):
    instance = await get_instance_or_404(session, instance_id)
    data = body.model_dump(exclude_unset=True)
    if "group_id" in data and data["group_id"]:
        if await session.get(InstanceGroup, data["group_id"]) is None:
            raise HTTPException(400, "Gruppo inesistente")
    if data.get("group_id") == "":
        data["group_id"] = None  # "" = no group
    if "labels" in data:
        instance.labels_json = json.dumps(data.pop("labels") or {})
    if "external_ref" in data:
        try:
            ref = check_external_ref(data.pop("external_ref"))
        except ValueError as e:
            raise HTTPException(400, str(e))
        if ref and ref != instance.external_ref:
            other = await instance_by_ref(session, ref)
            if other is not None and other.id != instance.id:
                raise HTTPException(409, f"Riferimento esterno già usato dall'istanza {other.name}")
        instance.external_ref = ref
    for k, v in data.items():
        setattr(instance, k, v)
    session.add(instance)
    await session.commit()
    return instance_out(instance, detail=True)


@router.post("/instances/{instance_id}/refresh")
async def refresh_instance(instance_id: str, session: AsyncSession = Depends(get_session),
                           user: User = Depends(require_permission("instances.view"))):
    instance = await get_instance_or_404(session, instance_id)
    data = await run_command(session, instance.id, protocol.CMD_INVENTORY, {}, operator=user.username)
    if isinstance(data.get("facts"), dict):
        apply_facts(instance, data["facts"])
        from .service import record_addresses
        await record_addresses(session, instance, None, data["facts"])
        session.add(instance)
        await session.commit()
    return instance_out(instance, detail=True)


@router.post("/instances/{instance_id}/revoke")
async def revoke(instance_id: str, session: AsyncSession = Depends(get_session),
                 user: User = Depends(require_permission("instances.manage"))):
    instance = await get_instance_or_404(session, instance_id)
    if instance.status == "active":
        await revoke_instance(session, instance, by=user.username)
    return instance_out(instance)


@router.delete("/instances/{instance_id}", status_code=204)
async def delete_instance(instance_id: str, session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("instances.manage"))):
    instance = await get_instance_or_404(session, instance_id)
    if instance.status == "active":
        raise HTTPException(409, "Revocare l'istanza prima di eliminarla")
    from hub.backups.service import delete_instance_backups
    await delete_instance_backups(session, instance.id)
    for model in (InstanceAddress, AgentCertificate, Command, License, SupportSession):
        await session.execute(delete(model).where(model.instance_id == instance.id))
    await session.execute(delete(EnrollmentToken).where(EnrollmentToken.reenroll_instance_id == instance.id))
    await session.delete(instance)
    await session.commit()


@router.get("/instances/{instance_id}/addresses")
async def addresses(instance_id: str, session: AsyncSession = Depends(get_session),
                    user: User = Depends(require_permission("instances.view"))):
    rows = (await session.execute(
        select(InstanceAddress).where(InstanceAddress.instance_id == instance_id)
        .order_by(InstanceAddress.current.desc(), InstanceAddress.last_seen.desc())
    )).scalars().all()
    return [r.model_dump() for r in rows]


@router.get("/instances/{instance_id}/commands")
async def commands(instance_id: str, limit: int = Query(default=50, ge=1, le=500),
                   session: AsyncSession = Depends(get_session),
                   user: User = Depends(require_permission("instances.view"))):
    rows = (await session.execute(
        select(Command).where(Command.instance_id == instance_id)
        .order_by(Command.created_at.desc()).limit(limit)
    )).scalars().all()
    out = []
    for c in rows:
        d = c.model_dump()
        d["args"] = _json(d.pop("args_json"), {})
        d["result"] = _json(d.pop("result_json") or "", None)
        # Licenses travel as commands: the token is not for display
        if c.name == protocol.CMD_LICENSE_INSTALL:
            d["args"] = {"token": "***"}
        out.append(d)
    return out


# --- Groups ---

class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: str = Field(default="customer", pattern=r"^(partner|customer)$")
    parent_id: Optional[str] = Field(default=None, max_length=36)
    description: str = Field(default="", max_length=500)


class GroupUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=500)


def group_out(g: InstanceGroup, paths: dict, counts: dict) -> dict:
    return {**g.model_dump(), "path": paths.get(g.id, g.name), "instances": counts.get(g.id, 0)}


@router.get("/groups")
async def list_groups(session: AsyncSession = Depends(get_session),
                      user: User = Depends(get_current_user)):
    groups = await hub_groups.all_groups(session)
    paths = hub_groups.paths(groups)
    counts = dict((await session.execute(
        select(Instance.group_id, func.count()).where(Instance.status == "active").group_by(Instance.group_id)
    )).all())
    # Partners first, each followed by its customers
    return sorted((group_out(g, paths, counts) for g in groups), key=lambda d: d["path"].lower())


@router.post("/groups", status_code=201)
async def create_group(body: GroupIn, session: AsyncSession = Depends(get_session),
                       user: User = Depends(require_permission("instances.manage"))):
    group = await hub_groups.create_group(session, body.name.strip(), body.kind, body.parent_id or None,
                                          body.description)
    await session.commit()
    groups = await hub_groups.all_groups(session)
    return group_out(group, hub_groups.paths(groups), {})


@router.patch("/groups/{group_id}")
async def update_group(group_id: str, body: GroupUpdate, session: AsyncSession = Depends(get_session),
                       user: User = Depends(require_permission("instances.manage"))):
    group = await session.get(InstanceGroup, group_id)
    if group is None:
        raise HTTPException(404, "Gruppo non trovato")
    if body.name and body.name.strip() != group.name:
        if await hub_groups.find_child(session, body.name.strip(), group.parent_id):
            raise HTTPException(409, "Esiste già un gruppo con questo nome in questa posizione")
        group.name = body.name.strip()
    if body.description is not None:
        group.description = body.description
    session.add(group)
    await session.commit()
    return group.model_dump()


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(group_id: str, session: AsyncSession = Depends(get_session),
                       user: User = Depends(require_permission("instances.manage"))):
    group = await session.get(InstanceGroup, group_id)
    if group is None:
        raise HTTPException(404, "Gruppo non trovato")
    used = (await session.execute(select(Instance.id).where(Instance.group_id == group_id).limit(1))).first()
    if used:
        raise HTTPException(409, "Gruppo in uso da almeno un'istanza")
    child = (await session.execute(select(InstanceGroup.id).where(InstanceGroup.parent_id == group_id).limit(1))).first()
    if child:
        raise HTTPException(409, "Il partner ha ancora dei clienti")
    await session.execute(update(EnrollmentToken).where(EnrollmentToken.group_id == group_id)
                          .values(group_id=None))
    await session.delete(group)
    await session.commit()
