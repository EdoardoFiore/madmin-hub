"""
API keys for the provisioning system.

Format: mhk_<id>_<secret>, shown once; only sha256(secret) is stored. A key
works only on /api/provisioning/* and only for its scopes, from its allowed
networks, until it expires or is revoked. The UI's JWT dependencies never
accept one, so a key cannot reach users, support sessions or restores.
"""
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.rate_limiter import login_rate_limiter
from core.database import get_session
from core.http import get_client_ip

from hub.models import ApiKey
from hub.netutil import ip_allowed

PREFIX = "mhk_"

SCOPES = {
    "provisioning.enroll": "Creare token di enrollment (anche re-enroll per riferimento esterno)",
    "groups.create": "Creare partner e clienti mancanti durante la creazione di un token",
    "instances.view": "Leggere istanze, stato e gruppi",
    "instances.lifecycle": "Dismettere un'istanza (revoca) per riferimento esterno",
    "backups.run": "Avviare un backup",
    "licenses.manage": "Emettere e revocare licenze",
}

# Requests per key per minute
RATE_LIMIT = 120
_usage: Dict[str, List[float]] = {}
# last_used_at is written at most this often per key
_TOUCH_EVERY = 60


@dataclass
class ApiPrincipal:
    key_id: str
    name: str
    scopes: frozenset

    @property
    def username(self) -> str:
        return f"api:{self.name}"[:100]


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def new_key() -> tuple[str, str, str]:
    """(key id, secret, full key)."""
    key_id = secrets.token_hex(6)
    secret = secrets.token_urlsafe(32)
    return key_id, secret, f"{PREFIX}{key_id}_{secret}"


def parse(raw: str) -> Optional[tuple[str, str]]:
    if not raw.startswith(PREFIX):
        return None
    try:
        key_id, secret = raw[len(PREFIX):].split("_", 1)
    except ValueError:
        return None
    if not key_id or not secret or len(key_id) > 16 or len(secret) > 100:
        return None
    return key_id, secret


def _rate_limited(key_id: str) -> bool:
    now = time.monotonic()
    window = [t for t in _usage.get(key_id, []) if now - t < 60]
    window.append(now)
    _usage[key_id] = window
    return len(window) > RATE_LIMIT


async def _authenticate(request: Request, session: AsyncSession) -> ApiPrincipal:
    client_ip = get_client_ip(request)
    limit_key = f"apikey:{client_ip}"
    auth = request.headers.get("authorization", "")
    parsed = parse(auth[7:].strip()) if auth.lower().startswith("bearer ") else None
    login_rate_limiter.begin_attempt(limit_key)
    row = await session.get(ApiKey, parsed[0]) if parsed else None
    ok = (row is not None and hmac.compare_digest(hash_secret(parsed[1]), row.secret_hash)
          and not row.revoked and (row.expires_at is None or row.expires_at > datetime.utcnow()))
    if not ok:
        await login_rate_limiter.record_failure(session, limit_key)
        await session.commit()
        raise HTTPException(401, "Chiave API non valida, scaduta o revocata",
                            headers={"WWW-Authenticate": "Bearer"})
    if not ip_allowed(client_ip, row.allowed_cidrs):
        raise HTTPException(403, "Chiave API non utilizzabile da questo indirizzo")
    if _rate_limited(row.id):
        raise HTTPException(429, "Troppe richieste per questa chiave", headers={"Retry-After": "60"})
    await login_rate_limiter.record_success(session, limit_key)
    if row.last_used_at is None or datetime.utcnow() - row.last_used_at > timedelta(seconds=_TOUCH_EVERY):
        row.last_used_at = datetime.utcnow()
        row.last_used_ip = client_ip[:45]
        session.add(row)
    await session.commit()
    return ApiPrincipal(row.id, row.name, frozenset(json.loads(row.scopes_json or "[]")))


def require_scope(scope: str):
    if scope not in SCOPES:
        raise RuntimeError(f"unknown API scope {scope}")

    async def dependency(request: Request, session: AsyncSession = Depends(get_session)) -> ApiPrincipal:
        principal = await _authenticate(request, session)
        if scope not in principal.scopes:
            raise HTTPException(403, f"Scope mancante: {scope}")
        return principal
    return dependency
