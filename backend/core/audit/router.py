"""
Audit router: list/export logs.
"""
import csv
import io
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import distinct, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from .models import AuditLog

router = APIRouter(prefix="/api/logs", tags=["Audit"])


@router.get("/audit")
async def list_audit_logs(
    user: User = Depends(require_permission("logs.view")),
    session: AsyncSession = Depends(get_session),
    username: Optional[str] = None,
    method: Optional[str] = None,
    category: Optional[str] = None,
    path_prefix: Optional[str] = None,
    search: Optional[str] = None,
    from_date: Optional[datetime] = None,
    to_date: Optional[datetime] = None,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=50, le=500),
    limit: int = Query(default=0, le=2000),
    offset: int = 0,
):
    from sqlalchemy import func as sqlfunc, or_

    stmt = select(AuditLog).order_by(AuditLog.timestamp.desc())
    if username:
        stmt = stmt.where(AuditLog.username == username)
    if method:
        stmt = stmt.where(AuditLog.method == method)
    if category:
        stmt = stmt.where(AuditLog.category == category)
    if path_prefix:
        stmt = stmt.where(AuditLog.path.like(f"{path_prefix}%"))
    if search:
        stmt = stmt.where(or_(
            AuditLog.path.ilike(f"%{search}%"),
            AuditLog.request_body.ilike(f"%{search}%"),
        ))
    effective_since = from_date or since
    effective_until = to_date or until
    if effective_since:
        stmt = stmt.where(AuditLog.timestamp >= effective_since)
    if effective_until:
        stmt = stmt.where(AuditLog.timestamp <= effective_until)

    # Legacy mode: if limit provided use raw offset/limit
    if limit:
        result = await session.execute(stmt.offset(offset).limit(limit))
        return result.scalars().all()

    # Page-based pagination
    count_stmt = select(sqlfunc.count()).select_from(stmt.subquery())
    total_result = await session.execute(count_stmt)
    total = total_result.scalar()
    result = await session.execute(stmt.offset((page - 1) * per_page).limit(per_page))
    items = result.scalars().all()
    return {"items": items, "total": total, "page": page, "per_page": per_page}


@router.get("/audit/users")
async def audit_distinct_users(
    user: User = Depends(require_permission("logs.view")),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(distinct(AuditLog.username)).order_by(AuditLog.username))
    return [row[0] for row in result.all()]


@router.get("/audit/export")
async def audit_export(
    user: User = Depends(require_permission("logs.view")),
    session: AsyncSession = Depends(get_session),
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
):
    stmt = select(AuditLog).order_by(AuditLog.timestamp.desc())
    if since:
        stmt = stmt.where(AuditLog.timestamp >= since)
    if until:
        stmt = stmt.where(AuditLog.timestamp <= until)

    result = await session.execute(stmt)
    rows = result.scalars().all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["timestamp", "username", "method", "path", "status", "duration_ms", "ip", "category"]
    )
    for r in rows:
        writer.writerow(
            [r.timestamp.isoformat(), r.username, r.method, r.path, r.status_code, r.duration_ms, r.client_ip, r.category]
        )
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=audit_export.csv"},
    )
