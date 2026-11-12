"""
Vulnerability scan against OSV (https://osv.dev): the Ubuntu security data
for the OS packages (by source package, ecosystem Ubuntu:<release>[:LTS])
and the Python advisories (PyPI) for the venv of the release.

Only the manager talks to OSV (it may be the only machine with outbound
access). Answers are cached: a package version is asked again after
QUERY_MAX_AGE, an advisory is fetched again when OSV reports it modified.
An instance is scanned when one of its sections changes (mark_dirty) and every
instance once a day. The findings of an instance are the advisories that
affect its packages now; first_seen survives the recomputation.
"""
import asyncio
import json
import logging
import math
import re
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Set, Tuple

import httpx
from sqlalchemy import delete
from sqlmodel import select

from core.database import async_session_maker

from manager.models import Advisory, Finding, Instance, InstanceInventory, OsvQuery

logger = logging.getLogger("madmin_manager.osv")

API = "https://api.osv.dev/v1"
BATCH = 500
QUERY_MAX_AGE = timedelta(hours=20)
DAILY = timedelta(hours=24)
LOOP_INTERVAL = 60
FETCH_CONCURRENCY = 8
SEVERITIES = ("critical", "high", "medium", "low", "negligible", "unknown")

_dirty: Set[str] = set()
_last_full: Optional[datetime] = None
state = {"last_scan_at": None, "last_error": "", "running": False}


def mark_dirty(instance_id: str) -> None:
    _dirty.add(instance_id)


def ubuntu_ecosystem(os_id: str) -> Optional[str]:
    """ubuntu-24.04 -> Ubuntu:24.04:LTS (even year, April release); non-LTS without the suffix."""
    if not os_id.startswith("ubuntu-"):
        return None
    version = os_id[len("ubuntu-"):]
    try:
        year, month = (int(x) for x in version.split(".")[:2])
    except ValueError:
        return None
    return f"Ubuntu:{version}:LTS" if month == 4 and year % 2 == 0 else f"Ubuntu:{version}"


def _severity(vuln: dict) -> str:
    """Ubuntu priority, GitHub severity, or a CVSS score; else unknown."""
    for s in vuln.get("severity") or []:
        if s.get("type") == "Ubuntu" and str(s.get("score", "")).lower() in SEVERITIES:
            return str(s["score"]).lower()
    ds = (vuln.get("database_specific") or {}).get("severity")
    if isinstance(ds, str):
        return {"moderate": "medium"}.get(ds.lower(), ds.lower()) if ds.lower() in (
            "critical", "high", "moderate", "medium", "low") else "unknown"
    for a in vuln.get("affected") or []:
        ds = (a.get("ecosystem_specific") or {}).get("severity") or (a.get("database_specific") or {}).get("severity")
        if isinstance(ds, str) and ds.lower() in ("critical", "high", "moderate", "medium", "low"):
            return {"moderate": "medium"}.get(ds.lower(), ds.lower())
    for s in vuln.get("severity") or []:
        score = _cvss_score(str(s.get("score", "")))
        if score is not None:
            return "critical" if score >= 9 else "high" if score >= 7 else "medium" if score >= 4 else "low"
    return "unknown"


def _cvss_score(vector: str) -> Optional[float]:
    """Base score of a CVSS 3.x vector (the common case in OSV)."""
    if not vector.startswith("CVSS:3"):
        try:
            return float(vector)
        except ValueError:
            return None
    m = dict(p.split(":", 1) for p in vector.split("/")[1:] if ":" in p)
    try:
        av = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}[m["AV"]]
        ac = {"L": 0.77, "H": 0.44}[m["AC"]]
        ui = {"N": 0.85, "R": 0.62}[m["UI"]]
        changed = m["S"] == "C"
        pr = {"N": 0.85, "L": 0.68 if changed else 0.62, "H": 0.5 if changed else 0.27}[m["PR"]]
        c, i, a = ({"H": 0.56, "L": 0.22, "N": 0}[m[k]] for k in ("C", "I", "A"))
    except KeyError:
        return None
    iss = 1 - (1 - c) * (1 - i) * (1 - a)
    impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 if changed else 6.42 * iss
    if impact <= 0:
        return 0.0
    expl = 8.22 * av * ac * pr * ui
    base = min(1.08 * (impact + expl), 10) if changed else min(impact + expl, 10)
    return math.ceil(base * 10 - 1e-9) / 10


