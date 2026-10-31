"""
Provisioning API (/api/provisioning/*): for the system that creates the
instances, authenticated with an API key (hub.apikeys), never with a UI
session. Documented in docs/API.md.

Instances are addressed by the provisioning system's own id (external_ref),
which makes token creation idempotent: a token asked for an external_ref that
already belongs to a live instance is a re-enroll token for it, so a
reinstall keeps identity, backups and licenses.
"""
import ipaddress
import json
from datetime import datetime, timedelta
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.database import get_session

from hub import groups as hub_groups
from hub.agents import protocol
from hub.agents.dispatcher import check_capability, queue_command
from hub.apikeys.service import ApiPrincipal, require_scope
from hub.instances.router import instance_out
from hub.instances.service import revoke_instance
from hub.licenses import service as license_service
from hub.models import Instance, License
from hub.registration import RegistrationFields, check_external_ref, check_labels, instance_by_ref
from hub.enrollment.service import create_token

router = APIRouter(prefix="/api/provisioning", tags=["Provisioning"])


class ProvisioningToken(BaseModel):
    """Every field optional: an empty body gives a plain single-use token."""
    name: Optional[str] = Field(default=None, max_length=100)
    partner: Optional[str] = Field(default=None, max_length=100)
    customer: Optional[str] = Field(default=None, max_length=100)
    create_groups: bool = False
    labels: Dict[str, str] = Field(default_factory=dict)
    external_ref: Optional[str] = None
    bind_ip: Optional[str] = Field(default=None, max_length=45)
    hours: int = Field(default=2, ge=1, le=24)
    description: str = Field(default="", max_length=200)

    @field_validator("labels")
    @classmethod
    def _labels(cls, v):
        return check_labels(v)

    @field_validator("external_ref")
    @classmethod
    def _ref(cls, v):
        return check_external_ref(v)

    @field_validator("bind_ip")
    @classmethod
    def _ip(cls, v):
        if v:
            ipaddress.ip_address(v)
        return v or None


@router.post("/tokens", status_code=201)
async def provisioning_token(body: ProvisioningToken, session: AsyncSession = Depends(get_session),
                             key: ApiPrincipal = Depends(require_scope("provisioning.enroll"))):
    if body.create_groups and "groups.create" not in key.scopes:
        raise HTTPException(403, "Scope mancante: groups.create")
    group_id = await hub_groups.resolve(session, body.partner, body.customer, create=body.create_groups)
    existing = await instance_by_ref(session, body.external_ref) if body.external_ref else None
    fields = RegistrationFields(name=body.name, group_id=group_id, labels=body.labels,
                                external_ref=body.external_ref)
    # Single use: one machine, one token
    return await create_token(
        session, key.username, body.description or (body.external_ref or ""), body.hours, 1, fields,
        reenroll_instance_id=existing.id if existing else None, bind_ip=body.bind_ip,
    )


def _out(i: Instance, paths: dict) -> dict:
    d = instance_out(i)
    d["external_ref"] = i.external_ref
    d["labels"] = json.loads(i.labels_json or "{}")
    d["group_path"] = paths.get(i.group_id) if i.group_id else None
    return d


@router.get("/instances")
async def list_instances(
    partner: Optional[str] = Query(default=None, max_length=100),
    customer: Optional[str] = Query(default=None, max_length=100),
    label: Optional[str] = Query(default=None, max_length=250, description="chiave=valore"),
    status: Optional[str] = Query(default=None, max_length=20),
    session: AsyncSession = Depends(get_session),
    key: ApiPrincipal = Depends(require_scope("instances.view")),
):
    query = select(Instance).order_by(Instance.name)
    if partner or customer:
        group_id = await hub_groups.resolve(session, partner, customer, create=False)
        query = query.where(Instance.group_id.in_(await hub_groups.subtree_ids(session, group_id)))
    if status:
        query = query.where(Instance.status == status)
    rows = (await session.execute(query)).scalars().all()
    if label:
        k, _, v = label.partition("=")
        rows = [i for i in rows if json.loads(i.labels_json or "{}").get(k.strip().lower()) == v.strip()]
    paths = hub_groups.paths(await hub_groups.all_groups(session))
    return [_out(i, paths) for i in rows]


