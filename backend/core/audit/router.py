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
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    limit: int = Query(default=200, le=2000),
    offset: int = 0,
):
    stmt = select(AuditLog).order_by(AuditLog.timestamp.desc())
    if username:
        stmt = stmt.where(AuditLog.username == username)
    if method:
        stmt = stmt.where(AuditLog.method == method)
    if category:
        stmt = stmt.where(AuditLog.category == category)
    if path_prefix:
        stmt = stmt.where(AuditLog.path.like(f"{path_prefix}%"))
    if since:
        stmt = stmt.where(AuditLog.timestamp >= since)
    if until:
        stmt = stmt.where(AuditLog.timestamp <= until)
    stmt = stmt.offset(offset).limit(limit)

    result = await session.execute(stmt)
    return result.scalars().all()


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
