"""
Inventory and vulnerabilities API (ROADMAP 8). Everything is filtered by the
caller's scope, like the instances: a partner sees the findings of its own
subtree only.
"""
import csv
import io
import json
from collections import Counter, defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.responses import StreamingResponse

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from manager import groups as manager_groups, scope
from manager.models import Advisory, Finding, Instance, InstanceInventory, InventoryChange
from . import osv

router = APIRouter(prefix="/api", tags=["Inventory"])

SEVERITY_ORDER = {s: n for n, s in enumerate(osv.SEVERITIES)}


def _facts(instance: Instance) -> dict:
    try:
        return json.loads(instance.facts_json or "{}")
    except ValueError:
        return {}


async def _instances(session, user: User, group_id: Optional[str]) -> list:
    query = scope.filter_instances(select(Instance).where(Instance.status.in_(("active", "suspended"))),
                                   await scope.group_ids(session, user))
    if group_id == "none":
        query = query.where(Instance.group_id == None)  # noqa: E711
    elif group_id:
        query = query.where(Instance.group_id.in_(await manager_groups.subtree_ids(session, group_id)))
    return (await session.execute(query.order_by(Instance.name))).scalars().all()


async def _findings(session, instance_ids: list, severity: str = "", fixable: bool = False) -> list:
    if not instance_ids:
        return []
    query = select(Finding, Advisory).join(Advisory, Advisory.id == Finding.advisory_id) \
        .where(Finding.instance_id.in_(instance_ids))
    if severity:
        query = query.where(Finding.severity.in_(severity.split(",")))
    if fixable:
        query = query.where(Finding.fixed_version != "")
    return (await session.execute(query)).all()


def _finding_out(f: Finding, a: Advisory) -> dict:
    return {
        "advisory_id": a.id, "cves": json.loads(a.aliases_json), "summary": a.summary, "url": a.url,
        "severity": f.severity, "kind": f.kind, "package": f.package,
        "installed_version": f.installed_version, "fixed_version": f.fixed_version,
        "first_seen": f.first_seen, "published": a.published,
    }


def _os_status(instance: Instance) -> dict:
    return _facts(instance).get("os_status") or {}


# --- One instance ---

@router.get("/instances/{instance_id}/inventory")
async def instance_inventory(instance_id: str, session: AsyncSession = Depends(get_session),
                             user: User = Depends(require_permission("scope.view"))):
    instance = await scope.get_instance(session, user, instance_id)
    rows = (await session.execute(select(InstanceInventory).where(
        InstanceInventory.instance_id == instance.id))).scalars().all()
    facts = _facts(instance)
    findings = await _findings(session, [instance.id])
    by_sev = Counter(f.severity for f, _ in findings)
    return {
        "os": facts.get("os"), "os_id": facts.get("os_id"), "kernel": facts.get("kernel"),
        "os_status": facts.get("os_status") or {},
        "sections": {r.section: {"count": len(json.loads(r.items_json)) if r.digest else 0,
                                 "updated_at": r.updated_at if r.digest else None,
                                 "pending": bool(r.wanted_digest)} for r in rows},
        "findings": {s: by_sev.get(s, 0) for s in osv.SEVERITIES},
        "fixable": sum(1 for f, _ in findings if f.fixed_version),
    }


@router.get("/instances/{instance_id}/inventory/changes")
async def instance_changes(instance_id: str, limit: int = Query(default=50, ge=1, le=200),
                           session: AsyncSession = Depends(get_session),
                           user: User = Depends(require_permission("scope.view"))):
    instance = await scope.get_instance(session, user, instance_id)
    rows = (await session.execute(select(InventoryChange).where(InventoryChange.instance_id == instance.id)
                                  .order_by(InventoryChange.at.desc()).limit(limit))).scalars().all()
    return [{"section": r.section, "at": r.at, "changes": json.loads(r.changes_json)} for r in rows]


