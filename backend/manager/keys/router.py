"""
SSH keys API: each superuser rw manages their own keys (/api/me/ssh-keys);
the approval list is shared by the superusers (/api/ssh-keys).
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from manager import pki
from manager.models import UserSshKey
from . import MAX_KEYS_PER_USER, approve, key_out, list_all, list_for_user

logger = logging.getLogger("madmin_manager.keys")

router = APIRouter(prefix="/api", tags=["SSH keys"])


class KeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    public_key: str = Field(min_length=20, max_length=16384)


@router.get("/me/ssh-keys")
async def my_keys(session: AsyncSession = Depends(get_session),
                  user: User = Depends(require_permission("manager.manage"))):
    return [key_out(k, user.username) for k in await list_for_user(session, user.id)]


@router.post("/me/ssh-keys", status_code=201)
async def add_key(body: KeyIn, session: AsyncSession = Depends(get_session),
                  user: User = Depends(require_permission("manager.manage"))):
    line = " ".join(body.public_key.split())
    try:
        fingerprint = pki.ssh_fingerprint(line)
    except pki.PKIError as e:
        raise HTTPException(400, str(e))
    keys = await list_for_user(session, user.id)
    if any(k.fingerprint == fingerprint for k in keys):
        raise HTTPException(409, "Chiave già registrata")
    if len(keys) >= MAX_KEYS_PER_USER:
        raise HTTPException(409, f"Al massimo {MAX_KEYS_PER_USER} chiavi per utente: rimuoverne una")
    key = UserSshKey(user_id=user.id, name=body.name.strip(), public_key=line, fingerprint=fingerprint)
    session.add(key)
    await session.commit()
    logger.info("SSH key %s added by %s (pending)", fingerprint, user.username)
    from manager.notify import notify
    notify("ssh-key", key.id, f"Chiave SSH di {user.username} da approvare",
           f"{user.username} ha aggiunto la chiave SSH \"{key.name}\" ({fingerprint}).\n"
           "Va approvata da un altro superuser (Supporto > Chiavi SSH) dopo aver verificato l'impronta "
           f"con {user.username} su un altro canale. Se non l'ha aggiunta {user.username}, l'account è compromesso.")
    return key_out(key, user.username)


@router.delete("/me/ssh-keys/{key_id}", status_code=204)
async def remove_key(key_id: str, session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("manager.manage"))):
    key = await session.get(UserSshKey, key_id)
    if key is None or key.user_id != user.id:
        raise HTTPException(404, "Chiave non trovata")
    await session.delete(key)
    await session.commit()
    logger.info("SSH key %s removed by its owner %s", key.fingerprint, user.username)


@router.get("/ssh-keys")
async def all_keys(status: str = "", session: AsyncSession = Depends(get_session),
                   user: User = Depends(require_permission("manager.view"))):
    return [key_out(k, owner) for k, owner in await list_all(session, status or None)]


async def _other_users_key(session, key_id: str, user: User) -> tuple:
    row = (await session.execute(
        select(UserSshKey, User.username).join(User, User.id == UserSshKey.user_id)
        .where(UserSshKey.id == key_id)
    )).first()
    if row is None:
        raise HTTPException(404, "Chiave non trovata")
    if row[0].user_id == user.id:
        raise HTTPException(403, "Una chiave va approvata da un altro superuser")
    return row


@router.post("/ssh-keys/{key_id}/approve")
async def approve_key(key_id: str, session: AsyncSession = Depends(get_session),
                      user: User = Depends(require_permission("manager.manage"))):
    key, owner = await _other_users_key(session, key_id, user)
    if key.status != "pending":
        raise HTTPException(409, "Chiave già approvata")
    await approve(session, key, user.username)
    await session.commit()
    logger.info("SSH key %s of %s approved by %s", key.fingerprint, owner, user.username)
    return key_out(key, owner)


@router.post("/ssh-keys/{key_id}/reject", status_code=204)
async def reject_key(key_id: str, session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("manager.manage"))):
    """Removes another user's key (pending or approved)."""
    key, owner = await _other_users_key(session, key_id, user)
    await session.delete(key)
    await session.commit()
    logger.info("SSH key %s of %s removed by %s", key.fingerprint, owner, user.username)
