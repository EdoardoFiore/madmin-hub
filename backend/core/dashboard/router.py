"""
Dashboard router: aggregated fleet summary + live alerts.
"""
import logging
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import HUB_VERSION
from core.auth.dependencies import get_current_user, require_permission
from core.auth.models import User
from core.database import get_session
from hub.instances.models import EnrollmentToken, ManagedInstance, InstanceGroup
from hub.instances.service import (
    fleet_summary,
    instance_to_dict,
    list_groups,
    list_instances_with_tags,
)
from hub.ws.manager import ws_manager

from .service import list_alerts, list_recent_activity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["Dashboard"])


@router.get("/fleet")
async def fleet_dashboard(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    instances, tags_map = await list_instances_with_tags(session)
    groups = await list_groups(session)
    groups_map = {g["id"]: g for g in groups}
    summary = fleet_summary(instances)
    summary["ws_connected_ids"] = [str(i) for i in ws_manager.connected_ids()]
    summary["groups"] = len(groups)

    now = datetime.utcnow()
    res = await session.execute(
        select(func.count(EnrollmentToken.id)).where(
            EnrollmentToken.revoked_at.is_(None),
            EnrollmentToken.expires_at > now,
        )
    )
    summary["active_tokens"] = res.scalar_one() or 0

    recent_activity = await list_recent_activity(session, limit=20)

    return {
        "summary": summary,
        "instances": [
            instance_to_dict(
                i,
                tags=tags_map.get(i.id, []),
                group=groups_map.get(str(i.group_id)) if i.group_id else None,
            )
            for i in instances
        ],
        "recent_activity": recent_activity,
        "version": HUB_VERSION,
    }


@router.get("/alerts")
async def alerts(
    user: User = Depends(require_permission("hub.view")),
    session: AsyncSession = Depends(get_session),
):
    return await list_alerts(session)
