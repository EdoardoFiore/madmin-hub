"""
OS actions on an instance (ROADMAP 9.1): refresh the package lists, upgrade
(security only or everything), reboot (a new kernel boots on trial), cancel a
scheduled reboot. Superusers only, like MADMIN updates.

The commands are persistent with short delivery deadlines: an instance that
comes back online hours later must not upgrade or reboot by surprise.
"""
import json
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from manager.agents import protocol
from manager.agents.dispatcher import check_capability, queue_command
from manager.instances.router import get_instance_or_404
from manager.models import Command, Instance

router = APIRouter(prefix="/api", tags=["OS actions"])

REFRESH_TTL = timedelta(minutes=30)
UPGRADE_TTL = timedelta(minutes=30)
UPGRADE_TIMEOUT = 5400
REBOOT_TTL = timedelta(minutes=10)
_OS_COMMANDS = (protocol.CMD_OS_REFRESH, protocol.CMD_OS_UPGRADE, protocol.CMD_OS_REBOOT,
                protocol.CMD_OS_SERVICES_RESTART)


async def _target(session, instance_id: str, user: User, name: str) -> Instance:
    instance = await get_instance_or_404(session, instance_id, user)
    if instance.status != "active":
        raise HTTPException(409, "Istanza non attiva")
    if instance.layout < 1:
        raise HTTPException(409, "Installazione senza updater (layout precedente): reinstallare l'istanza")
    check_capability(instance.id, name)
    pending = (await session.execute(select(Command.name).where(
        Command.instance_id == instance.id, Command.name.in_(_OS_COMMANDS),
        Command.status.in_(("queued", "sent", "running"))))).first()
    if pending:
        raise HTTPException(409, f"Azione sul sistema già in corso ({pending[0]}): attenderne l'esito")
    update = json.loads(instance.update_json or "{}")
    if update.get("result") in ("running", "verifying"):
        raise HTTPException(409, "Aggiornamento di MADMIN in corso")
    return instance


@router.post("/instances/{instance_id}/os/refresh", status_code=202)
async def os_refresh(instance_id: str, session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("manager.manage"))):
    instance = await _target(session, instance_id, user, protocol.CMD_OS_REFRESH)
    cmd = await queue_command(session, instance.id, protocol.CMD_OS_REFRESH, {}, operator=user.username,
                              ttl=REFRESH_TTL, timeout=900)
    return {"command_id": cmd.id, "status": cmd.status}


class UpgradeIn(BaseModel):
    scope: str = Field(pattern="^(security|all)$")


@router.post("/instances/{instance_id}/os/upgrade", status_code=202)
async def os_upgrade(instance_id: str, body: UpgradeIn, session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("manager.manage"))):
    instance = await _target(session, instance_id, user, protocol.CMD_OS_UPGRADE)
    cmd = await queue_command(session, instance.id, protocol.CMD_OS_UPGRADE, {"scope": body.scope},
                              operator=user.username, ttl=UPGRADE_TTL, timeout=UPGRADE_TIMEOUT)
    return {"command_id": cmd.id, "status": cmd.status}


class RebootIn(BaseModel):
    delay_minutes: int = Field(default=0, ge=0, le=protocol.REBOOT_DELAY_MAX)
    reason: str = Field(min_length=3, max_length=200)


@router.post("/instances/{instance_id}/os/reboot", status_code=202)
async def os_reboot(instance_id: str, body: RebootIn, session: AsyncSession = Depends(get_session),
                    user: User = Depends(require_permission("manager.manage"))):
    instance = await _target(session, instance_id, user, protocol.CMD_OS_REBOOT)
    cmd = await queue_command(session, instance.id, protocol.CMD_OS_REBOOT,
                              {"delay_minutes": body.delay_minutes, "reason": body.reason},
                              operator=user.username, ttl=REBOOT_TTL, timeout=120)
    return {"command_id": cmd.id, "status": cmd.status}


@router.post("/instances/{instance_id}/os/reboot/cancel", status_code=202)
async def os_reboot_cancel(instance_id: str, session: AsyncSession = Depends(get_session),
                           user: User = Depends(require_permission("manager.manage"))):
    instance = await get_instance_or_404(session, instance_id, user)
    check_capability(instance.id, protocol.CMD_OS_REBOOT_CANCEL)
    cmd = await queue_command(session, instance.id, protocol.CMD_OS_REBOOT_CANCEL, {}, operator=user.username,
                              ttl=REBOOT_TTL, timeout=60)
    return {"command_id": cmd.id, "status": cmd.status}


class ServicesRestartIn(BaseModel):
    # None = every service the instance lists now (os_status.restart_services)
    services: Optional[List[str]] = Field(default=None, max_length=100)
    # Later: a one-instance rollout that starts then (ISO with time zone)
    start_at: Optional[datetime] = None


@router.post("/instances/{instance_id}/os/services/restart", status_code=202)
async def os_services_restart(instance_id: str, body: ServicesRestartIn, session: AsyncSession = Depends(get_session),
                              user: User = Depends(require_permission("manager.manage"))):
    """The services that run outdated libraries, now or at a chosen time. The
    instance restarts only services needrestart lists (never another unit)."""
    instance = await _target(session, instance_id, user, protocol.CMD_OS_SERVICES_RESTART)
    if body.start_at is not None:
        from manager.rollouts.router import RolloutIn, Selection, build
        rollout = await build(session, RolloutIn(
            name=f"Riavvio servizi {instance.name}", action=protocol.CMD_OS_SERVICES_RESTART,
            selection=Selection(instance_ids=[instance.id]), canary=0, use_windows=False, expires_hours=6,
            start_at=body.start_at), user, user.username)
        return {"rollout_id": rollout.id, "start_at": rollout.start_at}
    args = {} if body.services is None else {"services": body.services}
    cmd = await queue_command(session, instance.id, protocol.CMD_OS_SERVICES_RESTART, args,
                              operator=user.username, ttl=REBOOT_TTL, timeout=300)
    return {"command_id": cmd.id, "status": cmd.status}
