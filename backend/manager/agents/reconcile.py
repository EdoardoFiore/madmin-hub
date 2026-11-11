"""
Reconciliation with the state an agent reports in every hello.

Events (support.expired) are best effort: one sent while the instance was
offline is lost. What must not drift is compared at each connection with
hello.state instead:

- support: open sessions the instance no longer has are closed (expired);
- licenses: an active license whose valid token the instance does not hold
  gets a fresh token, unless an install is already on its way;
- commands: those the agent reports running are marked running (their
  results come with the re-sent commands, see dispatcher.resend_pending).

A section missing from the state means "unknown" (an older agent, or the
agent could not read it): nothing is done for it.
"""
import logging
from datetime import datetime

from sqlalchemy import update
from sqlmodel import select

from core.database import async_session_maker

from manager.models import Command, License, SupportSession
from . import protocol

logger = logging.getLogger(__name__)


async def reconcile(instance_id: str, state) -> None:
    if not isinstance(state, dict):
        return
    if isinstance(state.get("support"), dict):
        await _support(instance_id, state["support"])
    if isinstance(state.get("licenses"), list):
        await _licenses(instance_id, {str(x) for x in state["licenses"][:1000]})
    commands = state.get("commands")
    if isinstance(commands, dict) and isinstance(commands.get("running"), list):
        await _running(instance_id, [str(x)[:36] for x in commands["running"][:1000]])


async def _support(instance_id: str, support: dict) -> None:
    from manager.support.service import close
    ui = support.get("ui") if isinstance(support.get("ui"), list) else None
    ssh = support.get("ssh") if isinstance(support.get("ssh"), dict) else None
    async with async_session_maker() as session:
        rows = (await session.execute(select(SupportSession).where(
            SupportSession.instance_id == instance_id, SupportSession.status == "open"
        ))).scalars().all()
        for row in rows:
            gone = (row.kind == "ui" and ui is not None and row.username not in ui) or \
                   (row.kind == "ssh" and ssh is not None and not ssh.get("open"))
            if gone:
                logger.info("Instance %s: support session %s no longer open there", instance_id, row.id)
                await close(session, row, by="instance", status="expired")


async def _licenses(instance_id: str, installed: set) -> None:
    from manager.licenses.service import issue_token
    now = datetime.utcnow()
    async with async_session_maker() as session:
        pending = (await session.execute(select(Command.id).where(
            Command.instance_id == instance_id, Command.name == protocol.CMD_LICENSE_INSTALL,
            Command.status.in_(("queued", "sent", "running")),
        ).limit(1))).first()
        if pending:
            return
        rows = (await session.execute(select(License).where(
            License.instance_id == instance_id, License.active == True,  # noqa: E712
        ))).scalars().all()
        for lic in rows:
            if lic.id in installed or (lic.valid_until is not None and lic.valid_until <= now):
                continue
            logger.info("Instance %s: license %s (%s) missing there, sent again", instance_id, lic.id, lic.feature)
            await issue_token(session, lic, "manager")


async def _running(instance_id: str, running: list) -> None:
    if not running:
        return
    now = datetime.utcnow()
    async with async_session_maker() as session:
        await session.execute(update(Command).where(
            Command.instance_id == instance_id, Command.id.in_(running),
            Command.status.in_(("queued", "sent")),
        ).values(status="running", started_at=now))
        await session.commit()
