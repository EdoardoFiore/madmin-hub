"""
Module licenses.

A License row is the entitlement (instance + feature, until valid_until or
until revoked). The instance holds a signed token valid for a short time
(SystemSettings.license_validity_days); the hub re-issues it before it
expires while the license is active. Revoking stops the renewals and removes
the token from the instance at once (or when it next connects).
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlmodel import select

from core.database import async_session_maker
from core.settings.router import get_system_settings

from hub import pki
from hub.agents import protocol
from hub.agents.dispatcher import queue_command
from hub.models import License

logger = logging.getLogger("madmin_hub.licenses")

RENEW_INTERVAL = 3600
# Commands carrying a license wait this long for an offline instance
_CMD_TTL = timedelta(days=7)


def _ts(dt: datetime) -> int:
    from datetime import timezone
    return int(dt.replace(tzinfo=timezone.utc).timestamp())


async def issue_token(session, lic: License, operator: str) -> None:
    """Sign a fresh token for an active license and send it to the instance."""
    validity = (await get_system_settings(session)).license_validity_days
    now = datetime.utcnow()
    exp = now + timedelta(days=validity)
    if lic.valid_until is not None:
        exp = min(exp, lic.valid_until)
    if exp <= now:
        return
    lic.token = pki.sign_license({
        "lid": lic.id, "iid": lic.instance_id, "feature": lic.feature,
        "iat": _ts(now), "nbf": _ts(now), "exp": _ts(exp),
    })
    lic.token_expires_at = exp
    session.add(lic)
    await session.commit()
    await queue_command(session, lic.instance_id, protocol.CMD_LICENSE_INSTALL,
                        {"token": lic.token}, operator=operator, ttl=_CMD_TTL)


async def create(session, instance_id: str, feature: str, valid_until: Optional[datetime],
                 notes: str, operator: str) -> License:
    lic = License(instance_id=instance_id, feature=feature, valid_until=valid_until,
                  notes=notes, created_by=operator)
    session.add(lic)
    await session.commit()
    await issue_token(session, lic, operator)
    return lic


async def revoke(session, lic: License, operator: str) -> None:
    lic.active = False
    lic.revoked_at = datetime.utcnow()
    session.add(lic)
    await session.commit()
    await queue_command(session, lic.instance_id, protocol.CMD_LICENSE_REVOKE,
                        {"license_id": lic.id}, operator=operator, ttl=_CMD_TTL)


async def _renew_once() -> None:
    async with async_session_maker() as session:
        validity = (await get_system_settings(session)).license_validity_days
        threshold = datetime.utcnow() + timedelta(days=validity / 3)
        rows = (await session.execute(select(License).where(
            License.active == True,  # noqa: E712
            License.token_expires_at < threshold,
        ))).scalars().all()
        for lic in rows:
            if lic.valid_until is not None and lic.valid_until <= datetime.utcnow():
                lic.active = False
                session.add(lic)
                await session.commit()
                continue
            # Not past the entitlement end: a token already ending there is final
            if lic.valid_until is not None and lic.token_expires_at and lic.token_expires_at >= lic.valid_until:
                continue
            await issue_token(session, lic, "hub")
            logger.info("License %s (%s) renewed", lic.id, lic.feature)


async def renew_task() -> None:
    while True:
        try:
            await _renew_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("License renewal error")
        await asyncio.sleep(RENEW_INTERVAL)
