"""
Settings router: system + SMTP.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import get_current_user, require_permission
from core.auth.models import User
from core.auth.service import decrypt_secret, encrypt_secret
from core.database import get_session
from core.i18n import get_lang, tr

from .models import SMTPSettings, SystemSettings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", tags=["Settings"])


async def _get_or_create_system(session: AsyncSession) -> SystemSettings:
    result = await session.execute(select(SystemSettings).where(SystemSettings.id == 1))
    s = result.scalar_one_or_none()
    if not s:
        s = SystemSettings(id=1)
        session.add(s)
        await session.flush()
    return s


async def _get_or_create_smtp(session: AsyncSession) -> SMTPSettings:
    result = await session.execute(select(SMTPSettings).where(SMTPSettings.id == 1))
    s = result.scalar_one_or_none()
    if not s:
        s = SMTPSettings(id=1)
        session.add(s)
        await session.flush()
    return s


class SystemUpdate(BaseModel):
    company_name: Optional[str] = None
    primary_color: Optional[str] = None
    logo_url: Optional[str] = None
    favicon_url: Optional[str] = None
    support_url: Optional[str] = None
    default_language: Optional[str] = None
    audit_retention_days: Optional[int] = None
    telemetry_retention_days: Optional[int] = None
    hub_url: Optional[str] = None
    default_token_ttl_minutes: Optional[int] = None
    enforce_2fa_global: Optional[bool] = None


@router.get("/system")
async def get_system(
    user: User = Depends(require_permission("settings.view")),
    session: AsyncSession = Depends(get_session),
):
    return await _get_or_create_system(session)


@router.patch("/system")
async def update_system(
    payload: SystemUpdate,
    user: User = Depends(require_permission("settings.manage")),
    session: AsyncSession = Depends(get_session),
):
    s = await _get_or_create_system(session)
    for k, v in payload.dict(exclude_unset=True).items():
        setattr(s, k, v)
    session.add(s)
    return s


class SMTPUpdate(BaseModel):
    enabled: Optional[bool] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None  # plaintext, encrypted on store
    use_tls: Optional[bool] = None
    from_address: Optional[str] = None
    from_name: Optional[str] = None


@router.get("/smtp")
async def get_smtp(
    user: User = Depends(require_permission("settings.view")),
    session: AsyncSession = Depends(get_session),
):
    s = await _get_or_create_smtp(session)
    out = s.dict()
    out["password"] = "***" if s.password else None
    return out


@router.patch("/smtp")
async def update_smtp(
    payload: SMTPUpdate,
    user: User = Depends(require_permission("settings.manage")),
    session: AsyncSession = Depends(get_session),
):
    s = await _get_or_create_smtp(session)
    data = payload.dict(exclude_unset=True)
    if "password" in data and data["password"]:
        data["password"] = encrypt_secret(data["password"], purpose="smtp")
    for k, v in data.items():
        setattr(s, k, v)
    session.add(s)
    out = s.dict()
    out["password"] = "***" if s.password else None
    return out


def get_smtp_password_plain(s: SMTPSettings) -> Optional[str]:
    if not s.password:
        return None
    try:
        return decrypt_secret(s.password, purpose="smtp")
    except Exception:
        return None


class SmtpTestPayload(BaseModel):
    to: Optional[str] = None


@router.post("/smtp/test")
async def test_smtp(
    request: Request,
    payload: SmtpTestPayload,
    user: User = Depends(require_permission("settings.manage")),
    session: AsyncSession = Depends(get_session),
):
    lang = get_lang(request)
    s = await _get_or_create_smtp(session)
    if not s.enabled or not s.host or not s.from_address:
        raise HTTPException(status_code=400, detail=tr("smtp_not_configured", lang))

    recipient = payload.to or user.email
    if not recipient:
        raise HTTPException(status_code=400, detail=tr("smtp_test_no_recipient", lang))

    from core.notifications.smtp import send_email
    ok = await send_email(
        session,
        to=recipient,
        subject="MADMIN Hub — SMTP Test",
        body="SMTP configuration is working correctly.",
    )
    if not ok:
        raise HTTPException(status_code=500, detail=tr("smtp_send_failed", lang))
    return {"detail": tr("smtp_test_sent", lang)}
