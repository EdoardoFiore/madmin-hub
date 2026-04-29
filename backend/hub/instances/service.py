"""
Instances service: helpers for queries, status updates, group management.
"""
import json
import uuid
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import InstanceGroup, ManagedInstance


async def list_instances(
    session: AsyncSession,
    group_id: Optional[uuid.UUID] = None,
    tag: Optional[str] = None,
) -> List[ManagedInstance]:
    stmt = select(ManagedInstance).order_by(ManagedInstance.name)
    if group_id is not None:
        stmt = stmt.where(ManagedInstance.group_id == group_id)
    result = await session.execute(stmt)
    items = list(result.scalars().all())
    if tag:
        items = [i for i in items if tag in (json.loads(i.tags or "[]"))]
    return items


async def get_instance(session: AsyncSession, instance_id: uuid.UUID) -> Optional[ManagedInstance]:
    result = await session.execute(
        select(ManagedInstance).where(ManagedInstance.id == instance_id)
    )
    return result.scalar_one_or_none()


async def get_instance_by_fingerprint(
    session: AsyncSession, fingerprint: str
) -> Optional[ManagedInstance]:
    result = await session.execute(
        select(ManagedInstance).where(ManagedInstance.fingerprint == fingerprint)
    )
    return result.scalar_one_or_none()


async def mark_ws_connected(session: AsyncSession, instance: ManagedInstance) -> None:
    now = datetime.utcnow()
    instance.ws_connected = True
    instance.ws_connected_at = now
    instance.last_seen_at = now
    instance.updated_at = now
    session.add(instance)
    await session.commit()


async def mark_ws_disconnected(session: AsyncSession, instance: ManagedInstance) -> None:
    instance.ws_connected = False
    instance.updated_at = datetime.utcnow()
    session.add(instance)
    await session.commit()


async def update_last_seen(session: AsyncSession, instance: ManagedInstance) -> None:
    instance.last_seen_at = datetime.utcnow()
    session.add(instance)
    await session.commit()


async def create_group(
    session: AsyncSession, name: str, description: Optional[str] = None, color: str = "#206bc4"
) -> InstanceGroup:
    g = InstanceGroup(name=name, description=description, color=color)
    session.add(g)
    await session.flush()
    await session.refresh(g)
    return g


async def list_groups(session: AsyncSession) -> List[InstanceGroup]:
    result = await session.execute(select(InstanceGroup).order_by(InstanceGroup.name))
    return result.scalars().all()


def instance_to_dict(i: ManagedInstance) -> dict:
    return {
        "id": str(i.id),
        "name": i.name,
        "fingerprint": i.fingerprint,
        "enrollment_status": i.enrollment_status,
        "ws_connected": i.ws_connected,
        "ws_connected_at": i.ws_connected_at.isoformat() if i.ws_connected_at else None,
        "last_seen_at": i.last_seen_at.isoformat() if i.last_seen_at else None,
        "version": i.version,
        "os_info": json.loads(i.os_info or "{}"),
        "tags": json.loads(i.tags or "[]"),
        "notes": i.notes,
        "group_id": str(i.group_id) if i.group_id else None,
        "created_at": i.created_at.isoformat(),
        "updated_at": i.updated_at.isoformat(),
    }


def fleet_summary(instances: List[ManagedInstance]) -> dict:
    total = len(instances)
    online = sum(1 for i in instances if i.ws_connected)
    stale_threshold = datetime.utcnow() - timedelta(minutes=5)
    stale = sum(
        1
        for i in instances
        if not i.ws_connected
        and i.last_seen_at
        and i.last_seen_at < stale_threshold
    )
    never_seen = sum(1 for i in instances if i.last_seen_at is None)
    return {
        "total": total,
        "online": online,
        "offline": total - online,
        "stale": stale,
        "never_seen": never_seen,
    }
