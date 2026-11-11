"""
Instances API (UI): inventory, address history, commands, groups, dashboard.

Everything is limited to the caller's scope (manager.scope): an instance out of
it answers 404. Revoking and deleting instances, and the groups themselves,
are manager operations (superuser, rw).
"""
import asyncio
import json
from datetime import datetime, timedelta
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session
from core.settings.router import get_system_settings

from manager.agents import protocol
from manager.agents.dispatcher import run_command, send_ephemeral
from manager.agents.registry import registry
from manager.models import (AgentCertificate, Backup, Command, EnrollmentRequest, EnrollmentToken, Instance,
                        InstanceAddress, InstanceGroup, License, SupportSession)
from manager import groups as manager_groups, scope
from manager.registration import check_external_ref, check_labels, instance_by_ref
from .service import apply_facts, clone_suspects, resume_instance, revoke_instance, suspend_instance

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
        "build": i.build, "layout": i.layout,
        "os": i.os, "protocol": i.protocol, "protocol_revision": i.protocol_revision,
        "enrolled_at": i.enrolled_at.isoformat(),
        "backup_enabled": i.backup_enabled,
        "capabilities": dict(conn.capabilities) if conn else _json(i.capabilities_json, {}),
        "features": sorted(conn.features) if conn else _json(i.features_json, []),
        "stats": _json(i.stats_json, {}),
    }
    if detail:
        out["facts"] = _json(i.facts_json, {})
    return out


async def get_instance_or_404(session, instance_id: str, user: User) -> Instance:
    """The instance if it is in the user's scope, else 404."""
    return await scope.get_instance(session, user, instance_id)


EXPIRY_WARN_DAYS = 30
DASHBOARD_LIST = 10


def _iso(d: Optional[datetime]) -> Optional[str]:
    return d.isoformat() if d else None