async def _by_ref(session, ref: str) -> Instance:
    instance = await instance_by_ref(session, ref)
    if instance is None:
        raise HTTPException(404, "Nessuna istanza con questo riferimento")
    return instance


@router.get("/instances/by-ref/{ref}")
async def get_by_ref(ref: str, session: AsyncSession = Depends(get_session),
                     key: ApiPrincipal = Depends(require_scope("instances.view"))):
    paths = hub_groups.paths(await hub_groups.all_groups(session))
    return _out(await _by_ref(session, ref), paths)


@router.post("/instances/by-ref/{ref}/decommission")
async def decommission(ref: str, session: AsyncSession = Depends(get_session),
                       key: ApiPrincipal = Depends(require_scope("instances.lifecycle"))):
    """The machine was deleted: certificate revoked, support closed, data kept."""
    instance = await _by_ref(session, ref)
    if instance.status == "active":
        await revoke_instance(session, instance, by=key.username, status="decommissioned")
    return {"id": instance.id, "status": instance.status}


@router.post("/instances/by-ref/{ref}/backup", status_code=202)
async def backup(ref: str, session: AsyncSession = Depends(get_session),
                 key: ApiPrincipal = Depends(require_scope("backups.run"))):
    instance = await _by_ref(session, ref)
    if instance.status != "active":
        raise HTTPException(409, "Istanza non attiva")
    check_capability(instance.id, protocol.CMD_BACKUP_RUN)
    cmd = await queue_command(session, instance.id, protocol.CMD_BACKUP_RUN, {},
                              operator=key.username, ttl=timedelta(hours=1))
    return {"command_id": cmd.id, "status": cmd.status}


class LicenseIn(BaseModel):
    feature: str = Field(pattern=r"^[a-z0-9_.-]{1,50}$")
    valid_until: Optional[datetime] = None
    notes: str = Field(default="", max_length=500)


@router.post("/instances/by-ref/{ref}/licenses", status_code=201)
async def add_license(ref: str, body: LicenseIn, session: AsyncSession = Depends(get_session),
                      key: ApiPrincipal = Depends(require_scope("licenses.manage"))):
    instance = await _by_ref(session, ref)
    if instance.status != "active":
        raise HTTPException(409, "Istanza non attiva")
    existing = (await session.execute(select(License).where(
        License.instance_id == instance.id, License.feature == body.feature,
        License.active == True))).scalars().first()  # noqa: E712
    if existing:
        return {"license_id": existing.id, "created": False}
    valid_until = body.valid_until.replace(tzinfo=None) if body.valid_until else None
    lic = await license_service.create(session, instance.id, body.feature, valid_until, body.notes, key.username)
    return {"license_id": lic.id, "created": True}


@router.delete("/instances/by-ref/{ref}/licenses/{feature}")
async def remove_license(ref: str, feature: str, session: AsyncSession = Depends(get_session),
                         key: ApiPrincipal = Depends(require_scope("licenses.manage"))):
    instance = await _by_ref(session, ref)
    rows = (await session.execute(select(License).where(
        License.instance_id == instance.id, License.feature == feature,
        License.active == True))).scalars().all()  # noqa: E712
    for lic in rows:
        await license_service.revoke(session, lic, key.username)
    return {"revoked": len(rows)}


@router.get("/groups")
async def list_groups(session: AsyncSession = Depends(get_session),
                      key: ApiPrincipal = Depends(require_scope("instances.view"))):
    groups = await hub_groups.all_groups(session)
    paths = hub_groups.paths(groups)
    return [{"id": g.id, "name": g.name, "kind": g.kind, "parent_id": g.parent_id,
             "path": paths[g.id]} for g in groups]