def _pkg_key(ecosystem: str, name: str) -> str:
    """PyPI names compare normalized (PEP 503): pydantic_core == pydantic-core."""
    if ecosystem == "PyPI":
        name = re.sub(r"[-_.]+", "-", name).lower()
    return f"{ecosystem}|{name}"


def _fixed(vuln: dict) -> Dict[str, str]:
    out = {}
    for a in vuln.get("affected") or []:
        pkg = a.get("package") or {}
        key = _pkg_key(pkg.get("ecosystem", ""), pkg.get("name", ""))
        fixed = ""
        for r in a.get("ranges") or []:
            for e in r.get("events") or []:
                if e.get("fixed"):
                    fixed = e["fixed"]
        out[key] = fixed
    return out


def _parse_time(v) -> Optional[datetime]:
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _targets(instance: Instance, inventory: Dict[str, list]) -> List[Tuple[str, str, str, str]]:
    """(kind, ecosystem, package, version) to ask about for one instance."""
    out = set()
    facts = json.loads(instance.facts_json or "{}")
    eco = ubuntu_ecosystem(str(facts.get("os_id", "")))
    if eco:
        for p in inventory.get("packages") or []:
            if p.get("source") and p.get("source_version"):
                out.add(("os", eco, p["source"], p["source_version"]))
    for p in inventory.get("python") or []:
        if p.get("name") and p.get("version"):
            out.add(("python", "PyPI", p["name"], p["version"]))
    return sorted(out)


async def _query(client: httpx.AsyncClient, keys: List[Tuple[str, str, str]]) -> Dict[str, list]:
    """OSV querybatch for package versions not cached (or stale)."""
    now = datetime.utcnow()
    result: Dict[str, list] = {}
    async with async_session_maker() as session:
        names = [f"{e}|{n}|{v}" for e, n, v in keys]
        cached = {}
        for i in range(0, len(names), 1000):
            for row in (await session.execute(select(OsvQuery).where(OsvQuery.key.in_(names[i:i + 1000])))).scalars():
                cached[row.key] = row
        missing = [(e, n, v) for (e, n, v), k in zip(keys, names)
                   if k not in cached or now - cached[k].queried_at > QUERY_MAX_AGE]
        for k, row in cached.items():
            result[k] = json.loads(row.vulns_json)
        for i in range(0, len(missing), BATCH):
            chunk = missing[i:i + BATCH]
            queries = [{"package": {"ecosystem": e, "name": n}, "version": v} for e, n, v in chunk]
            r = await client.post(f"{API}/querybatch", json={"queries": queries})
            r.raise_for_status()
            answers = r.json().get("results") or []
            for (e, n, v), ans in zip(chunk, answers):
                vulns = [[x.get("id"), x.get("modified", "")] for x in (ans or {}).get("vulns") or []]
                token = (ans or {}).get("next_page_token")
                while token:   # many advisories for one version: the rest one page at a time
                    rr = await client.post(f"{API}/query", json={"package": {"ecosystem": e, "name": n},
                                                                 "version": v, "page_token": token})
                    rr.raise_for_status()
                    body = rr.json()
                    vulns += [[x.get("id"), x.get("modified", "")] for x in body.get("vulns") or []]
                    token = body.get("next_page_token")
                key = f"{e}|{n}|{v}"
                result[key] = vulns
                row = cached.get(key) or OsvQuery(key=key[:300])
                row.vulns_json = json.dumps(vulns)
                row.queried_at = now
                session.add(row)
            await session.commit()
    return result