@router.get("/dashboard")
async def dashboard(session: AsyncSession = Depends(get_session),
                    user: User = Depends(require_permission("scope.view"))):
    """
    What the instance list does not carry (backups, licenses, certificates,
    commands, support, enrollment), for the instances in the caller's scope.
    Online state, versions and resources come from /instances.
    """
    ids = await scope.group_ids(session, user)
    rows = (await session.execute(scope.filter_instances(select(Instance), ids))).scalars().all()
    online = registry.online_ids()
    now = datetime.utcnow()
    soon = now + timedelta(days=EXPIRY_WARN_DAYS)
    names = {i.id: i.name for i in rows}
    versions: dict = {}
    for i in rows:
        if i.status == "active":
            versions[i.madmin_version or "?"] = versions.get(i.madmin_version or "?", 0) + 1
    in_scope = [i.id for i in rows]
    active = [i for i in rows if i.status == "active"]
    failed = 0
    backups = {"count": 0, "size": 0, "last_24h": 0, "interval_hours": 0, "stale": []}
    licenses = {"active": 0, "features": {}, "expiring": []}
    certificates_expiring = []
    failed_recent = []
    if in_scope:
        failed = (await session.execute(
            select(func.count()).select_from(Command).where(
                Command.instance_id.in_(in_scope),
                Command.status.in_(("failed", "expired")),
                Command.created_at > now - timedelta(days=1),
            )
        )).scalar_one()

        # Backups: totals, and the scheduled instances whose latest backup is
        # older than two intervals (or missing)
        count, size = (await session.execute(
            select(func.count(), func.coalesce(func.sum(Backup.size), 0)).where(Backup.instance_id.in_(in_scope))
        )).one()
        backups["count"], backups["size"] = count, int(size)
        backups["last_24h"] = (await session.execute(
            select(func.count()).select_from(Backup).where(Backup.instance_id.in_(in_scope),
                                                           Backup.created_at > now - timedelta(days=1))
        )).scalar_one()
        interval = (await get_system_settings(session)).backup_interval_hours
        backups["interval_hours"] = interval
        if interval > 0:
            last = dict((await session.execute(
                select(Backup.instance_id, func.max(Backup.created_at))
                .where(Backup.instance_id.in_(in_scope)).group_by(Backup.instance_id)
            )).all())
            due = now - timedelta(hours=2 * interval)
            stale = [i for i in active if i.backup_enabled and (last.get(i.id) is None or last[i.id] < due)]
            stale.sort(key=lambda i: last.get(i.id) or datetime.min)
            backups["stale_count"] = len(stale)
            backups["stale"] = [{"id": i.id, "name": i.name, "online": i.id in online,
                                 "last_backup_at": _iso(last.get(i.id))} for i in stale[:DASHBOARD_LIST]]

        # Licenses: active ones by feature, entitlements ending soon
        lic = (await session.execute(
            select(License).where(License.instance_id.in_(in_scope), License.active == True)  # noqa: E712
        )).scalars().all()
        licenses["active"] = len(lic)
        for x in lic:
            licenses["features"][x.feature] = licenses["features"].get(x.feature, 0) + 1
        licenses["expiring"] = [
            {"id": x.id, "instance_id": x.instance_id, "instance_name": names.get(x.instance_id, ""),
             "feature": x.feature, "valid_until": _iso(x.valid_until)}
            for x in sorted((x for x in lic if x.valid_until and x.valid_until < soon), key=lambda x: x.valid_until)
        ][:DASHBOARD_LIST]

        # Agent certificates: the newest valid one of each active instance
        cert_until = dict((await session.execute(
            select(AgentCertificate.instance_id, func.max(AgentCertificate.not_after))
            .where(AgentCertificate.instance_id.in_([i.id for i in active]),
                   AgentCertificate.revoked == False)  # noqa: E712
            .group_by(AgentCertificate.instance_id)
        )).all()) if active else {}
        certificates_expiring = [
            {"id": iid, "name": names[iid], "online": iid in online, "not_after": _iso(na)}
            for iid, na in sorted(cert_until.items(), key=lambda kv: kv[1]) if na < soon
        ][:DASHBOARD_LIST]

        cmds = (await session.execute(
            select(Command).where(Command.instance_id.in_(in_scope),
                                  Command.status.in_(("failed", "expired")),
                                  Command.created_at > now - timedelta(days=7))
            .order_by(Command.created_at.desc()).limit(DASHBOARD_LIST)
        )).scalars().all()
        failed_recent = [{"id": c.id, "instance_id": c.instance_id, "instance_name": names.get(c.instance_id, ""),
                          "name": c.name, "status": c.status, "error_code": c.error_code,
                          "error": (c.error or "")[:200],
                          "created_at": _iso(c.created_at)} for c in cmds]

    out = {
        "total": len(rows),
        "active": sum(1 for i in rows if i.status == "active"),
        "online": sum(1 for i in rows if i.id in online),
        "suspended": sum(1 for i in rows if i.status == "suspended"),
        "revoked": sum(1 for i in rows if i.status in ("revoked", "decommissioned")),
        "versions": versions,
        "failed_commands_24h": failed,
        "offline": [instance_out(i) for i in rows if i.status == "active" and i.id not in online][:20],
        "backups": backups,
        "licenses": licenses,
        "certificates_expiring": certificates_expiring,
        "failed_commands": failed_recent,
    }
    if user.has_permission("manager.view"):
        # Support and enrollment are manager operations: partners and customers do not see them
        sessions = (await session.execute(
            select(SupportSession).where(SupportSession.status == "open").order_by(SupportSession.expires_at)
        )).scalars().all()
        out["open_support_sessions"] = len(sessions)
        out["support_sessions"] = [
            {"id": s.id, "instance_id": s.instance_id, "instance_name": names.get(s.instance_id, ""),
             "kind": s.kind, "operator": s.operator, "reason": s.reason, "expires_at": _iso(s.expires_at)}
            for s in sessions[:DASHBOARD_LIST]]
        out["enrollment_pending"] = (await session.execute(
            select(func.count()).select_from(EnrollmentRequest).where(
                EnrollmentRequest.status == "pending", EnrollmentRequest.expires_at > now)
        )).scalar_one()
        out["enrollment_tokens"] = (await session.execute(
            select(func.count()).select_from(EnrollmentToken).where(
                EnrollmentToken.revoked == False, EnrollmentToken.expires_at > now,  # noqa: E712
                (EnrollmentToken.max_uses == None) | (EnrollmentToken.uses < EnrollmentToken.max_uses))  # noqa: E711
        )).scalar_one()
    return out


