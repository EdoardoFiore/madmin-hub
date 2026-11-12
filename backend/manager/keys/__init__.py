"""
SSH public keys of the users, for support SSH (ROADMAP 10.4).

A support SSH certificate is signed only for one of the caller's approved
keys: a key is never pasted when the session is opened. A key added is
pending until another superuser rw approves it (never its owner); with a
single superuser on the manager it is approved from the root CLI
(python -m manager.keys approve <user> <fingerprint>). A change of the
owner's role, access or group sends every key back to pending.
"""
from datetime import datetime
from typing import List, Optional

from sqlalchemy import delete, update
from sqlmodel import select

from core.auth.models import User
from manager.models import UserSshKey

MAX_KEYS_PER_USER = 10


def key_out(key: UserSshKey, owner: str = "") -> dict:
    d = key.model_dump(exclude={"public_key"})
    d["user_id"] = str(key.user_id)
    d["owner"] = owner
    # Type and comment only: enough to recognise it
    parts = key.public_key.split()
    d["key_type"] = parts[0] if parts else ""
    d["comment"] = " ".join(parts[2:])[:100]
    return d


async def list_for_user(session, user_id) -> List[UserSshKey]:
    return (await session.execute(
        select(UserSshKey).where(UserSshKey.user_id == user_id).order_by(UserSshKey.created_at)
    )).scalars().all()


async def list_all(session, status: Optional[str] = None) -> list:
    query = select(UserSshKey, User.username).join(User, User.id == UserSshKey.user_id)
    if status:
        query = query.where(UserSshKey.status == status)
    return (await session.execute(query.order_by(UserSshKey.created_at.desc()))).all()


async def approve(session, key: UserSshKey, approver: str) -> None:
    key.status = "approved"
    key.approved_by = approver[:100]
    key.approved_at = datetime.utcnow()
    session.add(key)


async def reset_approvals(session, user_id) -> None:
    """The owner changed role, access or group: approvals no longer hold."""
    await session.execute(
        update(UserSshKey).where(UserSshKey.user_id == user_id, UserSshKey.status == "approved")
        .values(status="pending", approved_by="", approved_at=None)
    )


async def delete_for_user(session, user_id) -> None:
    """Before the user row (a statement, so it runs before the user's delete)."""
    await session.execute(delete(UserSshKey).where(UserSshKey.user_id == user_id))
