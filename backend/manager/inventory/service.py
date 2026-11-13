"""
Heavy sections of the facts (ROADMAP 8.1): the facts carry only their digest
(facts.sections = {"packages": "<sha256>", "python": "<sha256>"}); when one
differs from what is stored, the manager fetches the section with
inventory.get. Each fetch records what changed (InventoryChange) and marks the
instance for a vulnerability scan (osv.py).
"""
import json
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlmodel import select

from core.database import async_session_maker

from manager.agents import protocol
from manager.agents.dispatcher import RESULT_HOOKS, queue_command
from manager.agents.registry import registry
from manager.models import Command, InstanceInventory, InventoryChange

logger = logging.getLogger("madmin_manager.inventory")

GET_TTL = timedelta(hours=6)
# Sections that describe what is installed: history and vulnerability scan
HISTORY_SECTIONS = ("packages", "python")
MAX_ITEMS = 20000
MAX_CHANGES_KEPT = 200     # per instance and section


def _key(section: str, item: dict) -> str:
    if section == "packages":
        return f"{item.get('name')}:{item.get('arch')}"
    return str(item.get("name", "")).lower()


def diff(section: str, old: list, new: list) -> list:
    before = {_key(section, i): i.get("version", "") for i in old}
    after = {_key(section, i): i.get("version", "") for i in new}
    changes = []
    for k in sorted(before.keys() | after.keys()):
        a, b = before.get(k, ""), after.get(k, "")
        if a != b:
            changes.append({"name": k, "from": a, "to": b})
    return changes


async def sections_announced(session, instance_id: str, sections) -> None:
    """Facts arrived: fetch every section whose digest is not the stored one
    (unless a fetch for it is already queued)."""
    if not isinstance(sections, dict):
        return
    conn = registry.get(instance_id)
    for name in protocol.INVENTORY_SECTIONS:
        digest = sections.get(name)
        if not isinstance(digest, str) or not digest:
            continue
        row = await session.get(InstanceInventory, (instance_id, name))
        if row is not None and row.digest == digest:
            if row.wanted_digest:
                row.wanted_digest = ""
                session.add(row)
            continue
        if row is None:
            row = InstanceInventory(instance_id=instance_id, section=name)
        if row.wanted_digest == digest:
            continue   # already asked for this one
        row.wanted_digest = digest[:64]
        session.add(row)
        await session.commit()
        pending = (await session.execute(select(Command.id).where(
            Command.instance_id == instance_id, Command.name == protocol.CMD_INVENTORY_GET,
            Command.status.in_(("queued", "sent", "running")), Command.args_json == json.dumps({"section": name}),
        ))).first()
        if pending is None and (conn is None or conn.supports(protocol.CMD_INVENTORY_GET)):
            await queue_command(session, instance_id, protocol.CMD_INVENTORY_GET, {"section": name},
                                operator="manager", ttl=GET_TTL)
    await session.commit()


async def _on_inventory_get(instance_id: str, data: dict) -> dict:
    """Result hook: store the section; the command keeps only a summary."""
    name = data.get("section")
    items = data.get("items")
    if name not in protocol.INVENTORY_SECTIONS or not isinstance(items, list):
        return {"error": "risultato non valido"}
    items = [i for i in items[:MAX_ITEMS] if isinstance(i, dict)]
    digest = str(data.get("digest", ""))[:64]
    async with async_session_maker() as session:
        row = await session.get(InstanceInventory, (instance_id, name))
        old = json.loads(row.items_json) if row is not None and row.digest else None
        if row is None:
            row = InstanceInventory(instance_id=instance_id, section=name)
        row.items_json = json.dumps(items)
        row.digest = digest
        row.updated_at = datetime.utcnow()
        if row.wanted_digest == digest:
            row.wanted_digest = ""
        session.add(row)
        # The upgrades section is a forecast, not a change of the instance: no history
        changes = diff(name, old, items) if old is not None and name in HISTORY_SECTIONS else []
        if changes:
            session.add(InventoryChange(instance_id=instance_id, section=name,
                                        changes_json=json.dumps(changes[:5000])))
        await session.commit()
        await _prune_changes(session, instance_id, name)
    if name in HISTORY_SECTIONS:
        from . import osv
        osv.mark_dirty(instance_id)
    logger.info("Inventory %s of %s: %d items, %d changes", name, instance_id, len(items), len(changes))
    return {"section": name, "digest": digest, "count": len(items), "changes": len(changes)}


async def _prune_changes(session, instance_id: str, section: str) -> None:
    rows = (await session.execute(
        select(InventoryChange.id).where(InventoryChange.instance_id == instance_id,
                                         InventoryChange.section == section)
        .order_by(InventoryChange.at.desc()).offset(MAX_CHANGES_KEPT)
    )).all()
    for (cid,) in rows:
        await session.delete(await session.get(InventoryChange, cid))
    if rows:
        await session.commit()


RESULT_HOOKS[protocol.CMD_INVENTORY_GET] = _on_inventory_get


async def section_items(session, instance_id: str, section: str) -> Optional[list]:
    row = await session.get(InstanceInventory, (instance_id, section))
    return json.loads(row.items_json) if row is not None and row.digest else None
