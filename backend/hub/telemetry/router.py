"""
Telemetry router: history, latest, fleet-level stats.
"""
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from . import service as tel_svc

router = APIRouter(tags=["Telemetry"])


@router.get("/api/instances/{instance_id}/telemetry")
async def get_telemetry(
    instance_id: uuid.UUID,
    user: User = Depends(require_permission("hub.view")),
    session: AsyncSession = Depends(get_session),
    hours: int = Query(default=6, ge=1, le=168),
):
    rows = await tel_svc.get_history(session, instance_id, hours=hours)
    return [tel_svc.telemetry_to_dict(r) for r in rows]


@router.get("/api/instances/{instance_id}/telemetry/latest")
async def get_latest_telemetry(
    instance_id: uuid.UUID,
    user: User = Depends(require_permission("hub.view")),
    session: AsyncSession = Depends(get_session),
):
    row = await tel_svc.get_latest(session, instance_id)
    if not row:
        return None
    return tel_svc.telemetry_to_dict(row)
