"""
MADMIN Audit Log Router

API endpoints for viewing audit logs and system logs.
"""
import csv
import io
import math
from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from starlette.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_session
from core.auth.dependencies import require_permission
from core.auth.models import User

from .service import query_audit_logs, get_distinct_users, get_system_logs

router = APIRouter(prefix="/api/logs", tags=["Audit Logs"])


# ── Response Models ────────────────────────────────────────────────────

class AuditLogItem(BaseModel):
    id: str
    timestamp: str
    username: Optional[str] = None
    method: str
    path: str
    status_code: int
    duration_ms: Optional[float] = None
    client_ip: Optional[str] = None
    category: Optional[str] = None
    request_body: Optional[str] = None
    response_summary: Optional[str] = None


class AuditLogListResponse(BaseModel):
    items: List[AuditLogItem]
    total: int
    page: int
    pages: int
    per_page: int


class AuditUsersResponse(BaseModel):
    users: List[str]


class SystemLogResponse(BaseModel):
    lines: List[str]
    count: int


def _csv_cell(value) -> str:
    """
    A text cell for the CSV export. Spreadsheets run a cell starting with
    = + - @ (or tab/CR) as a formula, and the logged username and payload
    come from unauthenticated requests too.
    """
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", chr(9), chr(13)) else text


@router.get("/audit", response_model=AuditLogListResponse)
async def list_audit_logs(
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=50, ge=10, le=200),
    user: Optional[str] = Query(default=None, description="Filter by username"),
    method: Optional[str] = Query(default=None, description="Filter by HTTP method"),
    category: Optional[str] = Query(default="write", description="'write', 'read', or None for all"),
    search: Optional[str] = Query(default=None, description="Search in path"),
    search_body: bool = Query(default=False, description="Also search request bodies (slow)"),
    from_date: Optional[str] = Query(default=None, description="From date (ISO format)"),
    to_date: Optional[str] = Query(default=None, description="To date (ISO format)"),
    current_user: User = Depends(require_permission("logs.view")),
    session: AsyncSession = Depends(get_session),
):
    """
    Get paginated audit logs with filters.
    
    Default: shows only 'write' operations (POST, PUT, PATCH, DELETE).
    Set category to None or empty to see all operations including reads.
    """
    # Parse dates
    parsed_from = None
    parsed_to = None
    if from_date:
        try:
            parsed_from = datetime.fromisoformat(from_date)
        except ValueError:
            pass
    if to_date:
        try:
            parsed_to = datetime.fromisoformat(to_date)
        except ValueError:
            pass
    
    # Treat empty string as None for category
    if category == "":
        category = None
    
    logs, total = await query_audit_logs(
        session,
        page=page,
        per_page=per_page,
        username=user,
        method=method,
        category=category,
        search=search,
        search_body=search_body,
        from_date=parsed_from,
        to_date=parsed_to,
    )
    
    return {
        "items": [
            {
                "id": str(log.id),
                "timestamp": log.timestamp.isoformat(),
                "username": log.username,
                "method": log.method,
                "path": log.path,
                "status_code": log.status_code,
                "duration_ms": log.duration_ms,
                "client_ip": log.client_ip,
                "category": log.category,
                "request_body": log.request_body,
                "response_summary": log.response_summary,
            }
            for log in logs
        ],
        "total": total,
        "page": page,
        "pages": math.ceil(total / per_page) if total > 0 else 1,
        "per_page": per_page,
    }


@router.get("/audit/users", response_model=AuditUsersResponse)
async def list_audit_users(
    current_user: User = Depends(require_permission("logs.view")),
    session: AsyncSession = Depends(get_session),
):
    """Get distinct usernames from audit log for filter dropdown."""
    users = await get_distinct_users(session)
    return {"users": users}


@router.get("/audit/export")
async def export_audit_csv(
    user: Optional[str] = Query(default=None),
    method: Optional[str] = Query(default=None),
    category: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    search_body: bool = Query(default=False),
    from_date: Optional[str] = Query(default=None),
    to_date: Optional[str] = Query(default=None),
    current_user: User = Depends(require_permission("logs.view")),
    session: AsyncSession = Depends(get_session),
):
    """
    Export audit logs as CSV file.
    
    Supports same filters as /audit endpoint.
    No pagination — returns all matching rows (max 10,000).
    """
    parsed_from = None
    parsed_to = None
    if from_date:
        try:
            parsed_from = datetime.fromisoformat(from_date)
        except ValueError:
            pass
    if to_date:
        try:
            parsed_to = datetime.fromisoformat(to_date)
        except ValueError:
            pass
    
    if category == "":
        category = None
    
    logs, _total = await query_audit_logs(
        session,
        page=1,
        per_page=10000,
        username=user,
        method=method,
        category=category,
        search=search,
        search_body=search_body,
        from_date=parsed_from,
        to_date=parsed_to,
    )
    
    # Generate CSV in memory
    output = io.StringIO()
    # UTF-8 BOM for Excel compatibility
    output.write("\ufeff")
    
    writer = csv.writer(output, delimiter=";")
    writer.writerow([
        "Timestamp", "Utente", "Metodo", "Path", "Status",
        "Durata (ms)", "IP Client", "Categoria", "Payload", "Dettaglio Errore"
    ])
    
    for log in logs:
        writer.writerow([
            log.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            _csv_cell(log.username),
            _csv_cell(log.method),
            _csv_cell(log.path),
            log.status_code,
            log.duration_ms,
            _csv_cell(log.client_ip),
            _csv_cell(log.category),
            _csv_cell(log.request_body or ""),
            _csv_cell(log.response_summary or ""),
        ])
    
    output.seek(0)
    
    filename = f"audit_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/system", response_model=SystemLogResponse)
async def get_system_log(
    lines: int = Query(default=200, ge=10, le=1000),
    search: Optional[str] = Query(default=None, description="Filter text (grep)"),
    current_user: User = Depends(require_permission("logs.view")),
):
    """
    Get raw system logs from journalctl.
    
    Returns the raw output of journalctl -u madmin-hub, useful for
    debugging system-level issues (restarts, errors, subprocess output).
    """
    log_lines = await get_system_logs(lines=lines, search=search)
    return {"lines": log_lines, "count": len(log_lines)}
