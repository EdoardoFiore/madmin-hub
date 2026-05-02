"""
Enrollment service: create encrypted self-contained tokens, verify and exchange for long-lived agent tokens.

Token string format: base64(fernet.encrypt(json_payload))
Payload carries: id, secret, hub_url, target_group_id, default_tags, max_uses, token_type, expires_at.
The DB stores a SHA-256 hash of the secret for constant-time verification.
"""
import base64
import hashlib
import hmac
import json
import logging
import secrets
import uuid
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from passlib.hash import argon2
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings
from core.auth.service import decrypt_secret, encrypt_secret

from .models import EnrollmentToken, ManagedInstance

logger = logging.getLogger(__name__)
_settings = get_settings()


def _hash_token(raw: str) -> str:
    """argon2 hash of agent tokens (slow). Stored in DB."""
    return argon2.hash(raw)


def _verify_hash(raw: str, hashed: str) -> bool:
    try:
        return argon2.verify(raw, hashed)
    except Exception:
        return False


def _quick_lookup_hash(raw: str) -> str:
    """SHA-256 fast lookup hash for enrollment token secret."""
    return hashlib.sha256(raw.encode()).hexdigest()


def _encode_token(payload: dict) -> str:
    """Fernet-encrypt JSON payload, return base64url string safe for command line."""
    return encrypt_secret(json.dumps(payload, separators=(",", ":")), purpose="enrollment")


def _decode_token(raw: str) -> Optional[dict]:
    try:
        return json.loads(decrypt_secret(raw, purpose="enrollment"))
    except Exception:
        return None


# --- Enrollment tokens ---

async def create_enrollment_token(
    session: AsyncSession,
    *,
    target_group_id: Optional[uuid.UUID] = None,
    default_tags: Optional[List[str]] = None,
    created_by: Optional[str] = None,
    name: Optional[str] = None,
    token_type: str = "one_time",
    max_uses: int = 1,
    ttl_minutes: int = 15,
    hub_url: str = "",
) -> Tuple[str, EnrollmentToken]:
    """
    Generate an encrypted self-contained enrollment token.
    Returns (token_string, db_record). The token string is shown ONCE to the operator.
    """
    if token_type not in ("one_time", "reusable"):
        raise ValueError("token_type must be 'one_time' or 'reusable'")
    if max_uses < 1:
        max_uses = 1

    secret = secrets.token_urlsafe(32)
    expires_at = datetime.utcnow() + timedelta(minutes=max(1, ttl_minutes))

    record = EnrollmentToken(
        token_hash=_quick_lookup_hash(secret),
        expires_at=expires_at,
        target_group_id=target_group_id,
        default_tags=json.dumps(default_tags or []),
        created_by=created_by,
        name=name,
        token_type=token_type,
        max_uses=max_uses if token_type == "reusable" else 1,
        use_count=0,
    )
    session.add(record)
    await session.flush()
    await session.refresh(record)

    payload = {
        "v": 1,
        "id": str(record.id),
        "secret": secret,
        "hub_url": hub_url,
        "target_group_id": str(target_group_id) if target_group_id else None,
        "default_tags": default_tags or [],
        "max_uses": record.max_uses,
        "token_type": token_type,
        "expires_at": expires_at.isoformat(),
    }
    token_string = _encode_token(payload)
    return token_string, record


async def find_valid_enrollment_token(
    session: AsyncSession, raw: str
) -> Optional[EnrollmentToken]:
    """Decrypt token string, look up record by id, verify secret + state."""
    payload = _decode_token(raw)
    if not payload:
        return None

    token_id = payload.get("id")
    secret = payload.get("secret")
    if not token_id or not secret:
        return None

    try:
        rec_uuid = uuid.UUID(token_id)
    except ValueError:
        return None

    result = await session.execute(select(EnrollmentToken).where(EnrollmentToken.id == rec_uuid))
    record = result.scalar_one_or_none()
    if not record:
        return None

    expected = _quick_lookup_hash(secret)
    if not hmac.compare_digest(expected, record.token_hash):
        return None
    if record.revoked_at is not None:
        return None
    if record.expires_at < datetime.utcnow():
        return None

    if record.token_type == "one_time":
        if record.used_at is not None:
            return None
    else:  # reusable
        if record.use_count >= record.max_uses:
            return None

    return record


async def consume_enrollment_token(
    session: AsyncSession, record: EnrollmentToken, instance_id: uuid.UUID
) -> None:
    record.use_count = (record.use_count or 0) + 1
    if record.token_type == "one_time":
        record.used_at = datetime.utcnow()
        record.used_by_instance_id = instance_id
    session.add(record)


# --- Agent tokens (long-lived) ---

def generate_agent_token() -> str:
    return secrets.token_urlsafe(48)


def hash_agent_token(raw: str) -> str:
    return _hash_token(raw)


def verify_agent_token(raw: str, hashed: str) -> bool:
    return _verify_hash(raw, hashed)


# --- Enrollment flow ---

async def enroll_instance(
    session: AsyncSession,
    *,
    enrollment_token_raw: str,
    name: str,
    fingerprint: str,
    version: Optional[str] = None,
    os_info: Optional[dict] = None,
) -> Tuple[ManagedInstance, str]:
    """
    Validate enrollment token, create ManagedInstance, return (instance, agent_token_raw).
    Agent token is returned ONCE — stored only as hash on Hub.
    """
    record = await find_valid_enrollment_token(session, enrollment_token_raw)
    if not record:
        raise ValueError("Enrollment token non valido o scaduto")

    existing = await session.execute(
        select(ManagedInstance).where(ManagedInstance.fingerprint == fingerprint)
    )
    if existing.scalar_one_or_none():
        raise ValueError("Istanza già registrata (fingerprint duplicato)")

    agent_token = generate_agent_token()
    instance = ManagedInstance(
        name=name,
        fingerprint=fingerprint,
        agent_token_hash=hash_agent_token(agent_token),
        enrollment_status="active",
        version=version,
        os_info=json.dumps(os_info or {}),
        tags=record.default_tags or "[]",
        group_id=record.target_group_id,
    )
    session.add(instance)
    await session.flush()
    await session.refresh(instance)

    await consume_enrollment_token(session, record, instance.id)
    logger.info(f"Enrolled instance {instance.id} ({name})")
    return instance, agent_token
