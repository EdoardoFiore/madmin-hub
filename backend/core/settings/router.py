"""
Manager settings API.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import get_current_user, require_permission
from core.auth.models import User
from core.database import get_session

from .models import SystemSettings, SystemSettingsUpdate

router = APIRouter(prefix="/api/settings", tags=["Settings"])

# Fields every logged-in user may read (branding, language)
_PUBLIC = ("company_name", "primary_color", "default_language")


async def get_system_settings(session: AsyncSession) -> SystemSettings:
    row = (await session.execute(select(SystemSettings).where(SystemSettings.id == 1))).scalar_one_or_none()
    if row is None:
        row = SystemSettings(id=1)
        session.add(row)
        await session.flush()
    return row


@router.get("/system")
async def read_settings(
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    row = await get_system_settings(session)
    data = row.model_dump()
    if not current_user.has_permission("manager.view"):
        data = {k: data[k] for k in _PUBLIC}
    return data


@router.patch("/system")
async def update_settings(
    body: SystemSettingsUpdate,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(require_permission("manager.manage")),
):
    row = await get_system_settings(session)
    changes = body.model_dump(exclude_unset=True)
    for key, value in changes.items():
        if value is not None:
            setattr(row, key, value)
    if row.support_port_min > row.support_port_max:
        raise HTTPException(400, "Intervallo porte di supporto non valido")
    if row.support_port_max - row.support_port_min > 200:
        raise HTTPException(400, "Al massimo 200 porte di supporto")
    row.updated_at = datetime.utcnow().isoformat()
    session.add(row)
    await session.commit()
    return row.model_dump()
