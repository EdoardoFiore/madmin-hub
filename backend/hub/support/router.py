"""
Support sessions (UI). Every call is in the hub audit log, and every action
on the instance is in its own audit log as hub:<operator>.
"""
import ipaddress
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session
from core.http import get_client_ip

from hub.agents import protocol
from hub.agents.dispatcher import check_capability
from hub.instances.router import get_instance_or_404
from hub.models import Instance, SupportSession
from . import service

router = APIRouter(prefix="/api", tags=["Support"])

MAX_MINUTES = 8 * 60


def session_out(row: SupportSession, instance_name: str = "") -> dict:
    d = row.model_dump()
    d["instance_name"] = instance_name
    return d


class _OpenBase(BaseModel):
    minutes: int = Field(default=60, ge=5, le=MAX_MINUTES)
    reason: str = Field(min_length=3, max_length=500)
    # IP allowed on the support port; default: the address of this request
    allowed_ip: Optional[str] = Field(default=None, max_length=45)

    @field_validator("allowed_ip")
    @classmethod
    def _ip(cls, v):
        if v:
            ipaddress.ip_address(v)
        return v or None


class UiOpen(_OpenBase):
    pass


class SshOpen(_OpenBase):
    public_key: str = Field(min_length=20, max_length=16384)
    # The instance has one SSH grant: an open SSH session is closed and
    # replaced only when asked (the UI warns first); otherwise 409
    replace: bool = False


async def _active_instance(session, instance_id: str) -> Instance:
    instance = await get_instance_or_404(session, instance_id)
    if instance.status != "active":
        raise HTTPException(409, "Istanza non attiva")
    return instance


@router.get("/support")
async def list_open(session: AsyncSession = Depends(get_session),
                    user: User = Depends(require_permission("support.access"))):
    rows = (await session.execute(
        select(SupportSession, Instance.name).join(Instance, Instance.id == SupportSession.instance_id)
        .where(SupportSession.status == "open").order_by(SupportSession.created_at.desc())
    )).all()
    return [session_out(r, n) for r, n in rows]


@router.get("/instances/{instance_id}/support")
async def list_for_instance(instance_id: str, session: AsyncSession = Depends(get_session),
                            user: User = Depends(require_permission("support.access"))):
    rows = (await session.execute(
        select(SupportSession).where(SupportSession.instance_id == instance_id)
        .order_by(SupportSession.created_at.desc()).limit(100)
    )).scalars().all()
    return [session_out(r) for r in rows]


@router.post("/instances/{instance_id}/support/ui", status_code=201)
async def open_ui(instance_id: str, body: UiOpen, request: Request,
                  session: AsyncSession = Depends(get_session),
                  user: User = Depends(require_permission("support.access"))):
    instance = await _active_instance(session, instance_id)
    check_capability(instance.id, protocol.CMD_SUPPORT_UI_OPEN)
    res = await service.open_ui(session, instance, user.username, body.minutes,
                                body.allowed_ip or get_client_ip(request), body.reason)
    return {"session": session_out(res["session"], instance.name), "url": res["url"],
            "ticket_ttl": res["ticket_ttl"]}


@router.post("/instances/{instance_id}/support/ssh", status_code=201)
async def open_ssh(instance_id: str, body: SshOpen, request: Request,
                   session: AsyncSession = Depends(get_session),
                   user: User = Depends(require_permission("support.access"))):
    instance = await _active_instance(session, instance_id)
    check_capability(instance.id, protocol.CMD_SUPPORT_SSH_GRANT)
    res = await service.open_ssh(session, instance, user.username, body.minutes,
                                 body.allowed_ip or get_client_ip(request), body.reason, body.public_key,
                                 replace=body.replace)
    return {"session": session_out(res["session"], instance.name),
            "certificate": res["certificate"], "command": res["command"]}


async def _open_session(session, session_id: str) -> SupportSession:
    row = await session.get(SupportSession, session_id)
    if row is None:
        raise HTTPException(404, "Sessione non trovata")
    if row.status != "open":
        raise HTTPException(409, "Sessione non più aperta")
    return row


@router.post("/support/{session_id}/ticket")
async def new_ticket(session_id: str, session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("support.access"))):
    row = await _open_session(session, session_id)
    if row.kind != "ui":
        raise HTTPException(400, "Solo per sessioni UI")
    return await service.new_ticket(session, row, user.username)


@router.post("/support/{session_id}/close")
async def close(session_id: str, session: AsyncSession = Depends(get_session),
                user: User = Depends(require_permission("support.access"))):
    row = await _open_session(session, session_id)
    await service.close(session, row, by=user.username)
    return session_out(row)
