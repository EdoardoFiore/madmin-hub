"""
Relay router: POST /api/instances/{id}/exec/{action}
Dispatches command to agent via WS (or queues if offline).
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session
from hub.instances.service import get_instance

from . import dispatcher as disp

router = APIRouter(tags=["Instances"])


class ExecRequest(BaseModel):
    params: dict = {}
    timeout: Optional[int] = None


@router.post("/api/instances/{instance_id}/exec/{action}")
async def exec_command(
    instance_id: uuid.UUID,
    action: str,
    body: ExecRequest = ExecRequest(),
    user: User = Depends(require_permission("hub.manage")),
    session: AsyncSession = Depends(get_session),
):
    instance = await get_instance(session, instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="Istanza non trovata")
    if instance.enrollment_status != "active":
        raise HTTPException(status_code=400, detail="Istanza non attiva")

    result = await disp.dispatch(
        session,
        instance_id=instance_id,
        action=action,
        params=body.params,
        requested_by=user.username,
        timeout=body.timeout,
    )
    return result