async def _advisories(client: httpx.AsyncClient, wanted: Dict[str, str]) -> Dict[str, Advisory]:
    """Advisory rows for these ids, fetched when new or modified since."""
    out: Dict[str, Advisory] = {}
    async with async_session_maker() as session:
        ids = list(wanted)
        for i in range(0, len(ids), 1000):
            for row in (await session.execute(select(Advisory).where(Advisory.id.in_(ids[i:i + 1000])))).scalars():
                out[row.id] = row
    stale = [vid for vid, modified in wanted.items()
             if vid not in out or (_parse_time(modified) and out[vid].modified and _parse_time(modified) > out[vid].modified)]
    sem = asyncio.Semaphore(FETCH_CONCURRENCY)

    async def fetch(vid: str) -> Optional[dict]:
        async with sem:
            r = await client.get(f"{API}/vulns/{vid}")
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()

    for i in range(0, len(stale), 200):
        bodies = await asyncio.gather(*(fetch(v) for v in stale[i:i + 200]))
        async with async_session_maker() as session:
            for vid, v in zip(stale[i:i + 200], bodies):
                if v is None:
                    continue
                row = await session.get(Advisory, vid) or Advisory(id=vid[:100])
                aliases = [a for a in (v.get("aliases") or []) + (v.get("upstream") or []) if str(a).startswith("CVE-")]
                if vid.startswith("CVE-"):
                    aliases.append(vid)
                row.summary = (v.get("summary") or v.get("details") or "")[:500]
                row.aliases_json = json.dumps(sorted(set(aliases)))
                row.severity = _severity(v)
                row.published = _parse_time(v.get("published"))
                row.modified = _parse_time(v.get("modified"))
                row.fixed_json = json.dumps(_fixed(v))
                refs = v.get("references") or []
                row.url = (next((r.get("url") for r in refs if r.get("type") == "ADVISORY"), None)
                           or f"https://osv.dev/vulnerability/{vid}")[:300]
                row.fetched_at = datetime.utcnow()
                session.add(row)
                out[vid] = row
            await session.commit()
    return out


async def scan(instance_ids: Optional[List[str]] = None) -> dict:
    """Recompute the findings of these instances (None = every active one)."""
    async with async_session_maker() as session:
        query = select(Instance).where(Instance.status.in_(("active", "suspended")))
        if instance_ids is not None:
            query = query.where(Instance.id.in_(instance_ids))
        instances = (await session.execute(query)).scalars().all()
        inventories: Dict[str, Dict[str, list]] = {}
        for inst in instances:
            rows = (await session.execute(select(InstanceInventory).where(
                InstanceInventory.instance_id == inst.id))).scalars().all()
            inventories[inst.id] = {r.section: json.loads(r.items_json) for r in rows if r.digest}
    targets = {inst.id: _targets(inst, inventories[inst.id]) for inst in instances}
    keys = sorted({(e, n, v) for t in targets.values() for _, e, n, v in t})
    if not keys:
        return {"instances": len(instances), "findings": 0}
    async with httpx.AsyncClient(timeout=60, headers={"User-Agent": "madmin-manager"}) as client:
        answers = await _query(client, keys)
        wanted: Dict[str, str] = {}
        for vulns in answers.values():
            for vid, modified in vulns:
                if vid:
                    wanted[vid] = max(wanted.get(vid, ""), modified or "")
        advisories = await _advisories(client, wanted)
    total = 0
    async with async_session_maker() as session:
        for inst in instances:
            current = {(f.advisory_id, f.package): f for f in (await session.execute(
                select(Finding).where(Finding.instance_id == inst.id))).scalars()}
            seen = set()
            for kind, eco, name, version in targets[inst.id]:
                for vid, _ in answers.get(f"{eco}|{name}|{version}", []):
                    adv = advisories.get(vid)
                    if adv is None or (vid, name) in seen:
                        continue
                    seen.add((vid, name))
                    f = current.get((vid, name)) or Finding(instance_id=inst.id, advisory_id=vid, kind=kind,
                                                             package=name[:200])
                    f.installed_version = version[:200]
                    f.fixed_version = json.loads(adv.fixed_json).get(_pkg_key(eco, name), "")[:200]
                    f.severity = adv.severity
                    session.add(f)
            for (vid, name), f in current.items():
                if (vid, name) not in seen:
                    await session.delete(f)
            total += len(seen)
        await session.commit()
    return {"instances": len(instances), "findings": total, "packages": len(keys), "advisories": len(advisories)}


async def scan_task() -> None:
    """Instances whose inventory changed, every minute; everything once a day."""
    global _last_full
    while True:
        await asyncio.sleep(LOOP_INTERVAL)
        full = _last_full is None or datetime.utcnow() - _last_full > DAILY
        if not full and not _dirty:
            continue
        ids = None if full else sorted(_dirty)
        _dirty.difference_update(ids or list(_dirty))
        state["running"] = True
        try:
            res = await scan(ids)
            state.update(last_scan_at=datetime.utcnow().isoformat(), last_error="")
            if full:
                _last_full = datetime.utcnow()
            logger.info("OSV scan (%s): %s", "all" if full else f"{len(ids)} instances", res)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            state["last_error"] = str(e)[:300]
            logger.warning("OSV scan failed: %s", e)
            if ids:
                _dirty.update(ids)
            if full:
                # retried in an hour, not every minute
                _last_full = datetime.utcnow() - DAILY + timedelta(hours=1)
        finally:
            state["running"] = False
