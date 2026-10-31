"""
MADMIN Login Rate Limiter

Hybrid in-memory + PostgreSQL rate limiter with incremental backoff for login attempts.
The in-memory cache ensures zero-latency checks; the DB layer survives restarts.

Attempts are counted per key: the client IP and, for password logins, the
target username ("u:<name>"). Per IP alone, one valid account let an attacker
reset the counter with their own login and keep guessing other accounts.

Backoff schedule:
- 5 failures  → 30 second block
- 3 more      → 2 minute block
- Each after  → 10 minute block

Counters reset on successful login.
"""
import time
import threading
import logging
from datetime import datetime
from typing import Dict
from fastapi import HTTPException, status

logger = logging.getLogger(__name__)

# Backoff configuration
INITIAL_THRESHOLD = 5       # Failures before first block
SECOND_THRESHOLD = 3        # Additional failures before second block
BLOCK_DURATIONS = [30, 120, 600]  # seconds: 30s, 2min, 10min
CLEANUP_INTERVAL = 600      # Clean stale entries every 10 minutes
STALE_AFTER = 3600           # Remove entries inactive for 1 hour


def user_key(username: str) -> str:
    """Rate-limit key of a login target (fits LoginAttempt.ip, 64 chars)."""
    return f"u:{(username or '').lower()[:60]}"


class _Record:
    """Track login attempts for one key."""
    __slots__ = ("attempts", "blocked_until", "block_count", "last_attempt")

    def __init__(self):
        self.attempts: int = 0
        self.blocked_until: float = 0.0
        self.block_count: int = 0
        self.last_attempt: float = time.time()


class LoginRateLimiter:
    """
    Hybrid in-memory + PostgreSQL rate limiter for login endpoints.

    Usage per request: begin_attempt(keys) before checking the credentials,
    then record_failure(session, keys) or record_success(session, keys).
    Call load_from_db(session) at startup to restore blocked keys after a restart.
    """

    def __init__(self):
        self._records: Dict[str, _Record] = {}
        self._lock = threading.Lock()
        self._last_cleanup = time.time()

    async def load_from_db(self, session) -> None:
        """
        Load currently-blocked keys from the database.
        Call once at application startup to restore state after a restart.
        """
        from sqlalchemy import select
        from .models import LoginAttempt

        now = datetime.utcnow()
        result = await session.execute(
            select(LoginAttempt).where(LoginAttempt.blocked_until > now)
        )
        records = result.scalars().all()

        with self._lock:
            for record in records:
                rec = _Record()
                rec.attempts = record.attempts
                rec.block_count = record.block_count
                rec.blocked_until = record.blocked_until.timestamp() if record.blocked_until else 0.0
                rec.last_attempt = record.last_attempt.timestamp()
                self._records[record.ip] = rec

        logger.info(f"Rate limiter: loaded {len(records)} blocked keys from DB")

    def _cleanup_stale(self):
        """Remove entries that haven't been active for a while."""
        now = time.time()
        if now - self._last_cleanup < CLEANUP_INTERVAL:
            return
        self._last_cleanup = now
        stale = [
            key for key, rec in self._records.items()
            if now - rec.last_attempt > STALE_AFTER and now > rec.blocked_until
        ]
        for key in stale:
            del self._records[key]
        if stale:
            logger.debug(f"Rate limiter cleanup: removed {len(stale)} stale entries")

    def begin_attempt(self, *keys: str) -> None:
        """
        Refuse the attempt if any key is blocked, otherwise count it.

        Counted before the credentials are checked, under one lock: checking
        and counting apart let a burst of concurrent requests all pass the
        check before the first failure was recorded. A success resets it.

        Raises HTTPException(429) with Retry-After header if blocked.
        """
        with self._lock:
            self._cleanup_stale()
            now = time.time()
            for key in keys:
                rec = self._records.get(key)
                if rec and now < rec.blocked_until:
                    remaining = int(rec.blocked_until - now) + 1
                    logger.warning(
                        f"Rate limit: {key} blocked for {remaining}s "
                        f"(block #{rec.block_count}, {rec.attempts} attempts)"
                    )
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail=f"Troppi tentativi. Riprova tra {remaining} secondi.",
                        headers={"Retry-After": str(remaining)},
                    )
            for key in keys:
                rec = self._records.setdefault(key, _Record())
                rec.attempts += 1
                rec.last_attempt = now
                if self._should_block(rec):
                    duration = BLOCK_DURATIONS[min(rec.block_count, len(BLOCK_DURATIONS) - 1)]
                    rec.blocked_until = now + duration
                    rec.block_count += 1
                    logger.warning(
                        f"Rate limit: {key} blocked for {duration}s "
                        f"(block #{rec.block_count}, {rec.attempts} total attempts)"
                    )

    @staticmethod
    def _should_block(rec: _Record) -> bool:
        if rec.block_count == 0:
            return rec.attempts >= INITIAL_THRESHOLD
        if rec.block_count == 1:
            return rec.attempts >= INITIAL_THRESHOLD + SECOND_THRESHOLD
        return rec.attempts > INITIAL_THRESHOLD + SECOND_THRESHOLD + (rec.block_count - 2)

    async def record_failure(self, session, *keys: str) -> None:
        """
        Persist the state of `keys` after a failed attempt (already counted by
        begin_attempt), so blocks survive a restart. Caller commits.
        """
        from sqlalchemy.dialects.postgresql import insert
        from .models import LoginAttempt

        for key in keys:
            with self._lock:
                rec = self._records.get(key)
                if not rec:
                    continue
                values = dict(
                    ip=key,
                    attempts=rec.attempts,
                    block_count=rec.block_count,
                    blocked_until=(
                        datetime.utcfromtimestamp(rec.blocked_until)
                        if rec.blocked_until > time.time() else None
                    ),
                    last_attempt=datetime.utcnow(),
                )
            # Upsert: concurrent failures for the same key would otherwise
            # both insert and one would fail on the primary key
            stmt = insert(LoginAttempt).values(**values)
            await session.execute(stmt.on_conflict_do_update(
                index_elements=[LoginAttempt.ip],
                set_={k: stmt.excluded[k] for k in ("attempts", "block_count", "blocked_until", "last_attempt")},
            ))

    async def record_success(self, session, *keys: str) -> None:
        """
        Record a successful login. Resets all counters for `keys` (cache + DB).
        Caller commits.
        """
        with self._lock:
            for key in keys:
                self._records.pop(key, None)

        from sqlalchemy import delete
        from .models import LoginAttempt

        await session.execute(delete(LoginAttempt).where(LoginAttempt.ip.in_(keys)))

    async def cleanup_stale(self, session) -> int:
        """
        Delete persisted rows of keys that are not blocked and have been idle
        for a day: failed logins against random usernames would otherwise
        grow the table forever (one row per IP and per name tried).
        """
        from datetime import timedelta
        from sqlalchemy import delete, or_
        from .models import LoginAttempt

        now = datetime.utcnow()
        result = await session.execute(
            delete(LoginAttempt).where(
                LoginAttempt.last_attempt < now - timedelta(days=1),
                or_(LoginAttempt.blocked_until.is_(None), LoginAttempt.blocked_until < now),
            )
        )
        await session.commit()
        return result.rowcount


# Singleton
login_rate_limiter = LoginRateLimiter()
