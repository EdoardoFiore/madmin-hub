"""
Rollouts (ROADMAP 10.1): one action on a set of instances.

Order: the canary targets first (alone), then, once they all succeeded and the
canary wait passed (or a superuser confirmed), the others. At most
`concurrency` targets run at once; only instances online now are started (an
offline one waits for its turn while it is offline, and is skipped when the
rollout expires); a target whose group is outside its maintenance window waits
for it. Above `fail_threshold` % of failures among the finished targets the
rollout halts; it can be resumed, and its failed targets retried.

Each target is an ordinary persistent command; its outcome:

    madmin.update   the instance's update journal for that release: ok, or
                    rolled_back / failed (the command only says it started)
    os.upgrade, os.reboot, backup.run   the command's result
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlmodel import select

from core.database import async_session_maker

from manager.agents import protocol
from manager.agents.dispatcher import queue_command
from manager.agents.registry import registry
from manager.models import Command, Instance, InstanceGroup, Release, Rollout, RolloutTarget

logger = logging.getLogger("madmin_manager.rollouts")

LOOP_INTERVAL = 15
ACTIONS = {
    protocol.CMD_UPDATE: {"label": "Aggiornamento MADMIN", "superuser": True, "timeout": 1800},
    protocol.CMD_OS_UPGRADE: {"label": "Aggiornamento pacchetti", "superuser": True, "timeout": 5400},
    protocol.CMD_OS_REBOOT: {"label": "Riavvio", "superuser": True, "timeout": 120},
    protocol.CMD_BACKUP_RUN: {"label": "Backup", "superuser": False, "timeout": 1800},
    protocol.CMD_OS_SERVICES_RESTART: {"label": "Riavvio servizi", "superuser": True, "timeout": 300},
}
# How long a target command may wait to be delivered (the instance was online
# when it was sent; a short outage is tolerated, a reboot hours later is not)
COMMAND_TTL = timedelta(minutes=15)
FINISHED = ("done", "failed", "skipped")


def in_window(window: dict, now: Optional[datetime] = None) -> bool:
    """{"days": [0-6], "start": "HH:MM", "end": "HH:MM"} in local time; {} = always.
    A window that ends before it starts crosses midnight (22:00-04:00): the
    day is the day it started."""
    if not window or not window.get("start") or not window.get("end"):
        return True
    now = now or datetime.now()
    days = window.get("days") or list(range(7))
    sh, sm = (int(x) for x in window["start"].split(":"))
    eh, em = (int(x) for x in window["end"].split(":"))
    start, end = sh * 60 + sm, eh * 60 + em
    minute = now.hour * 60 + now.minute
    if start <= end:
        return now.weekday() in days and start <= minute < end
    # crosses midnight
    if minute >= start:
        return now.weekday() in days
    return minute < end and (now.weekday() - 1) % 7 in days


async def group_windows(session) -> dict:
    """group_id -> window, a customer without one inheriting its partner's."""
    groups = {g.id: g for g in (await session.execute(select(InstanceGroup))).scalars()}
    out = {}
    for gid, g in groups.items():
        w = json.loads(g.maintenance_json or "{}")
        if not w and g.parent_id and g.parent_id in groups:
            w = json.loads(groups[g.parent_id].maintenance_json or "{}")
        out[gid] = w
    return out


def command_args(rollout: Rollout) -> dict:
    return json.loads(rollout.args_json or "{}")


