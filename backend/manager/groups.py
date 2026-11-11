"""
Group hierarchy: (manager) -> customer, or (manager) -> partner -> customer.
"""
from typing import Dict, List, Optional, Set

from fastapi import HTTPException
from sqlmodel import select

from manager.models import InstanceGroup

KINDS = ("partner", "customer")


async def all_groups(session) -> List[InstanceGroup]:
    return (await session.execute(select(InstanceGroup).order_by(InstanceGroup.name))).scalars().all()


def paths(groups: List[InstanceGroup]) -> Dict[str, str]:
    """id -> 'Partner / Customer'."""
    by_id = {g.id: g for g in groups}
    out = {}
    for g in groups:
        parent = by_id.get(g.parent_id) if g.parent_id else None
        out[g.id] = f"{parent.name} / {g.name}" if parent else g.name
    return out


async def subtree_ids(session, group_id: str) -> Set[str]:
    """The group and its descendants (a partner includes its customers)."""
    groups = await all_groups(session)
    ids = {group_id}
    changed = True
    while changed:
        changed = False
        for g in groups:
            if g.parent_id in ids and g.id not in ids:
                ids.add(g.id)
                changed = True
    return ids


def check_placement(kind: str, parent: Optional[InstanceGroup]) -> None:
    if kind not in KINDS:
        raise HTTPException(400, "Tipo di gruppo non valido (partner | customer)")
    if kind == "partner" and parent is not None:
        raise HTTPException(400, "Un partner sta solo al primo livello")
    if parent is not None and parent.kind != "partner":
        raise HTTPException(400, "Un cliente può stare solo al primo livello o sotto un partner")


async def find_child(session, name: str, parent_id: Optional[str]) -> Optional[InstanceGroup]:
    query = select(InstanceGroup).where(InstanceGroup.name == name)
    query = query.where(InstanceGroup.parent_id == parent_id) if parent_id else \
        query.where(InstanceGroup.parent_id == None)  # noqa: E711
    return (await session.execute(query)).scalar_one_or_none()


async def create_group(session, name: str, kind: str, parent_id: Optional[str],
                       description: str = "") -> InstanceGroup:
    parent = await session.get(InstanceGroup, parent_id) if parent_id else None
    if parent_id and parent is None:
        raise HTTPException(400, "Gruppo padre inesistente")
    check_placement(kind, parent)
    if await find_child(session, name, parent_id):
        raise HTTPException(409, "Esiste già un gruppo con questo nome in questa posizione")
    group = InstanceGroup(name=name, kind=kind, parent_id=parent_id, description=description)
    session.add(group)
    await session.flush()
    return group


async def resolve(session, partner: Optional[str], customer: Optional[str],
                  create: bool) -> Optional[str]:
    """
    Group id from names, as the provisioning system knows them:
    partner only -> the partner; customer only -> a top-level customer;
    both -> the customer under that partner. Missing groups are created
    only when `create`.
    """
    partner, customer = (partner or "").strip(), (customer or "").strip()
    if not partner and not customer:
        return None
    parent_id = None
    if partner:
        p = await find_child(session, partner, None)
        if p is None:
            if not create:
                raise HTTPException(400, f"Partner inesistente: {partner}")
            p = await create_group(session, partner, "partner", None)
        elif p.kind != "partner":
            raise HTTPException(400, f"{partner} non è un partner")
        if not customer:
            return p.id
        parent_id = p.id
    c = await find_child(session, customer, parent_id)
    if c is None:
        if not create:
            raise HTTPException(400, f"Cliente inesistente: {customer}")
        c = await create_group(session, customer, "customer", parent_id)
    elif c.kind != "customer":
        raise HTTPException(400, f"{customer} non è un cliente")
    return c.id