@router.get("/instances/{instance_id}/inventory/{section}")
async def instance_section(instance_id: str, section: str, q: str = Query(default="", max_length=100),
                           session: AsyncSession = Depends(get_session),
                           user: User = Depends(require_permission("scope.view"))):
    instance = await scope.get_instance(session, user, instance_id)
    row = await session.get(InstanceInventory, (instance.id, section))
    if row is None or not row.digest:
        return []
    items = json.loads(row.items_json)
    if q:
        ql = q.lower()
        items = [i for i in items if ql in str(i.get("name", "")).lower() or ql in str(i.get("source", "")).lower()]
    return items


@router.get("/instances/{instance_id}/findings")
async def instance_findings(instance_id: str, session: AsyncSession = Depends(get_session),
                            user: User = Depends(require_permission("scope.view"))):
    instance = await scope.get_instance(session, user, instance_id)
    rows = await _findings(session, [instance.id])
    out = [_finding_out(f, a) for f, a in rows]
    return sorted(out, key=lambda x: (SEVERITY_ORDER.get(x["severity"], 9), not x["fixed_version"], x["package"]))


# --- Fleet ---

@router.get("/vulnerabilities/summary")
async def summary(group_id: Optional[str] = Query(default=None, max_length=36),
                  session: AsyncSession = Depends(get_session),
                  user: User = Depends(require_permission("scope.view"))):
    instances = await _instances(session, user, group_id)
    findings = await _findings(session, [i.id for i in instances])
    advisories_by_sev = defaultdict(set)
    instances_by_sev = defaultdict(set)
    for f, _ in findings:
        advisories_by_sev[f.severity].add(f.advisory_id)
        instances_by_sev[f.severity].add(f.instance_id)
    statuses = [_os_status(i) for i in instances]
    return {
        "instances": len(instances),
        "scanned": len({f.instance_id for f, _ in findings}),
        "advisories": {s: len(advisories_by_sev[s]) for s in osv.SEVERITIES},
        "instances_affected": {s: len(instances_by_sev[s]) for s in osv.SEVERITIES},
        "fixable_instances": len({f.instance_id for f, _ in findings if f.fixed_version
                                  and f.severity in ("critical", "high")}),
        "reboot_required": sum(1 for s in statuses if s.get("reboot_required")),
        "pending_security": sum(1 for s in statuses if (s.get("pending_security") or 0) > 0),
        "scan": dict(osv.state),
    }


@router.get("/vulnerabilities/advisories")
async def advisories(group_id: Optional[str] = Query(default=None, max_length=36),
                     severity: str = Query(default="", max_length=60),
                     fixable: bool = False, q: str = Query(default="", max_length=100),
                     session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("scope.view"))):
    instances = await _instances(session, user, group_id)
    rows = await _findings(session, [i.id for i in instances], severity, fixable)
    agg = {}
    for f, a in rows:
        e = agg.setdefault(a.id, {"advisory_id": a.id, "cves": json.loads(a.aliases_json), "summary": a.summary,
                                  "severity": a.severity, "url": a.url, "packages": set(), "instances": set(),
                                  "fixable": 0, "kind": f.kind})
        e["packages"].add(f.package)
        e["instances"].add(f.instance_id)
        e["fixable"] += 1 if f.fixed_version else 0
    out = []
    ql = q.lower()
    for e in agg.values():
        if ql and ql not in e["advisory_id"].lower() and not any(ql in c.lower() for c in e["cves"]) \
                and not any(ql in p.lower() for p in e["packages"]):
            continue
        out.append({**e, "packages": sorted(e["packages"]), "instances": len(e["instances"])})
    return sorted(out, key=lambda x: (SEVERITY_ORDER.get(x["severity"], 9), -x["instances"], x["advisory_id"]))[:2000]


@router.get("/vulnerabilities/advisories/{advisory_id}")
async def advisory_detail(advisory_id: str, group_id: Optional[str] = Query(default=None, max_length=36),
                          session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("scope.view"))):
    instances = {i.id: i for i in await _instances(session, user, group_id)}
    rows = (await session.execute(select(Finding).where(Finding.advisory_id == advisory_id,
                                                        Finding.instance_id.in_(list(instances) or [""])))).scalars().all()
    adv = await session.get(Advisory, advisory_id)
    if adv is None or not rows:
        raise HTTPException(404, "Vulnerabilità non trovata")
    return {
        "advisory_id": adv.id, "cves": json.loads(adv.aliases_json), "summary": adv.summary, "url": adv.url,
        "severity": adv.severity, "published": adv.published, "modified": adv.modified,
        "instances": [{"id": f.instance_id, "name": instances[f.instance_id].name, "package": f.package,
                       "installed_version": f.installed_version, "fixed_version": f.fixed_version,
                       "first_seen": f.first_seen} for f in rows],
    }