async def _start_target(session, rollout: Rollout, target: RolloutTarget, instance: Instance) -> None:
    args = command_args(rollout)
    if rollout.action == protocol.CMD_UPDATE:
        rel = await session.get(Release, args["release_id"])
        if instance.build == (rel.build if rel else None):
            target.status, target.detail = "skipped", "release già installata"
            target.finished_at = datetime.utcnow()
            session.add(target)
            return
        cmd_args = {"release_id": rel.id, "sha256": rel.sha256}
        if args.get("deadline"):
            cmd_args["deadline"] = args["deadline"]
    elif rollout.action == protocol.CMD_OS_UPGRADE:
        cmd_args = {"scope": args["scope"]}
    elif rollout.action == protocol.CMD_OS_REBOOT:
        cmd_args = {"delay_minutes": 0, "reason": args.get("reason") or rollout.name}
    elif rollout.action == protocol.CMD_OS_SERVICES_RESTART:
        st = (json.loads(instance.facts_json or "{}").get("os_status") or {})
        if not st.get("restart_services"):
            target.status, target.detail = "skipped", "nessun servizio da riavviare"
            target.finished_at = datetime.utcnow()
            session.add(target)
            return
        cmd_args = {}
    else:
        cmd_args = {}
    conn = registry.get(instance.id)
    if conn is not None and not conn.supports(rollout.action):
        target.status, target.detail = "skipped", "comando non supportato dalla versione di MADMIN"
        target.finished_at = datetime.utcnow()
        session.add(target)
        return
    cmd = await queue_command(session, instance.id, rollout.action, cmd_args,
                              operator=f"{rollout.created_by} (rollout)"[:100], ttl=COMMAND_TTL,
                              timeout=ACTIONS[rollout.action]["timeout"])
    target.status = "running"
    target.command_id = cmd.id
    target.started_at = datetime.utcnow()
    target.detail = ""
    session.add(target)
    logger.info("Rollout %s: %s on %s", rollout.id[:8], rollout.action, instance.name)


async def _outcome(session, rollout: Rollout, target: RolloutTarget) -> Optional[tuple]:
    """(status, detail) once a running target finished, else None."""
    cmd = await session.get(Command, target.command_id) if target.command_id else None
    if cmd is None:
        return "failed", "comando non trovato"
    if cmd.status in ("failed", "expired"):
        return "failed", (cmd.error or cmd.status)[:1000]
    if cmd.status != "done":
        return None
    if rollout.action == protocol.CMD_UPDATE:
        instance = await session.get(Instance, target.instance_id)
        update = json.loads(instance.update_json or "{}")
        rid = command_args(rollout).get("release_id")
        if update.get("release_id") != rid:
            # Started, the journal of this update not reported yet
            return None if datetime.utcnow() - cmd.finished_at < timedelta(hours=2) else ("failed", "esito non ricevuto")
        if update.get("result") == "ok":
            return "done", ""
        if update.get("result") in ("rolled_back", "failed"):
            return "failed", f"{update['result']}: {update.get('detail', '')}"[:1000]
        return None
    return "done", ""


async def tick() -> None:
    async with async_session_maker() as session:
        # Halted and cancelled ones only follow their running targets to the end
        rollouts = (await session.execute(select(Rollout).where(
            Rollout.status.in_(("running", "waiting", "halted", "cancelled"))))).scalars().all()
        if not rollouts:
            return
        windows = await group_windows(session)
        for rollout in rollouts:
            try:
                await _advance(session, rollout, windows)
            except Exception:
                logger.exception("Rollout %s: error", rollout.id)
            await session.commit()


async def _advance(session, rollout: Rollout, windows: dict) -> None:
    targets = (await session.execute(select(RolloutTarget).where(RolloutTarget.rollout_id == rollout.id)
                                     .order_by(RolloutTarget.position))).scalars().all()
    now = datetime.utcnow()
    # Outcomes of the running ones
    for t in targets:
        if t.status == "running":
            res = await _outcome(session, rollout, t)
            if res:
                t.status, t.detail = res
                t.finished_at = now
                session.add(t)
    if rollout.status in ("halted", "cancelled"):
        return
    if rollout.start_at and now < rollout.start_at:
        return   # scheduled: waits for its time
    finished = [t for t in targets if t.status in ("done", "failed")]
    failed = [t for t in finished if t.status == "failed"]
    # Stop threshold (over the finished ones; one failure in the canary is enough)
    canary_targets = [t for t in targets if t.canary]
    if any(t.status == "failed" for t in canary_targets):
        return _halt(session, rollout, "fallito nel gruppo canary")
    if finished and len(failed) * 100 > rollout.fail_threshold * len(finished):
        return _halt(session, rollout, f"{len(failed)} falliti su {len(finished)} conclusi "
                                       f"(soglia {rollout.fail_threshold}%)")
    pending = [t for t in targets if t.status == "pending"]
    running = [t for t in targets if t.status == "running"]
    # Expired: what has not started is skipped
    if now >= rollout.expires_at:
        for t in pending:
            t.status, t.detail, t.finished_at = "skipped", "rollout scaduto prima dell'avvio", now
            session.add(t)
        pending = []
    if not pending and not running:
        rollout.status = "done"
        rollout.finished_at = now
        session.add(rollout)
        logger.info("Rollout %s done", rollout.id[:8])
        return
    # Canary phase: only canary targets until they all finished well
    canary_open = [t for t in canary_targets if t.status in ("pending", "running")]
    if canary_targets and not canary_open and rollout.canary_done_at is None:
        rollout.canary_done_at = now
        if rollout.canary_wait_minutes == 0:
            rollout.status = "waiting"
            from manager.notify import notify
            notify("rollout-canary", rollout.id, f"Rollout in attesa: {rollout.name}",
                   f"Il canary del rollout \"{rollout.name}\" è concluso senza errori: confermare in Rollout "
                   "per proseguire con le altre istanze.")
        session.add(rollout)
    if rollout.status == "waiting":
        return
    if canary_targets and (canary_open or (rollout.canary_done_at and
                                           now - rollout.canary_done_at < timedelta(minutes=rollout.canary_wait_minutes))):
        candidates = [t for t in pending if t.canary]
    else:
        candidates = pending
    slots = rollout.concurrency - len(running)
    for t in candidates:
        if slots <= 0:
            break
        instance = await session.get(Instance, t.instance_id)
        if instance is None or instance.status != "active":
            t.status, t.detail, t.finished_at = "skipped", "istanza non attiva", now
            session.add(t)
            continue
        if not registry.is_online(instance.id):
            continue
        if rollout.use_windows and not in_window(windows.get(instance.group_id) or {}):
            continue
        await _start_target(session, rollout, t, instance)
        if t.status == "running":
            slots -= 1


