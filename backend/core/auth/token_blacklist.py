"""
Token blacklist: hybrid in-memory + DB.
Revokes user tokens immediately on disable/delete; survives restarts.
"""
import logging
import threading
import time
import uuid
from datetime import datetime, timedelta
from typing import Dict

from config import get_settings

logger = logging.getLogger(__name__)


class TokenBlacklist:
    def __init__(self):
        self._revoked: Dict[uuid.UUID, float] = {}
        self._lock = threading.Lock()

    async def load_from_db(self, session) -> None:
        from sqlalchemy import select

        from .models import RevokedToken

        now = datetime.utcnow()
        result = await session.execute(select(RevokedToken).where(RevokedToken.expires_at > now))
        records = result.scalars().all()
        with self._lock:
            for r in records:
                self._revoked[r.user_id] = r.revoked_at.timestamp()
        logger.info(f"Token blacklist loaded {len(records)} entries")

    async def revoke_user(self, session, user_id: uuid.UUID) -> None:
        from sqlalchemy import delete

        from .models import RevokedToken

        with self._lock:
            self._revoked[user_id] = time.time()
        revoked_at = datetime.utcnow()
        expires_at = revoked_at + timedelta(minutes=get_settings().access_token_expire_minutes)
        await session.execute(delete(RevokedToken).where(RevokedToken.user_id == user_id))
        session.add(RevokedToken(user_id=user_id, revoked_at=revoked_at, expires_at=expires_at))

    async def unrevoke_user(self, session, user_id: uuid.UUID) -> None:
        from sqlalchemy import delete

        from .models import RevokedToken

        with self._lock:
            self._revoked.pop(user_id, None)
        await session.execute(delete(RevokedToken).where(RevokedToken.user_id == user_id))

    def is_revoked(self, user_id: uuid.UUID) -> bool:
        with self._lock:
            ts = self._revoked.get(user_id)
            if ts is None:
                return False
            ttl = get_settings().access_token_expire_minutes * 60
            if time.time() - ts > ttl:
                self._revoked.pop(user_id, None)
                return False
            return True


token_blacklist = TokenBlacklist()