@router.get("/vulnerabilities/instances")
async def fleet_instances(group_id: Optional[str] = Query(default=None, max_length=36),
                          session: AsyncSession = Depends(get_session),
                          user: User = Depends(require_permission("scope.view"))):
    instances = await _instances(session, user, group_id)
    findings = await _findings(session, [i.id for i in instances])
    counts = defaultdict(Counter)
    fixable = Counter()
    for f, _ in findings:
        counts[f.instance_id][f.severity] += 1
        if f.fixed_version:
            fixable[f.instance_id] += 1
    out = []
    for i in instances:
        facts = _facts(i)
        st = facts.get("os_status") or {}
        out.append({
            "id": i.id, "name": i.name, "group_id": i.group_id, "status": i.status,
            "version": i.madmin_version, "os": facts.get("os"), "os_id": facts.get("os_id"),
            "kernel": facts.get("kernel"), "newest_kernel": st.get("newest_kernel"),
            "reboot_required": st.get("reboot_required"), "pending_updates": st.get("pending_updates"),
            "pending_security": st.get("pending_security"), "apt_updated_at": st.get("apt_updated_at"),
            "unattended_upgrades": st.get("unattended_upgrades"),
            "findings": {s: counts[i.id].get(s, 0) for s in osv.SEVERITIES}, "fixable": fixable[i.id],
        })
    return out


@router.get("/vulnerabilities/versions")
async def versions(group_id: Optional[str] = Query(default=None, max_length=36),
                   session: AsyncSession = Depends(get_session),
                   user: User = Depends(require_permission("scope.view"))):
    instances = await _instances(session, user, group_id)
    madmin, os_, kernel = Counter(), Counter(), Counter()
    for i in instances:
        facts = _facts(i)
        madmin[f"{i.madmin_version or '?'}" + (f"+{i.build}" if i.build else "")] += 1
        os_[facts.get("os_id") or "?"] += 1
        kernel[facts.get("kernel") or "?"] += 1
    fmt = lambda c: [{"value": k, "count": v} for k, v in c.most_common()]  # noqa: E731
    return {"madmin": fmt(madmin), "os": fmt(os_), "kernel": fmt(kernel)}


@router.get("/vulnerabilities/export.csv")
async def export_csv(group_id: Optional[str] = Query(default=None, max_length=36),
                     session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("scope.view"))):
    instances = {i.id: i for i in await _instances(session, user, group_id)}
    rows = await _findings(session, list(instances))
    out = io.StringIO()
    w = csv.writer(out, delimiter=";")
    w.writerow(["istanza", "id_istanza", "severita", "advisory", "cve", "tipo", "pacchetto",
                "versione_installata", "versione_corretta", "prima_rilevazione"])
    for f, a in sorted(rows, key=lambda r: (instances[r[0].instance_id].name, SEVERITY_ORDER.get(r[0].severity, 9))):
        cells = [instances[f.instance_id].name, f.instance_id, f.severity, a.id, " ".join(json.loads(a.aliases_json)),
                 f.kind, f.package, f.installed_version, f.fixed_version, f.first_seen.isoformat()]
        # Spreadsheet formula injection: a cell never starts with = + - @
        w.writerow([("'" + c) if isinstance(c, str) and c[:1] in ("=", "+", "-", "@") else c for c in cells])
    return StreamingResponse(iter([out.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=vulnerabilita.csv"})


@router.post("/vulnerabilities/scan")
async def scan_now(session: AsyncSession = Depends(get_session),
                   user: User = Depends(require_permission("manager.manage"))):
    if osv.state.get("running"):
        raise HTTPException(409, "Scansione già in corso")
    instances = (await session.execute(select(Instance.id).where(Instance.status.in_(("active", "suspended"))))).all()
    for (iid,) in instances:
        osv.mark_dirty(iid)
    return {"queued": len(instances)}
