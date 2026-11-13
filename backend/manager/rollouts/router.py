"""
Rollouts API (ROADMAP 10.1). Updates, OS upgrades and reboots: superusers
only. Backups: any user who may manage instances, on the instances of their
scope (re-checked when each command is created, by the scope of the targets
chosen here).
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from manager import groups as manager_groups, scope
from manager.agents import protocol
from manager.agents.registry import registry
from manager.models import Instance, Release, Rollout, RolloutTarget
from .service import ACTIONS

router = APIRouter(prefix="/api", tags=["Rollouts"])

MAX_TARGETS = 5000


class Selection(BaseModel):
    group_id: Optional[str] = Field(default=None, max_length=36)       # subtree; "none" = no group
    labels: Dict[str, str] = Field(default_factory=dict)                 # all must match
    version_not: Optional[str] = Field(default=None, max_length=30)    # skip instances already on it
    os_id: Optional[str] = Field(default=None, max_length=30)
    instance_ids: List[str] = Field(default_factory=list, max_length=MAX_TARGETS)
    # Only instances with services running outdated libraries (needrestart)
    needs_service_restart: bool = False
    # Only instances whose reboot is "required" (Ubuntu's flag) or "recommended"
    # (it fixes critical/high kernel findings, or outdated microcode)
    reboot: str = Field(default="", pattern="^(|required|recommended)$")


class RolloutIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    action: str
    args: dict = Field(default_factory=dict)
    selection: Selection
    concurrency: int = Field(default=1, ge=1, le=50)
    canary: int = Field(default=1, ge=0, le=50)
    canary_wait_minutes: int = Field(default=0, ge=0, le=10080)
    fail_threshold: int = Field(default=10, ge=0, le=100)
    use_windows: bool = True
    expires_hours: int = Field(default=72, ge=1, le=720)
    # Nothing starts before it (ISO with time zone; naive = UTC); the expiry counts from it
    start_at: Optional[datetime] = None

    @field_validator("action")
    @classmethod
    def _action(cls, v):
        if v not in ACTIONS:
            raise ValueError("azione non prevista")
        return v


async def _resolve(session, user: Optional[User], sel: Selection) -> List[Instance]:
    """user None = every instance (a schedule, superuser only)."""
    ids = await scope.group_ids(session, user) if user is not None else None
    query = scope.filter_instances(select(Instance).where(Instance.status == "active"), ids)
    if sel.group_id == "none":
        query = query.where(Instance.group_id == None)  # noqa: E711
    elif sel.group_id:
        query = query.where(Instance.group_id.in_(await manager_groups.subtree_ids(session, sel.group_id)))
    if sel.instance_ids:
        query = query.where(Instance.id.in_(sel.instance_ids))
    rows = (await session.execute(query.order_by(Instance.name))).scalars().all()
    out = []
    for i in rows:
        labels = json.loads(i.labels_json or "{}")
        if any(labels.get(k.strip().lower()) != v.strip() for k, v in sel.labels.items()):
            continue
        if sel.version_not and f"{i.madmin_version}+{i.build}" == sel.version_not:
            continue
        facts = json.loads(i.facts_json or "{}")
        st = facts.get("os_status") or {}
        if sel.os_id and facts.get("os_id") != sel.os_id:
            continue
        if sel.needs_service_restart and not st.get("restart_services"):
            continue
        if sel.reboot == "required" and not st.get("reboot_required"):
            continue
        if sel.reboot == "recommended" and i.id not in await _reboot_recommended(session):
            continue
        out.append(i)
    return out[:MAX_TARGETS]


async def _reboot_recommended(session) -> set:
    """Instances where the reboot fixes critical/high findings, or the microcode is outdated."""
    from manager.models import Finding
    rows = (await session.execute(select(Finding.instance_id).where(
        Finding.status == "reboot", Finding.severity.in_(("critical", "high"))).distinct())).all()
    out = {r[0] for r in rows}
    for i in (await session.execute(select(Instance).where(Instance.status == "active"))).scalars():
        if (json.loads(i.facts_json or "{}").get("os_status") or {}).get("microcode_outdated"):
            out.add(i.id)
    return out


def _is_canary(i: Instance) -> bool:
    return str(json.loads(i.labels_json or "{}").get("canary", "")).lower() in ("true", "1", "yes", "si")


async def _check_args(session, body: RolloutIn) -> dict:
    a = body.args
    if body.action == protocol.CMD_UPDATE:
        rel = await session.get(Release, str(a.get("release_id", "")))
        if rel is None:
            raise HTTPException(404, "Release non trovata")
        out = {"release_id": rel.id}
        if a.get("deadline"):
            d = int(a["deadline"])
            if not 60 <= d <= 3600:
                raise HTTPException(400, "deadline: 60-3600 secondi")
            out["deadline"] = d
        return out
    if body.action == protocol.CMD_OS_UPGRADE:
        if a.get("scope") not in protocol.OS_UPGRADE_SCOPES:
            raise HTTPException(400, "scope: security o all")
        return {"scope": a["scope"]}
    if body.action == protocol.CMD_OS_REBOOT:
        reason = str(a.get("reason", "")).strip()
        if len(reason) < 3:
            raise HTTPException(400, "Motivo del riavvio obbligatorio")
        return {"reason": reason[:200]}
    return {}


def _targets_out(instances: List[Instance]) -> list:
    return [{"id": i.id, "name": i.name, "version": i.madmin_version, "build": i.build,
             "online": registry.is_online(i.id), "canary": _is_canary(i), "group_id": i.group_id} for i in instances]


@router.post("/rollouts/preview")
async def preview(body: Selection, session: AsyncSession = Depends(get_session),
                  user: User = Depends(require_permission("scope.manage"))):
    return _targets_out(await _resolve(session, user, body))


async def build(session, body: RolloutIn, user: Optional[User], created_by: str, schedule_id: str = "") -> Rollout:
    """A rollout from the request (or a schedule: user None, every instance)."""
    args = await _check_args(session, body)
    instances = await _resolve(session, user, body.selection)
    if not instances:
        raise HTTPException(400, "Nessuna istanza corrisponde alla selezione")
    # Canary: the instances labelled canary=true first, then the order chosen
    instances.sort(key=lambda i: (not _is_canary(i), i.name))
    canary = min(body.canary, len(instances))
    if body.action == protocol.CMD_UPDATE:
        rel = await session.get(Release, args["release_id"])
        if rel.channel != "stable" and len(instances) > 1 and not all(_is_canary(i) for i in instances):
            raise HTTPException(409, "Release candidate: solo su una istanza o su istanze con etichetta canary=true "
                                     "(promuoverla a stable per un rollout più ampio)")
    start_at = None
    if body.start_at is not None:
        start_at = body.start_at.astimezone(timezone.utc).replace(tzinfo=None) if body.start_at.tzinfo else body.start_at
        if start_at < datetime.utcnow() - timedelta(minutes=5):
            raise HTTPException(400, "L'ora di avvio è già passata")
    begin = max(start_at or datetime.utcnow(), datetime.utcnow())
    rollout = Rollout(name=body.name.strip(), action=body.action, args_json=json.dumps(args),
                      selection_json=body.selection.model_dump_json(), concurrency=body.concurrency,
                      canary=canary, canary_wait_minutes=body.canary_wait_minutes,
                      fail_threshold=body.fail_threshold, use_windows=body.use_windows, created_by=created_by,
                      start_at=start_at, schedule_id=schedule_id,
                      expires_at=begin + timedelta(hours=body.expires_hours))
    session.add(rollout)
    await session.flush()
    for n, i in enumerate(instances):
        session.add(RolloutTarget(rollout_id=rollout.id, instance_id=i.id, position=n, canary=n < canary))
    await session.commit()
    return rollout


@router.post("/rollouts", status_code=201)
async def create(body: RolloutIn, session: AsyncSession = Depends(get_session),
                 user: User = Depends(require_permission("scope.manage"))):
    if ACTIONS[body.action]["superuser"] and not user.has_permission("manager.manage"):
        raise HTTPException(403, "Solo un superuser può avviare aggiornamenti, upgrade del sistema e riavvii")
    rollout = await build(session, body, user, user.username)
    return await _out(session, rollout)


async def _visible(session, user: User, rollout_id: str) -> Rollout:
    rollout = await session.get(Rollout, rollout_id)
    if rollout is None:
        raise HTTPException(404, "Rollout non trovato")
    if not user.has_permission("manager.view"):
        # Others see a rollout only if every target is in their scope
        ids = await scope.group_ids(session, user)
        groups = (await session.execute(select(Instance.group_id).join(
            RolloutTarget, RolloutTarget.instance_id == Instance.id).where(RolloutTarget.rollout_id == rollout.id))).all()
        if any(g not in (ids or set()) for (g,) in groups):
            raise HTTPException(404, "Rollout non trovato")
    return rollout


async def _out(session, rollout: Rollout, targets: bool = False) -> dict:
    d = rollout.model_dump(exclude={"args_json", "selection_json"})
    d["args"] = json.loads(rollout.args_json)
    d["selection"] = json.loads(rollout.selection_json)
    d["label"] = ACTIONS[rollout.action]["label"]
    counts = dict((await session.execute(select(RolloutTarget.status, func.count()).where(
        RolloutTarget.rollout_id == rollout.id).group_by(RolloutTarget.status))).all())
    d["counts"] = {s: counts.get(s, 0) for s in ("pending", "running", "done", "failed", "skipped")}
    d["total"] = sum(counts.values())
    if targets:
        rows = (await session.execute(select(RolloutTarget, Instance.name).join(
            Instance, Instance.id == RolloutTarget.instance_id).where(RolloutTarget.rollout_id == rollout.id)
            .order_by(RolloutTarget.position))).all()
        d["targets"] = [{**t.model_dump(), "instance_name": n, "online": registry.is_online(t.instance_id)}
                        for t, n in rows]
    return d


@router.get("/rollouts")
async def list_rollouts(session: AsyncSession = Depends(get_session),
                        user: User = Depends(require_permission("scope.manage"))):
    rows = (await session.execute(select(Rollout).order_by(Rollout.created_at.desc()).limit(200))).scalars().all()
    out = []
    for r in rows:
        try:
            await _visible(session, user, r.id)
        except HTTPException:
            continue
        out.append(await _out(session, r))
    return out


@router.get("/rollouts/{rollout_id}")
async def get_rollout(rollout_id: str, session: AsyncSession = Depends(get_session),
                      user: User = Depends(require_permission("scope.manage"))):
    return await _out(session, await _visible(session, user, rollout_id), targets=True)


async def _manageable(session, user: User, rollout_id: str) -> Rollout:
    rollout = await _visible(session, user, rollout_id)
    if ACTIONS[rollout.action]["superuser"] and not user.has_permission("manager.manage"):
        raise HTTPException(403, "Solo un superuser")
    return rollout


@router.post("/rollouts/{rollout_id}/halt")
async def halt(rollout_id: str, session: AsyncSession = Depends(get_session),
               user: User = Depends(require_permission("scope.manage"))):
    rollout = await _manageable(session, user, rollout_id)
    if rollout.status not in ("running", "waiting"):
        raise HTTPException(409, "Rollout non in corso")
    rollout.status, rollout.halted_reason = "halted", f"fermato da {user.username}"
    session.add(rollout)
    await session.commit()
    return await _out(session, rollout)


@router.post("/rollouts/{rollout_id}/resume")
async def resume(rollout_id: str, session: AsyncSession = Depends(get_session),
                 user: User = Depends(require_permission("scope.manage"))):
    """A halted rollout goes on; a waiting one (canary done) goes past the canary.
    The stop threshold counts the failures again only from the targets
    finished after this point: the failed ones are retried with retry."""
    rollout = await _manageable(session, user, rollout_id)
    if rollout.status not in ("halted", "waiting"):
        raise HTTPException(409, "Rollout non fermo né in attesa")
    if rollout.status == "waiting":
        rollout.canary_wait_minutes = 0
    failed = (await session.execute(select(RolloutTarget).where(RolloutTarget.rollout_id == rollout.id,
                                                                RolloutTarget.status == "failed"))).scalars().all()
    if rollout.status == "halted" and failed:
        # Resuming accepts the failures seen so far: they no longer count
        for t in failed:
            t.status = "skipped"
            t.detail = f"fallito, escluso alla ripresa: {t.detail}"[:1000]
            session.add(t)
    rollout.status, rollout.halted_reason = "running", ""
    if rollout.expires_at < datetime.utcnow():
        rollout.expires_at = datetime.utcnow() + timedelta(hours=24)
    session.add(rollout)
    await session.commit()
    return await _out(session, rollout)


@router.post("/rollouts/{rollout_id}/retry")
async def retry(rollout_id: str, session: AsyncSession = Depends(get_session),
                user: User = Depends(require_permission("scope.manage"))):
    """The failed (and skipped) targets back to pending."""
    rollout = await _manageable(session, user, rollout_id)
    if rollout.status == "cancelled":
        raise HTTPException(409, "Rollout annullato")
    rows = (await session.execute(select(RolloutTarget).where(RolloutTarget.rollout_id == rollout.id,
                                                              RolloutTarget.status.in_(("failed", "skipped"))))).scalars().all()
    for t in rows:
        t.status, t.detail, t.command_id, t.started_at, t.finished_at = "pending", "", "", None, None
        session.add(t)
    rollout.status, rollout.halted_reason, rollout.finished_at = "running", "", None
    if rollout.expires_at < datetime.utcnow():
        rollout.expires_at = datetime.utcnow() + timedelta(hours=24)
    session.add(rollout)
    await session.commit()
    return await _out(session, rollout)


@router.post("/rollouts/{rollout_id}/cancel")
async def cancel(rollout_id: str, session: AsyncSession = Depends(get_session),
                 user: User = Depends(require_permission("scope.manage"))):
    """No new target starts; those running finish on their own."""
    rollout = await _manageable(session, user, rollout_id)
    if rollout.status in ("done", "cancelled"):
        raise HTTPException(409, "Rollout già concluso")
    rows = (await session.execute(select(RolloutTarget).where(RolloutTarget.rollout_id == rollout.id,
                                                              RolloutTarget.status == "pending"))).scalars().all()
    for t in rows:
        t.status, t.detail, t.finished_at = "skipped", f"annullato da {user.username}", datetime.utcnow()
        session.add(t)
    rollout.status, rollout.finished_at = "cancelled", datetime.utcnow()
    session.add(rollout)
    await session.commit()
    return await _out(session, rollout)


# --- Recurring schedules (superusers) ---

class ScheduleIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    action: str
    args: dict = Field(default_factory=dict)
    selection: Selection
    days: List[int] = Field(default_factory=lambda: list(range(7)))
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    concurrency: int = Field(default=1, ge=1, le=50)
    canary: int = Field(default=0, ge=0, le=50)
    fail_threshold: int = Field(default=10, ge=0, le=100)
    use_windows: bool = False
    expires_hours: int = Field(default=4, ge=1, le=72)
    enabled: bool = True

    @field_validator("action")
    @classmethod
    def _action(cls, v):
        if v not in ACTIONS:
            raise ValueError("azione non prevista")
        return v

    @field_validator("days")
    @classmethod
    def _days(cls, v):
        if not v or any(d not in range(7) for d in v):
            raise ValueError("giorni: da 0 (lunedì) a 6 (domenica)")
        return sorted(set(v))


def schedule_out(s) -> dict:
    d = s.model_dump(exclude={"args_json", "selection_json", "params_json", "days_json"})
    d.update(args=json.loads(s.args_json), selection=json.loads(s.selection_json),
             params=json.loads(s.params_json), days=json.loads(s.days_json), label=ACTIONS[s.action]["label"])
    from .service import next_run
    d["next_run"] = next_run(s)
    return d


@router.get("/rollout-schedules")
async def list_schedules(session: AsyncSession = Depends(get_session),
                         user: User = Depends(require_permission("manager.view"))):
    from manager.models import RolloutSchedule
    rows = (await session.execute(select(RolloutSchedule).order_by(RolloutSchedule.time))).scalars().all()
    return [schedule_out(s) for s in rows]


async def _save_schedule(session, body: ScheduleIn, user: User, row=None):
    from manager.models import RolloutSchedule
    probe = RolloutIn(name=body.name, action=body.action, args=body.args, selection=body.selection)
    args = await _check_args(session, probe)
    if body.action == protocol.CMD_UPDATE:
        rel = await session.get(Release, args["release_id"])
        if rel.channel != "stable":
            raise HTTPException(409, "Una pianificazione ripetuta richiede una release stable")
    row = row or RolloutSchedule(name="", action="", time="", created_by=user.username)
    row.name, row.action, row.time, row.enabled = body.name.strip(), body.action, body.time, body.enabled
    row.args_json = json.dumps(args)
    row.selection_json = body.selection.model_dump_json()
    row.days_json = json.dumps(body.days)
    row.params_json = json.dumps({k: getattr(body, k) for k in
                                  ("concurrency", "canary", "fail_threshold", "use_windows", "expires_hours")})
    session.add(row)
    await session.commit()
    return schedule_out(row)


@router.post("/rollout-schedules", status_code=201)
async def create_schedule(body: ScheduleIn, session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("manager.manage"))):
    return await _save_schedule(session, body, user)


@router.put("/rollout-schedules/{schedule_id}")
async def update_schedule(schedule_id: str, body: ScheduleIn, session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("manager.manage"))):
    from manager.models import RolloutSchedule
    row = await session.get(RolloutSchedule, schedule_id)
    if row is None:
        raise HTTPException(404, "Pianificazione non trovata")
    return await _save_schedule(session, body, user, row)


@router.delete("/rollout-schedules/{schedule_id}", status_code=204)
async def delete_schedule(schedule_id: str, session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("manager.manage"))):
    from manager.models import RolloutSchedule
    row = await session.get(RolloutSchedule, schedule_id)
    if row is None:
        raise HTTPException(404, "Pianificazione non trovata")
    await session.delete(row)
    await session.commit()