@router.get("/instances")
async def list_instances(
    status: Optional[str] = Query(default=None, max_length=20),
    group_id: Optional[str] = Query(default=None, max_length=36),
    q: Optional[str] = Query(default=None, max_length=100),
    label: Optional[str] = Query(default=None, max_length=250, description="chiave=valore"),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(require_permission("scope.view")),
):
    query = scope.filter_instances(select(Instance).order_by(Instance.name),
                                   await scope.group_ids(session, user))
    if status:
        query = query.where(Instance.status == status)
    if group_id == "none":
        query = query.where(Instance.group_id == None)  # noqa: E711
    elif group_id:
        # A partner includes its customers
        query = query.where(Instance.group_id.in_(await manager_groups.subtree_ids(session, group_id)))
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
                       user: User = Depends(require_permission("scope.view"))):
    instance = await get_instance_or_404(session, instance_id, user)
    out = instance_out(instance, detail=True)
    # Other instances with the same machine-id may belong to anyone: manager only
    out["clone_suspects"] = await clone_suspects(session, instance) if user.has_permission("manager.view") else []
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
                          user: User = Depends(require_permission("scope.manage"))):
    instance = await get_instance_or_404(session, instance_id, user)
    data = body.model_dump(exclude_unset=True)
    if "group_id" in data:
        data["group_id"] = data["group_id"] or None  # "" = no group
        if data["group_id"] != instance.group_id:
            # Only inside the caller's scope; "no group" only for superusers
            await scope.check_group(session, user, data["group_id"])
    if "labels" in data:
        instance.labels_json = json.dumps(data.pop("labels") or {})
    if "external_ref" in data:
        # The provisioning system's reference: set by the manager operator only
        ref_in = data.pop("external_ref")
        try:
            ref = check_external_ref(ref_in)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if ref != instance.external_ref:
            if not user.has_permission("manager.manage"):
                raise HTTPException(403, "Solo un superuser può cambiare il riferimento esterno")
            if ref:
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
                           user: User = Depends(require_permission("scope.manage"))):
    # Sends a command to the instance: not for read-only users
    instance = await get_instance_or_404(session, instance_id, user)
    data = await run_command(session, instance.id, protocol.CMD_INVENTORY, {}, operator=user.username)
    if isinstance(data.get("facts"), dict):
        apply_facts(instance, data["facts"])
        from .service import record_addresses
        await record_addresses(session, instance, None, data["facts"])
        session.add(instance)
        await session.commit()
    return instance_out(instance, detail=True)


STATS_TIMEOUT = 20


@router.get("/instances/{instance_id}/stats")
async def stats_history(instance_id: str, hours: int = Query(default=1, ge=1, le=24),
                        session: AsyncSession = Depends(get_session),
                        user: User = Depends(require_permission("scope.view"))):
    """
    CPU, RAM, disk and per-interface traffic of the last `hours`, asked to the
    instance (it keeps 24 hours, one sample a minute). Read only and not stored:
    an ephemeral command, so opening the page does not fill the command log.
    When the history cannot be had, `available` is false and `reason` says why
    (offline | unsupported | timeout | error) for the page to explain.
    """
    instance = await get_instance_or_404(session, instance_id, user)
    conn = registry.get(instance.id)
    if conn is None:
        return {"available": False, "reason": "offline"}
    if protocol.CMD_STATS_HISTORY not in conn.capabilities:
        return {"available": False, "reason": "unsupported"}
    try:
        fut = await send_ephemeral(instance.id, protocol.CMD_STATS_HISTORY, {"hours": hours},
                                   operator=user.username, ttl=STATS_TIMEOUT)
        result = await asyncio.wait_for(fut, STATS_TIMEOUT)
    except ConnectionError:
        return {"available": False, "reason": "offline"}
    except asyncio.TimeoutError:
        return {"available": False, "reason": "timeout"}
    if not result.get("ok"):
        return {"available": False, "reason": "error", "error": protocol.error_parts(result)[1][:300]}
    return {"available": True, **(result.get("data") or {})}


@router.post("/instances/{instance_id}/revoke")
async def revoke(instance_id: str, session: AsyncSession = Depends(get_session),
                 user: User = Depends(require_permission("manager.manage"))):
    instance = await get_instance_or_404(session, instance_id, user)
    if instance.status in ("active", "suspended"):
        await revoke_instance(session, instance, by=user.username)
    return instance_out(instance)


@router.post("/instances/{instance_id}/suspend")
async def suspend(instance_id: str, session: AsyncSession = Depends(get_session),
                  user: User = Depends(require_permission("manager.manage"))):
    instance = await get_instance_or_404(session, instance_id, user)
    if instance.status != "active":
        raise HTTPException(409, "Solo un'istanza attiva può essere sospesa")
    await suspend_instance(session, instance, by=user.username)
    return instance_out(instance)


@router.post("/instances/{instance_id}/resume")
async def resume(instance_id: str, session: AsyncSession = Depends(get_session),
                 user: User = Depends(require_permission("manager.manage"))):
    instance = await get_instance_or_404(session, instance_id, user)
    if instance.status != "suspended":
        raise HTTPException(409, "L'istanza non è sospesa")
    await resume_instance(session, instance, by=user.username)
    return instance_out(instance)


