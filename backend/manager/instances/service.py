"""
Instances: facts, address history, revocation.
"""
import json
import logging
from datetime import datetime
from typing import Iterable, Optional, Tuple

from sqlalchemy import update
from sqlmodel import select

from manager.models import AgentCertificate, Instance, InstanceAddress, SupportSession
from manager.agents import protocol
from manager.agents.registry import registry

logger = logging.getLogger(__name__)

_MAX_FACTS = 64 * 1024


def _clip(value, n: int) -> str:
    return str(value or "")[:n]


def _interface_addresses(facts: dict) -> Iterable[Tuple[str, str]]:
    for iface in facts.get("interfaces") or []:
        if not isinstance(iface, dict):
            continue
        name = _clip(iface.get("name"), 50)
        for addr in iface.get("ipv4") or []:
            yield name, _clip(addr, 64)
        if iface.get("ipv6"):
            yield name, _clip(iface["ipv6"], 64)


async def record_addresses(session, instance: Instance, source_ip: Optional[str],
                           facts: Optional[dict]) -> None:
    """Upsert the seen addresses; those no longer seen stop being current
    (kept as history)."""
    now = datetime.utcnow()
    seen = set()
    if source_ip:
        seen.add(("source", "", source_ip[:64]))
    if facts is not None:
        seen.update(("interface", n, a) for n, a in _interface_addresses(facts))
    rows = (await session.execute(
        select(InstanceAddress).where(InstanceAddress.instance_id == instance.id)
    )).scalars().all()
    by_key = {(r.kind, r.interface, r.address): r for r in rows}
    for key in seen:
        row = by_key.get(key)
        if row is None:
            session.add(InstanceAddress(instance_id=instance.id, kind=key[0], interface=key[1],
                                        address=key[2], first_seen=now, last_seen=now))
            if key[0] == "source" and instance.last_ip and instance.last_ip != key[2]:
                logger.info("Instance %s (%s) now connects from %s (was %s)",
                            instance.name, instance.id, key[2], instance.last_ip)
        else:
            row.last_seen = now
            row.current = True
            session.add(row)
    for key, row in by_key.items():
        if key in seen or not row.current:
            continue
        # A new source IP replaces the old one; interfaces are replaced only
        # when facts were reported in this update
        if (key[0] == "source" and source_ip) or (key[0] == "interface" and facts is not None):
            row.current = False
            session.add(row)
    if source_ip:
        instance.last_ip = source_ip[:45]


def apply_facts(instance: Instance, facts: dict) -> None:
    raw = json.dumps(facts)
    if len(raw) > _MAX_FACTS:
        logger.warning("Facts of %s too large (%d bytes): ignored", instance.id, len(raw))
        return
    instance.facts_json = raw
    instance.hostname = _clip(facts.get("hostname"), 255)
    instance.machine_id = _clip(facts.get("machine_id"), 64)
    instance.madmin_version = _clip(facts.get("version"), 30)
    instance.build = _clip(facts.get("build"), 40)
    layout = facts.get("layout")
    instance.layout = layout if isinstance(layout, int) and not isinstance(layout, bool) else 0
    instance.os = _clip(facts.get("os"), 100)


async def clone_suspects(session, instance: Instance) -> list:
    """Other active instances with the same machine-id (a cloned VM)."""
    if not instance.machine_id:
        return []
    rows = (await session.execute(select(Instance.id, Instance.name).where(
        Instance.machine_id == instance.machine_id, Instance.id != instance.id,
        Instance.status == "active",
    ))).all()
    return [{"id": r[0], "name": r[1]} for r in rows]


async def revoke_certificates(session, instance_id: str) -> None:
    await session.execute(update(AgentCertificate).where(
        AgentCertificate.instance_id == instance_id, AgentCertificate.revoked == False  # noqa: E712
    ).values(revoked=True))


async def close_support_sessions(session, instance_id: str, by: str) -> None:
    from manager.support.service import stop_listener
    rows = (await session.execute(select(SupportSession).where(
        SupportSession.instance_id == instance_id, SupportSession.status == "open"
    ))).scalars().all()
    for s in rows:
        stop_listener(s.id)
        s.status = "closed"
        s.closed_at = datetime.utcnow()
        s.closed_by = by
        session.add(s)


async def suspend_instance(session, instance: Instance, by: str) -> None:
    """No connection and no command until resumed; the instance keeps its
    identity (it may still renew its certificate). Support sessions close."""
    instance.status = "suspended"
    session.add(instance)
    await close_support_sessions(session, instance.id, by)
    await session.commit()
    await registry.disconnect(instance.id, protocol.CLOSE_SUSPENDED, "suspended")
    logger.info("Instance %s (%s) suspended by %s", instance.name, instance.id, by)


async def resume_instance(session, instance: Instance, by: str) -> None:
    """Active again: the agent connects at its next attempt (within 15 minutes)."""
    instance.status = "active"
    session.add(instance)
    await session.commit()
    logger.info("Instance %s (%s) resumed by %s", instance.name, instance.id, by)


async def revoke_instance(session, instance: Instance, by: str, status: str = "revoked") -> None:
    instance.status = status
    session.add(instance)
    await revoke_certificates(session, instance.id)
    await close_support_sessions(session, instance.id, by)
    await session.commit()
    await registry.disconnect(instance.id, protocol.CLOSE_REVOKED, status)
    logger.info("Instance %s (%s) %s by %s", instance.name, instance.id, status, by)
