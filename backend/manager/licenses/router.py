"""
Licenses (UI). Everyone sees the licenses of the instances in their scope;
issuing and revoking them is a manager operation (superuser, rw).
"""
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from manager import scope
from manager.instances.router import get_instance_or_404
from manager.models import Instance, License
from . import service

router = APIRouter(prefix="/api/licenses", tags=["Licenses"])


def license_out(lic: License, instance_name: str = "") -> dict:
    d = lic.model_dump(exclude={"token"})
    d["instance_name"] = instance_name
    return d


@router.get("")
async def list_licenses(instance_id: Optional[str] = Query(default=None, max_length=36),
                        session: AsyncSession = Depends(get_session),
                        user: User = Depends(require_permission("scope.view"))):
    query = (select(License, Instance.name).join(Instance, Instance.id == License.instance_id)
             .order_by(License.created_at.desc()))
    query = scope.filter_instances(query, await scope.group_ids(session, user))
    if instance_id:
        query = query.where(License.instance_id == instance_id)
    return [license_out(lic, name) for lic, name in (await session.execute(query)).all()]


class LicenseCreate(BaseModel):
    instance_id: str = Field(max_length=36)
    feature: str = Field(max_length=50)
    valid_until: Optional[datetime] = None
    notes: str = Field(default="", max_length=500)

    @field_validator("feature")
    @classmethod
    def _feature(cls, v):
        if not re.fullmatch(r"[a-z0-9_.-]{1,50}", v):
            raise ValueError("Feature non valida (minuscole, cifre, . _ -)")
        return v


@router.post("", status_code=201)
async def create_license(body: LicenseCreate, session: AsyncSession = Depends(get_session),
                         user: User = Depends(require_permission("manager.manage"))):
    instance = await get_instance_or_404(session, body.instance_id, user)
    if instance.status != "active":
        raise HTTPException(409, "Istanza non attiva")
    existing = (await session.execute(select(License).where(
        License.instance_id == instance.id, License.feature == body.feature,
        License.active == True,  # noqa: E712
    ))).first()
    if existing:
        raise HTTPException(409, "Licenza già attiva per questa feature")
    valid_until = body.valid_until.replace(tzinfo=None) if body.valid_until else None
    if valid_until is not None and valid_until <= datetime.utcnow():
        raise HTTPException(400, "Data di fine nel passato")
    lic = await service.create(session, instance.id, body.feature, valid_until, body.notes, user.username)
    return license_out(lic, instance.name)


@router.post("/{license_id}/revoke")
async def revoke_license(license_id: str, session: AsyncSession = Depends(get_session),
                         user: User = Depends(require_permission("manager.manage"))):
    lic = await session.get(License, license_id)
    if lic is None:
        raise HTTPException(404, "Licenza non trovata")
    if lic.active:
        await service.revoke(session, lic, user.username)
    return license_out(lic)
