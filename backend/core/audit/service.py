"""
MADMIN Audit Service

Business logic for audit log operations:
- Exclusion path management
- Log querying with filters
- Cleanup of old records
- System log (journalctl) reading
"""
import re
import logging
import asyncio
from datetime import datetime, timedelta
from typing import Optional, List, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete, and_, or_

from .models import AuditLog

logger = logging.getLogger(__name__)

# --- Exclusion Configuration ---

# Exact paths to exclude from DB persistence (polling/navigation endpoints)
EXCLUDED_PATHS: set = {
    "/api/health",
    "/api/ui/menu",
    "/api/auth/me",
    "/api/auth/me/2fa/status",
    "/api/settings/system",
    "/api/dashboard",
}

# Polling endpoints of the UI (lists refreshed every few seconds)
EXCLUDED_PATTERNS: list = [
    re.compile(r".*/status$"),
    re.compile(r"^/api/instances$"),
    re.compile(r"^/api/instances/[^/]+$"),
    re.compile(r"^/api/instances/[^/]+/(commands|stats|addresses)$"),
]

# Default retention period in days
DEFAULT_RETENTION_DAYS = 90


def is_excluded(path: str, method: str = "GET") -> bool:
    """
    Check if a request should be excluded from DB persistence.
    
    Write operations (POST, PUT, PATCH, DELETE) are NEVER excluded —
    only GET requests to polling/navigation paths are skipped.
    
    Excluded requests are still logged to journalctl but not saved to the database.
    """
    # Never exclude write operations
    if method != "GET":
        return False
    
    # Strip query parameters for matching
    clean_path = path.split("?")[0]
    
    # Exact match
    if clean_path in EXCLUDED_PATHS:
        return True
    
    # Pattern match
    for pattern in EXCLUDED_PATTERNS:
        if pattern.match(clean_path):
            return True
    
    return False


# --- Query Functions ---

async def query_audit_logs(
    session: AsyncSession,
    page: int = 1,
    per_page: int = 50,
    username: Optional[str] = None,
    method: Optional[str] = None,
    category: Optional[str] = "write",
    search: Optional[str] = None,
    from_date: Optional[datetime] = None,
    to_date: Optional[datetime] = None,
    search_body: bool = False,
) -> Tuple[List[AuditLog], int]:
    """
    Query audit logs with filters and pagination.
    
    Returns:
        Tuple of (logs list, total count)
    """
    # Build filter conditions
    conditions = []
    
    if username:
        conditions.append(AuditLog.username == username)
    if method:
        conditions.append(AuditLog.method == method)
    if category:
        conditions.append(AuditLog.category == category)
    if search:
        # The text is literal: % and _ typed by the user are not wildcards
        pattern = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        if search_body:
            # Full scan of every stored payload: only when asked for
            conditions.append(or_(
                AuditLog.path.ilike(pattern, escape="\\"),
                AuditLog.request_body.ilike(pattern, escape="\\"),
            ))
        else:
            conditions.append(AuditLog.path.ilike(pattern, escape="\\"))
    if from_date:
        conditions.append(AuditLog.timestamp >= from_date)
    if to_date:
        conditions.append(AuditLog.timestamp <= to_date)
    
    where_clause = and_(*conditions) if conditions else True
    
    # Get total count
    count_query = select(func.count(AuditLog.id)).where(where_clause)
    total = (await session.execute(count_query)).scalar()
    
    # Get paginated results
    offset = (page - 1) * per_page
    query = (
        select(AuditLog)
        .where(where_clause)
        .order_by(AuditLog.timestamp.desc())
        .offset(offset)
        .limit(per_page)
    )
    result = await session.execute(query)
    logs = result.scalars().all()
    
    return logs, total


async def get_distinct_users(session: AsyncSession) -> List[str]:
    """Get all distinct usernames from audit log for filter dropdown."""
    result = await session.execute(
        select(AuditLog.username)
        .distinct()
        .where(AuditLog.username != "anonymous")
        .order_by(AuditLog.username)
    )
    return [row[0] for row in result.all()]


# --- Cleanup ---

async def cleanup_old_logs(session: AsyncSession, retention_days: int = DEFAULT_RETENTION_DAYS) -> int:
    """
    Delete audit log entries older than retention_days.
    
    Returns:
        Number of deleted records
    """
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    
    result = await session.execute(
        delete(AuditLog).where(AuditLog.timestamp < cutoff)
    )
    await session.commit()
    
    deleted = result.rowcount
    if deleted > 0:
        logger.info(f"Audit log cleanup: deleted {deleted} records older than {retention_days} days")
    
    return deleted


# --- System Log (journalctl) ---

async def get_system_logs(lines: int = 200, search: Optional[str] = None) -> List[str]:
    """
    Read raw system logs from journalctl.
    
    Args:
        lines: Number of lines to retrieve (max 1000)
        search: Optional text filter (grep)
    
    Returns:
        List of raw log lines
    """
    lines = min(lines, 1000)
    
    cmd = ["journalctl", "-u", "madmin-hub", "--no-pager", "-n", str(lines), "--output=cat"]
    
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, _ = await proc.communicate()

    if not stdout:
        return []

    log_lines = stdout.decode("utf-8", errors="replace").strip().split("\n")
    if search:
        search_lower = search.lower()
        log_lines = [line for line in log_lines if search_lower in line.lower()]
    return log_lines
