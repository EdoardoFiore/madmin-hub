"""
Dashboard service: fleet summary aggregation, alerts computation.
"""
import hashlib
from datetime import datetime, timedelta
from typing import List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.models import AuditLog
from hub.instances.models import EnrollmentToken, ManagedInstance


async def list_recent_activity(session: AsyncSession, limit: int = 20) -> List[dict]:
    res = await session.execute(
        select(AuditLog)
        .where(AuditLog.category == "write")
        .order_by(AuditLog.timestamp.desc())
        .limit(limit)
    )
    items = res.scalars().all()
    return [
        {
            "ts": a.timestamp.isoformat(),
            "username": a.username,
            "method": a.method,
            "path": a.path,
            "status": a.status_code,
            "summary": a.response_summary,
        }
        for a in items
    ]


async def list_alerts(session: AsyncSession) -> List[dict]:
    """Compute alerts live: offline instances >1h, tokens expiring <24h, version drift."""
    out: List[dict] = []
    now = datetime.utcnow()

    res = await session.execute(
        select(ManagedInstance).where(ManagedInstance.enrollment_status == "active")
    )
    instances = res.scalars().all()

    offline_threshold = now - timedelta(hours=1)
    for inst in instances:
        if inst.last_seen_at and inst.last_seen_at < offline_threshold and not inst.ws_connected:
            out.append(
                {
                    "id": _alert_id("instance_offline", str(inst.id)),
                    "severity": "warning",
                    "type": "instance_offline",
                    "label": f"{inst.name} offline since {inst.last_seen_at.isoformat()}",
                    "ref_id": str(inst.id),
                    "ref_type": "instance",
                    "ts": inst.last_seen_at.isoformat(),
                }
            )

    versions = [i.version for i in instances if i.version]
    if versions:
        latest = max(versions)
        for inst in instances:
            if inst.version and inst.version != latest:
                out.append(
                    {
                        "id": _alert_id("version_outdated", str(inst.id)),
                        "severity": "info",
                        "type": "version_outdated",
                        "label": f"{inst.name} on {inst.version} (latest {latest})",
                        "ref_id": str(inst.id),
                        "ref_type": "instance",
                        "ts": now.isoformat(),
                    }
                )

    expiring_threshold = now + timedelta(hours=24)
    res2 = await session.execute(
        select(EnrollmentToken).where(
            EnrollmentToken.revoked_at.is_(None),
            EnrollmentToken.expires_at > now,
            EnrollmentToken.expires_at < expiring_threshold,
        )
    )
    tokens = res2.scalars().all()
    for t in tokens:
        if t.token_type == "one_time" and t.used_at is not None:
            continue
        if t.token_type == "reusable" and t.use_count >= t.max_uses:
            continue
        out.append(
            {
                "id": _alert_id("token_expiring", str(t.id)),
                "severity": "warning",
                "type": "token_expiring",
                "label": f"Token '{t.name or t.id}' expires {t.expires_at.isoformat()}",
                "ref_id": str(t.id),
                "ref_type": "token",
                "ts": t.expires_at.isoformat(),
            }
        )

    return out[:50]


def _alert_id(kind: str, ref: str) -> str:
    return hashlib.sha1(f"{kind}|{ref}".encode()).hexdigest()[:16]
