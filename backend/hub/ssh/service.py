"""
SSH key service: fingerprint parsing, push/revoke via WS dispatcher.
"""
import hashlib
import json
import logging
import uuid
from base64 import b64decode
from datetime import datetime
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.instances.service import list_instances
from hub.ws import dispatcher as disp

from .models import SSHKey, SSHKeyAssignment

logger = logging.getLogger(__name__)


def compute_fingerprint(public_key: str) -> str:
    """Compute SHA-256 fingerprint from authorized_keys line."""
    try:
        parts = public_key.strip().split()
        if len(parts) < 2:
            raise ValueError("Formato chiave non valido")
        key_b64 = parts[1]
        raw = b64decode(key_b64)
        digest = hashlib.sha256(raw).hexdigest()
        return f"SHA256:{digest[:43]}"
    except Exception as e:
        raise ValueError(f"Impossibile calcolare fingerprint: {e}")


async def create_key(
    session: AsyncSession,
    name: str,
    public_key: str,
    owner: Optional[str] = None,
    notes: Optional[str] = None,
) -> SSHKey:
    fingerprint = compute_fingerprint(public_key)
    existing = await session.execute(select(SSHKey).where(SSHKey.fingerprint == fingerprint))
    if existing.scalar_one_or_none():
        raise ValueError("Chiave già presente (fingerprint duplicato)")
    key = SSHKey(
        name=name,
        public_key=public_key.strip(),
        fingerprint=fingerprint,
        owner=owner,
        notes=notes,
    )
    session.add(key)
    await session.flush()
    await session.refresh(key)
    return key


async def list_keys(session: AsyncSession) -> List[SSHKey]:
    result = await session.execute(select(SSHKey).order_by(SSHKey.name))
    return result.scalars().all()


async def delete_key(session: AsyncSession, key_id: uuid.UUID) -> bool:
    result = await session.execute(select(SSHKey).where(SSHKey.id == key_id))
    key = result.scalar_one_or_none()
    if not key:
        return False
    await session.delete(key)
    return True


def _build_authorized_keys_line(public_key: str, source_ips: List[str]) -> str:
    """Optionally prepend from= restriction to authorized_keys line."""
    if not source_ips:
        return public_key.strip()
    from_str = ",".join(source_ips)
    return f'from="{from_str}" {public_key.strip()}'


async def push_to_instance(
    session: AsyncSession,
    assignment: SSHKeyAssignment,
    key: SSHKey,
    instance_id: uuid.UUID,
    requested_by: str,
) -> dict:
    """Push single key to single instance via WS dispatch."""
    source_ips = json.loads(assignment.allow_source_ips or "[]")
    ak_line = _build_authorized_keys_line(key.public_key, source_ips)
    params = {
        "target_user": assignment.target_user,
        "authorized_keys_line": ak_line,
        "fingerprint": key.fingerprint,
        "assignment_id": str(assignment.id),
    }
    return await disp.dispatch(
        session,
        instance_id=instance_id,
        action="ssh.push",
        params=params,
        requested_by=requested_by,
    )


async def revoke_from_instance(
    session: AsyncSession,
    assignment: SSHKeyAssignment,
    key: SSHKey,
    instance_id: uuid.UUID,
    requested_by: str,
) -> dict:
    """Remove key from instance via WS dispatch."""
    params = {
        "target_user": assignment.target_user,
        "fingerprint": key.fingerprint,
        "assignment_id": str(assignment.id),
    }
    return await disp.dispatch(
        session,
        instance_id=instance_id,
        action="ssh.revoke",
        params=params,
        requested_by=requested_by,
    )


async def push_assignment(
    session: AsyncSession,
    assignment: SSHKeyAssignment,
    key: SSHKey,
    requested_by: str,
) -> dict:
    """
    Push key to all instances covered by assignment.
    target_type=instance → single push.
    target_type=group → push to all group members.
    """
    results = {}

    if assignment.target_type == "instance":
        r = await push_to_instance(session, assignment, key, assignment.target_id, requested_by)
        results[str(assignment.target_id)] = r
        if r.get("status") in ("done", "queued") or r.get("success"):
            assignment.status = "active"
            assignment.pushed_at = datetime.utcnow()
            session.add(assignment)

    elif assignment.target_type == "group":
        instances = await list_instances(session, group_id=assignment.target_id)
        for inst in instances:
            r = await push_to_instance(session, assignment, key, inst.id, requested_by)
            results[str(inst.id)] = r
        assignment.status = "active"
        assignment.pushed_at = datetime.utcnow()
        session.add(assignment)

    await session.commit()
    return results


async def revoke_assignment(
    session: AsyncSession,
    assignment: SSHKeyAssignment,
    key: SSHKey,
    requested_by: str,
) -> dict:
    results = {}

    if assignment.target_type == "instance":
        r = await revoke_from_instance(session, assignment, key, assignment.target_id, requested_by)
        results[str(assignment.target_id)] = r

    elif assignment.target_type == "group":
        instances = await list_instances(session, group_id=assignment.target_id)
        for inst in instances:
            r = await revoke_from_instance(session, assignment, key, inst.id, requested_by)
            results[str(inst.id)] = r

    assignment.status = "revoked"
    assignment.revoked_at = datetime.utcnow()
    session.add(assignment)
    await session.commit()
    return results
