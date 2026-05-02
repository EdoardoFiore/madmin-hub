"""
Instances service: helpers for queries, status updates, group management, tags.
"""
import json
import uuid
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import InstanceGroup, InstanceTag, ManagedInstance, Tag


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


async def list_instances_with_tags(
    session: AsyncSession,
    group_id: Optional[uuid.UUID] = None,
    tag: Optional[str] = None,
) -> tuple:
    """Return (instances, tags_map) where tags_map[instance_id] = [{id,name,color},...]."""
    instances = await list_instances(session, group_id=group_id, tag=tag)
    if not instances:
        return instances, {}
    ids = [i.id for i in instances]
    from sqlalchemy import tuple_  # noqa — unused import trick avoided
    res = await session.execute(
        select(InstanceTag.instance_id, Tag.id, Tag.name, Tag.color)
        .join(Tag, Tag.id == InstanceTag.tag_id)
        .where(InstanceTag.instance_id.in_(ids))
        .order_by(Tag.name)
    )
    tags_map: Dict[uuid.UUID, List[dict]] = {}
    for row in res.all():
        tags_map.setdefault(row.instance_id, []).append(
            {"id": str(row.id), "name": row.name, "color": row.color}
        )
    return instances, tags_map


async def set_instance_tags(
    session: AsyncSession,
    instance_id: uuid.UUID,
    tag_names: List[str],
) -> List[dict]:
    """Replace all tags for an instance. Returns new tag list."""
    from sqlalchemy import delete as sa_delete
    await session.execute(sa_delete(InstanceTag).where(InstanceTag.instance_id == instance_id))
    result = []
    for name in tag_names:
        name = name.strip()
        if not name:
            continue
        tag = await get_or_create_tag(session, name)
        session.add(InstanceTag(instance_id=instance_id, tag_id=tag.id))
        result.append({"id": str(tag.id), "name": tag.name, "color": tag.color})
    return result


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


async def list_groups(session: AsyncSession) -> List[dict]:
    result = await session.execute(select(InstanceGroup).order_by(InstanceGroup.name))
    groups = result.scalars().all()
    counts = await _group_member_counts(session)
    return [group_to_dict(g, counts.get(g.id, 0)) for g in groups]


async def get_group(session: AsyncSession, group_id: uuid.UUID) -> Optional[InstanceGroup]:
    result = await session.execute(select(InstanceGroup).where(InstanceGroup.id == group_id))
    return result.scalar_one_or_none()


async def _group_member_counts(session: AsyncSession) -> Dict[uuid.UUID, int]:
    result = await session.execute(
        select(ManagedInstance.group_id, func.count().label("cnt"))
        .where(ManagedInstance.group_id.is_not(None))
        .group_by(ManagedInstance.group_id)
    )
    return {row.group_id: row.cnt for row in result.all()}


def group_to_dict(g: InstanceGroup, member_count: int = 0) -> dict:
    return {
        "id": str(g.id),
        "name": g.name,
        "description": g.description,
        "color": g.color,
        "created_at": g.created_at.isoformat(),
        "member_count": member_count,
    }


async def bulk_update_instances(
    session: AsyncSession,
    instance_ids: List[uuid.UUID],
    action: str,
    value: Optional[str],
) -> dict:
    results = {"updated": 0, "errors": []}
    for iid in instance_ids:
        inst = await get_instance(session, iid)
        if not inst:
            results["errors"].append(str(iid))
            continue
        if action == "set_group":
            inst.group_id = uuid.UUID(value) if value else None
        elif action == "add_tag":
            if value:
                tag = await get_or_create_tag(session, value)
                existing = await session.execute(
                    select(InstanceTag).where(
                        InstanceTag.instance_id == inst.id,
                        InstanceTag.tag_id == tag.id,
                    )
                )
                if not existing.scalar_one_or_none():
                    session.add(InstanceTag(instance_id=inst.id, tag_id=tag.id))
        elif action == "remove_tag":
            if value:
                res = await session.execute(select(Tag).where(Tag.name == value))
                tag = res.scalar_one_or_none()
                if tag:
                    res2 = await session.execute(
                        select(InstanceTag).where(
                            InstanceTag.instance_id == inst.id,
                            InstanceTag.tag_id == tag.id,
                        )
                    )
                    it = res2.scalar_one_or_none()
                    if it:
                        await session.delete(it)
        elif action == "revoke":
            inst.enrollment_status = "revoked"
            inst.ws_connected = False
        else:
            raise ValueError(f"Unknown action: {action}")
        inst.updated_at = datetime.utcnow()
        session.add(inst)
        results["updated"] += 1
    return results


