"""
Time of the automatic security updates of the instances.

Ubuntu's unattended-upgrades installs the security updates every day, and
needrestart restarts the services that use them; the instance never reboots
by itself (MADMIN's apt policy). The manager only chooses when: Settings give
the default time and time zone, a group may set its own time (a customer
without one takes its partner's). The time an instance applies is in its
facts (os_status.autoupdate): when it differs, os.autoupdate.set is queued.
"""
import json
import logging
from datetime import timedelta
from typing import Optional

from sqlmodel import select

from manager.agents import protocol
from manager.agents.dispatcher import queue_command
from manager.agents.registry import registry
from manager.models import Command, Instance, InstanceGroup

logger = logging.getLogger("madmin_manager.osactions")

TTL = timedelta(days=1)


async def desired(session, instance: Instance, settings=None) -> dict:
    if settings is None:
        from core.settings.router import get_system_settings
        settings = await get_system_settings(session)
    time = ""
    if instance.group_id:
        group = await session.get(InstanceGroup, instance.group_id)
        time = group.autoupdate_time if group else ""
        if not time and group and group.parent_id:
            parent = await session.get(InstanceGroup, group.parent_id)
            time = parent.autoupdate_time if parent else ""
    return {"time": time or settings.autoupdate_time, "tz": settings.autoupdate_tz,
            "randomize_minutes": settings.autoupdate_randomize}


def applied(instance: Instance) -> Optional[dict]:
    facts = json.loads(instance.facts_json or "{}")
    au = (facts.get("os_status") or {}).get("autoupdate")
    return au if isinstance(au, dict) else None


async def reconcile(session, instance: Instance, settings=None) -> bool:
    """Queue os.autoupdate.set when the instance applies another time; True if queued."""
    conn = registry.get(instance.id)
    if instance.status != "active" or conn is None or not conn.supports(protocol.CMD_OS_AUTOUPDATE_SET):
        return False
    now = applied(instance)
    want = await desired(session, instance, settings)
    if now is not None and all(now.get(k) == want[k] for k in want):
        return False
    pending = (await session.execute(select(Command.id).where(
        Command.instance_id == instance.id, Command.name == protocol.CMD_OS_AUTOUPDATE_SET,
        Command.status.in_(("queued", "sent", "running")), Command.args_json == json.dumps(want)))).first()
    if pending:
        return False
    await queue_command(session, instance.id, protocol.CMD_OS_AUTOUPDATE_SET, want, operator="manager", ttl=TTL)
    logger.info("Instance %s: automatic updates at %s %s", instance.name, want["time"], want["tz"])
    return True


async def reconcile_all(session) -> int:
    """After a change of Settings or of a group's time: every connected instance."""
    from core.settings.router import get_system_settings
    settings = await get_system_settings(session)
    rows = (await session.execute(select(Instance).where(Instance.status == "active"))).scalars().all()
    n = 0
    for inst in rows:
        n += await reconcile(session, inst, settings)
    return n
