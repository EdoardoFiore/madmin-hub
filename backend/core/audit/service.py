"""
Audit service: write helpers, exclusion rules, retention cleanup.
"""
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AuditLog

logger = logging.getLogger(__name__)

# Paths excluded from persistence (high-frequency, low-value)
EXCLUDED_PATHS = {
    "/api/health",
    "/api/auth/me",
    "/api/dashboard/fleet",  # polled often
}


def is_excluded(path: str, method: str) -> bool:
    if path in EXCLUDED_PATHS:
        return True
    # Exclude WS upgrade (websocket subprotocol). The WS handler logs separately.
    if path.startswith("/api/agents/ws"):
        return True
    return False


async def log_event(
    session: AsyncSession,
    *,
    username: str,
    method: str,
    path: str,
    status_code: int,
    duration_ms: int = 0,
    client_ip: str = "",
    category: str = "write",
    request_body: Optional[str] = None,
    response_summary: Optional[str] = None,
) -> None:
    """Programmatic audit log (used by WS handler for command/result frames)."""
    entry = AuditLog(
        username=username,
        method=method,
        path=path,
        status_code=status_code,
        duration_ms=duration_ms,
        client_ip=client_ip,
        category=category,
        request_body=request_body,
        response_summary=response_summary,
    )
    session.add(entry)
    await session.commit()


async def cleanup_old_logs(session: AsyncSession, retention_days: int = 90) -> int:
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    result = await session.execute(delete(AuditLog).where(AuditLog.timestamp < cutoff))
    await session.commit()
    removed = result.rowcount or 0
    if removed:
        logger.info(f"Audit cleanup: removed {removed} entries older than {retention_days}d")
    return removed
