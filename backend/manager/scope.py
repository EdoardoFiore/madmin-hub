"""
What a user may see: the scope of its role.

    superuser   everything (None: no filter)
    partner     its partner group and the customers under it
    customer    its customer group

Instances without a group are visible to superusers only. Anything out of
scope answers 404, as if it did not exist: a partner must not learn the ids
or the names of other partners' instances.
"""
from typing import Optional, Set

from fastapi import HTTPException
from sqlalchemy import false

from core.auth.models import User
from manager.groups import subtree_ids
from manager.models import Instance, InstanceGroup


async def group_ids(session, user: User) -> Optional[Set[str]]:
    """Groups in the user's scope; None = every group and ungrouped instances."""
    if user.is_superuser:
        return None
    if not user.group_id:
        return set()
    return await subtree_ids(session, user.group_id)


def filter_instances(query, ids: Optional[Set[str]], column=Instance.group_id):
    """Restrict a query on instances (or on a group_id column) to `ids`."""
    if ids is None:
        return query
    if not ids:
        return query.where(false())
    return query.where(column.in_(ids))


def instance_visible(instance: Instance, ids: Optional[Set[str]]) -> bool:
    return ids is None or (instance.group_id is not None and instance.group_id in ids)


async def get_instance(session, user: User, instance_id: str) -> Instance:
    """The instance, or 404 when missing or out of the user's scope."""
    instance = await session.get(Instance, instance_id)
    if instance is None or not instance_visible(instance, await group_ids(session, user)):
        raise HTTPException(404, "Istanza non trovata")
    return instance


async def check_group(session, user: User, group_id: Optional[str]) -> Optional[InstanceGroup]:
    """
    A group the user may place things in (an instance, a user). None means "no
    group", which only a superuser may choose.
    """
    if not group_id:
        if not user.is_superuser:
            raise HTTPException(403, "Solo un superuser può lasciare un elemento senza gruppo")
        return None
    group = await session.get(InstanceGroup, group_id)
    ids = await group_ids(session, user)
    if group is None or (ids is not None and group_id not in ids):
        raise HTTPException(400, "Gruppo inesistente o fuori dal tuo ambito")
    return group