async def get_instance_tags(session: AsyncSession, instance_id: uuid.UUID) -> List[dict]:
    res = await session.execute(
        select(Tag)
        .join(InstanceTag, InstanceTag.tag_id == Tag.id)
        .where(InstanceTag.instance_id == instance_id)
        .order_by(Tag.name)
    )
    return [{"id": str(t.id), "name": t.name, "color": t.color} for t in res.scalars().all()]


async def list_tags(session: AsyncSession) -> List[dict]:
    res = await session.execute(
        select(Tag, func.count(InstanceTag.instance_id).label("instance_count"))
        .outerjoin(InstanceTag, InstanceTag.tag_id == Tag.id)
        .group_by(Tag.id)
        .order_by(Tag.name)
    )
    return [
        {
            "id": str(row.Tag.id),
            "name": row.Tag.name,
            "color": row.Tag.color,
            "description": row.Tag.description,
            "instance_count": row.instance_count,
        }
        for row in res.all()
    ]


async def get_or_create_tag(session: AsyncSession, name: str, color: str = "#6c757d") -> Tag:
    res = await session.execute(select(Tag).where(Tag.name == name))
    tag = res.scalar_one_or_none()
    if not tag:
        tag = Tag(name=name, color=color)
        session.add(tag)
        await session.flush()
        await session.refresh(tag)
    return tag


async def create_tag(session: AsyncSession, name: str, color: str = "#6c757d", description: Optional[str] = None) -> Tag:
    tag = Tag(name=name, color=color, description=description)
    session.add(tag)
    await session.flush()
    await session.refresh(tag)
    return tag


async def update_tag(session: AsyncSession, tag_id: uuid.UUID, **kwargs) -> Optional[Tag]:
    res = await session.execute(select(Tag).where(Tag.id == tag_id))
    tag = res.scalar_one_or_none()
    if not tag:
        return None
    for k, v in kwargs.items():
        setattr(tag, k, v)
    session.add(tag)
    return tag


async def delete_tag(session: AsyncSession, tag_id: uuid.UUID) -> bool:
    from sqlalchemy import delete as sa_delete
    res = await session.execute(select(Tag).where(Tag.id == tag_id))
    tag = res.scalar_one_or_none()
    if not tag:
        return False
    await session.execute(sa_delete(InstanceTag).where(InstanceTag.tag_id == tag_id))
    await session.delete(tag)
    return True


async def instance_to_dict_full(session: AsyncSession, i: ManagedInstance) -> dict:
    tags = await get_instance_tags(session, i.id)
    group = None
    if i.group_id:
        g = await get_group(session, i.group_id)
        if g:
            group = {"id": str(g.id), "name": g.name, "color": g.color}
    d = instance_to_dict(i)
    d["tags"] = tags
    d["group"] = group
    return d


def instance_to_dict(i: ManagedInstance, tags: Optional[List[dict]] = None, group: Optional[dict] = None) -> dict:
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
        "tags": tags if tags is not None else json.loads(i.tags or "[]"),
        "notes": i.notes,
        "group_id": str(i.group_id) if i.group_id else None,
        "group": group,
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