@router.delete("/instances/{instance_id}", status_code=204)
async def delete_instance(instance_id: str, session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("manager.manage"))):
    instance = await get_instance_or_404(session, instance_id, user)
    if instance.status in ("active", "suspended"):
        raise HTTPException(409, "Revocare l'istanza prima di eliminarla")
    from manager.backups.service import delete_instance_backups
    await delete_instance_backups(session, instance.id)
    # Every table with a foreign key to instance.id (enrollment requests: the
    # approved one that created it, history only once the instance is gone)
    for model in (InstanceAddress, AgentCertificate, Command, License, SupportSession, EnrollmentRequest):
        await session.execute(delete(model).where(model.instance_id == instance.id))
    await session.execute(delete(EnrollmentToken).where(EnrollmentToken.reenroll_instance_id == instance.id))
    await session.delete(instance)
    await session.commit()


@router.get("/instances/{instance_id}/addresses")
async def addresses(instance_id: str, session: AsyncSession = Depends(get_session),
                    user: User = Depends(require_permission("scope.view"))):
    await get_instance_or_404(session, instance_id, user)
    rows = (await session.execute(
        select(InstanceAddress).where(InstanceAddress.instance_id == instance_id)
        .order_by(InstanceAddress.current.desc(), InstanceAddress.last_seen.desc())
    )).scalars().all()
    return [r.model_dump() for r in rows]


@router.get("/instances/{instance_id}/commands")
async def commands(instance_id: str, limit: int = Query(default=50, ge=1, le=500),
                   session: AsyncSession = Depends(get_session),
                   user: User = Depends(require_permission("scope.view"))):
    await get_instance_or_404(session, instance_id, user)
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
                      user: User = Depends(require_permission("scope.view"))):
    """The groups in the caller's scope (a partner: itself and its customers)."""
    groups = await manager_groups.all_groups(session)
    paths = manager_groups.paths(groups)  # from every group: a customer's path names its partner
    ids = await scope.group_ids(session, user)
    if ids is not None:
        groups = [g for g in groups if g.id in ids]
    counts = dict((await session.execute(
        select(Instance.group_id, func.count()).where(Instance.status == "active").group_by(Instance.group_id)
    )).all())
    # Partners first, each followed by its customers
    return sorted((group_out(g, paths, counts) for g in groups), key=lambda d: d["path"].lower())


@router.post("/groups", status_code=201)
async def create_group(body: GroupIn, session: AsyncSession = Depends(get_session),
                       user: User = Depends(require_permission("manager.manage"))):
    group = await manager_groups.create_group(session, body.name.strip(), body.kind, body.parent_id or None,
                                          body.description)
    await session.commit()
    groups = await manager_groups.all_groups(session)
    return group_out(group, manager_groups.paths(groups), {})


@router.patch("/groups/{group_id}")
async def update_group(group_id: str, body: GroupUpdate, session: AsyncSession = Depends(get_session),
                       user: User = Depends(require_permission("manager.manage"))):
    group = await session.get(InstanceGroup, group_id)
    if group is None:
        raise HTTPException(404, "Gruppo non trovato")
    if body.name and body.name.strip() != group.name:
        if await manager_groups.find_child(session, body.name.strip(), group.parent_id):
            raise HTTPException(409, "Esiste già un gruppo con questo nome in questa posizione")
        group.name = body.name.strip()
    if body.description is not None:
        group.description = body.description
    session.add(group)
    await session.commit()
    return group.model_dump()


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(group_id: str, session: AsyncSession = Depends(get_session),
                       user: User = Depends(require_permission("manager.manage"))):
    group = await session.get(InstanceGroup, group_id)
    if group is None:
        raise HTTPException(404, "Gruppo non trovato")
    used = (await session.execute(select(Instance.id).where(Instance.group_id == group_id).limit(1))).first()
    if used:
        raise HTTPException(409, "Gruppo in uso da almeno un'istanza")
    child = (await session.execute(select(InstanceGroup.id).where(InstanceGroup.parent_id == group_id).limit(1))).first()
    if child:
        raise HTTPException(409, "Il partner ha ancora dei clienti")
    members = (await session.execute(select(User.id).where(User.group_id == group_id).limit(1))).first()
    if members:
        raise HTTPException(409, "Gruppo assegnato ad almeno un utente: spostarlo o eliminarlo prima")
    await session.execute(update(EnrollmentToken).where(EnrollmentToken.group_id == group_id)
                          .values(group_id=None))
    await session.delete(group)
    await session.commit()
