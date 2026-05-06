"""
Relay router: POST /api/instances/{id}/exec/{action}
Dispatches command to agent via WS (or queues if offline).
For backup.run: agent always uploads via HTTP to hub; hub then transfers to the target repo.
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings
from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session
from hub.instances.service import get_instance

from . import dispatcher as disp
from .protocol import ACTION_BACKUP_RUN

router = APIRouter(tags=["Instances"])


class ExecRequest(BaseModel):
    params: dict = {}
    timeout: Optional[int] = None
    # Optional: pass a specific repo_id for backup.run
    repo_id: Optional[str] = None


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

    # For backup.run: agent always uploads via HTTP to hub (hub transfers to repo).
    if action == ACTION_BACKUP_RUN and "remote_protocol" not in body.params:
        from hub.backups.service import get_repo, get_default_repo
        settings = get_settings()

        repo = None
        if body.repo_id:
            try:
                repo = await get_repo(session, uuid.UUID(body.repo_id))
            except Exception:
                pass
        if not repo:
            repo = await get_default_repo(session)

        if repo:
            body.params["remote_protocol"] = "http"
            body.params["remote_host"] = (
                f"{settings.hub_public_url}/api/instances/{instance_id}/backups/upload"
                f"?repo_id={repo.id}"
            )
            body.params["remote_password"] = "__agent_self_token__"

    result = await disp.dispatch(
        session,
        instance_id=instance_id,
        action=action,
        params=body.params,
        requested_by=user.username,
        timeout=body.timeout,
    )
    return result
