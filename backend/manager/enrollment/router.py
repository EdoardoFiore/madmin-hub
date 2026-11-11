"""
Enrollment (UI): tokens and registration requests.

A token is one line: MMGR1-<base64url(json{u, f, i, s})> with the agent URL,
the sha256 of the manager CA (pinned by the instance), the token id and the
secret. Only sha256(secret) is stored: the token is shown once, at creation.
"""
import ipaddress
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session
from core.settings.router import get_system_settings

from manager import pki
from manager.models import EnrollmentRequest, EnrollmentToken, Instance
from manager.registration import RegistrationFields, check_group
from . import requests as reg_requests
from .service import create_token

router = APIRouter(prefix="/api/enrollment", tags=["Enrollment"])


def token_out(t: EnrollmentToken) -> dict:
    d = t.model_dump(exclude={"secret_hash", "labels_json"})
    d["labels"] = json.loads(t.labels_json or "{}")
    d["valid"] = (not t.revoked and t.expires_at > datetime.utcnow()
                  and (t.max_uses is None or t.uses < t.max_uses))
    return d


@router.get("/info")
async def info(session: AsyncSession = Depends(get_session),
               user: User = Depends(require_permission("manager.view"))):
    initialized = pki.is_initialized()
    s = await get_system_settings(session)
    return {
        "agent_url": s.agent_url,
        "pki_initialized": initialized,
        "ca_fingerprint": pki.ca_fingerprint() if initialized else None,
        "registration_enabled": s.registration_enabled,
    }


@router.get("/tokens")
async def list_tokens(session: AsyncSession = Depends(get_session),
                      user: User = Depends(require_permission("manager.view"))):
    rows = (await session.execute(select(EnrollmentToken).order_by(EnrollmentToken.created_at.desc()))).scalars().all()
    return [token_out(t) for t in rows]


class TokenCreate(RegistrationFields):
    description: str = Field(default="", max_length=200)
    hours: int = Field(default=24, ge=1, le=24 * 90)
    max_uses: Optional[int] = Field(default=1, ge=1, le=10000)  # None = unlimited
    bind_ip: Optional[str] = Field(default=None, max_length=45)

    @field_validator("bind_ip")
    @classmethod
    def _ip(cls, v):
        if v:
            ipaddress.ip_address(v)
        return v or None


@router.post("/tokens", status_code=201)
async def new_token(body: TokenCreate, session: AsyncSession = Depends(get_session),
                    user: User = Depends(require_permission("manager.manage"))):
    await check_group(session, body.group_id)
    fields = RegistrationFields(**body.model_dump(include={"name", "group_id", "labels", "external_ref"}))
    return await create_token(session, user.username, body.description, body.hours, body.max_uses,
                              fields, bind_ip=body.bind_ip)


@router.post("/tokens/{token_id}/revoke")
async def revoke_token(token_id: str, session: AsyncSession = Depends(get_session),
                       user: User = Depends(require_permission("manager.manage"))):
    t = await session.get(EnrollmentToken, token_id)
    if t is None:
        raise HTTPException(404, "Token non trovato")
    t.revoked = True
    session.add(t)
    await session.commit()
    return token_out(t)


@router.post("/instances/{instance_id}/reenroll")
async def reenroll_token(instance_id: str, session: AsyncSession = Depends(get_session),
                         user: User = Depends(require_permission("manager.manage"))):
    """Single-use token that keeps the instance identity (reinstall / upgrade)."""
    instance = await session.get(Instance, instance_id)
    if instance is None:
        raise HTTPException(404, "Istanza non trovata")
    if instance.status == "revoked":
        raise HTTPException(409, "Istanza revocata")
    return await create_token(session, user.username, f"Re-enroll {instance.name}", 72, 1,
                              reenroll_instance_id=instance.id)


# --- Registration requests ---

def request_out(r: EnrollmentRequest, matches: list) -> dict:
    facts = json.loads(r.facts_json or "{}")
    return {
        "id": r.id, "status": r.status, "created_at": r.created_at.isoformat(),
        "expires_at": r.expires_at.isoformat(), "source_ip": r.source_ip,
        "key_fingerprint": r.key_fingerprint, "ca_pinned": r.ca_pinned,
        "hostname": facts.get("hostname"), "machine_id": facts.get("machine_id"),
        "madmin_version": facts.get("madmin_version"), "os": facts.get("os"),
        "interfaces": facts.get("interfaces") or [],
        "decided_by": r.decided_by, "decided_at": r.decided_at.isoformat() if r.decided_at else None,
        "instance_id": r.instance_id,
        # Existing instances that look like this one (reinstall): re-enroll candidates
        "matches": matches,
    }


@router.get("/requests")
async def list_requests(status: Optional[str] = Query(default="pending", max_length=10),
                        session: AsyncSession = Depends(get_session),
                        user: User = Depends(require_permission("manager.view"))):
    await reg_requests.expire_old(session)
    query = select(EnrollmentRequest).order_by(EnrollmentRequest.created_at.desc()).limit(200)
    if status:
        query = query.where(EnrollmentRequest.status == status)
    rows = (await session.execute(query)).scalars().all()
    out = []
    for r in rows:
        machine_id = json.loads(r.facts_json or "{}").get("machine_id") or ""
        matches = []
        if r.status == "pending" and machine_id:
            found = (await session.execute(select(Instance.id, Instance.name, Instance.status).where(
                Instance.machine_id == machine_id, Instance.status != "revoked"))).all()
            matches = [{"id": i, "name": n, "status": s} for i, n, s in found]
        out.append(request_out(r, matches))
    return out


class Approval(RegistrationFields):
    reenroll_instance_id: Optional[str] = Field(default=None, max_length=36)


@router.post("/requests/{request_id}/approve")
async def approve_request(request_id: str, body: Approval, session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("manager.manage"))):
    await check_group(session, body.group_id)
    fields = RegistrationFields(**body.model_dump(include={"name", "group_id", "labels", "external_ref"}))
    instance = await reg_requests.approve(session, request_id, fields, body.reenroll_instance_id, user.username)
    return {"instance_id": instance.id, "name": instance.name}


@router.post("/requests/{request_id}/reject")
async def reject_request(request_id: str, session: AsyncSession = Depends(get_session),
                         user: User = Depends(require_permission("manager.manage"))):
    await reg_requests.reject(session, request_id, user.username)
    return {}
