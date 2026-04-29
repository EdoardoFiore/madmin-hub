"""
Enrollment service: generate one-time tokens, verify and exchange for long-lived agent tokens.
"""
import hashlib
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
    """SHA-256 fast lookup hash for enrollment tokens (one-shot, low risk)."""
    return hashlib.sha256(raw.encode()).hexdigest()


# --- Enrollment tokens (one-shot) ---

async def create_enrollment_token(
    session: AsyncSession,
    *,
    target_group_id: Optional[uuid.UUID] = None,
    default_tags: Optional[List[str]] = None,
    created_by: Optional[str] = None,
) -> Tuple[str, EnrollmentToken]:
    raw = secrets.token_urlsafe(32)
    record = EnrollmentToken(
        token_hash=_quick_lookup_hash(raw),
        expires_at=datetime.utcnow() + timedelta(minutes=_settings.enrollment_token_ttl_minutes),
        target_group_id=target_group_id,
        default_tags=json.dumps(default_tags or []),
        created_by=created_by,
    )
    session.add(record)
    await session.flush()
    await session.refresh(record)
    return raw, record


async def find_valid_enrollment_token(
    session: AsyncSession, raw: str
) -> Optional[EnrollmentToken]:
    h = _quick_lookup_hash(raw)
    result = await session.execute(select(EnrollmentToken).where(EnrollmentToken.token_hash == h))
    record = result.scalar_one_or_none()
    if not record:
        return None
    if record.used_at is not None:
        return None
    if record.expires_at < datetime.utcnow():
        return None
    return record


async def consume_enrollment_token(
    session: AsyncSession, record: EnrollmentToken, instance_id: uuid.UUID
) -> None:
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

    # Check fingerprint not already enrolled
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