def _halt(session, rollout: Rollout, reason: str) -> None:
    rollout.status = "halted"
    rollout.halted_reason = reason[:500]
    session.add(rollout)
    logger.warning("Rollout %s halted: %s", rollout.id[:8], reason)
    from manager.notify import notify
    notify("rollout", rollout.id, f"Rollout fermato: {rollout.name}",
           f"Il rollout \"{rollout.name}\" ({rollout.action}) si è fermato: {reason}.\nDettagli in Rollout.")


# --- Recurring schedules ---

SCHEDULE_GRACE = timedelta(minutes=60)   # a slot missed while the manager was down still runs within it


def _slot(s, day: datetime) -> datetime:
    h, m = (int(x) for x in s.time.split(":"))
    return day.replace(hour=h, minute=m, second=0, microsecond=0)


def next_run(s) -> Optional[str]:
    """Next local time a schedule creates its rollout (ISO), or None when disabled."""
    if not s.enabled:
        return None
    days = json.loads(s.days_json)
    now = datetime.now()
    for n in range(8):
        slot = _slot(s, now + timedelta(days=n))
        if slot.weekday() in days and slot > now and slot.date().isoformat() != s.last_run_on:
            return slot.isoformat(timespec="minutes")
    return None


async def schedule_tick() -> None:
    from manager.models import RolloutSchedule
    from .router import RolloutIn, Selection, build
    now = datetime.now()
    today = now.date().isoformat()
    async with async_session_maker() as session:
        rows = (await session.execute(select(RolloutSchedule).where(RolloutSchedule.enabled == True)))\
            .scalars().all()  # noqa: E712
        for s in rows:
            slot = _slot(s, now)
            if now.weekday() not in json.loads(s.days_json) or s.last_run_on == today \
                    or not slot <= now < slot + SCHEDULE_GRACE:
                continue
            s.last_run_on = today
            params = json.loads(s.params_json)
            try:
                body = RolloutIn(name=f"{s.name} ({today} {s.time})", action=s.action, args=json.loads(s.args_json),
                                 selection=Selection(**json.loads(s.selection_json)), **params)
                rollout = await build(session, body, None, f"{s.created_by} (pianificazione)", schedule_id=s.id)
                s.last_rollout_id = rollout.id
                logger.info("Schedule %s: rollout %s created", s.name, rollout.id[:8])
            except Exception as e:
                # e.g. no instance matches tonight: nothing to do, not an error
                logger.info("Schedule %s: no rollout (%s)", s.name, getattr(e, "detail", e))
            session.add(s)
            await session.commit()


async def rollout_task() -> None:
    while True:
        await asyncio.sleep(LOOP_INTERVAL)
        try:
            await schedule_tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Rollout schedules error")
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Rollout scheduler error")
