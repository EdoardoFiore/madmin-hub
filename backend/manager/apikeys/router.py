"""
API keys (UI, superusers only).
"""
import json
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from core.auth.dependencies import require_permission
from core.auth.models import User
from core.database import get_session

from manager.models import ApiKey
from manager.netutil import parse_cidrs
from .service import SCOPES, hash_secret, new_key

router = APIRouter(prefix="/api/apikeys", tags=["API keys"])


def key_out(k: ApiKey) -> dict:
    d = k.model_dump(exclude={"secret_hash", "scopes_json"})
    d["scopes"] = json.loads(k.scopes_json or "[]")
    d["valid"] = not k.revoked and (k.expires_at is None or k.expires_at > datetime.utcnow())
    return d


@router.get("/scopes")
async def scopes(user: User = Depends(require_permission("manager.view"))):
    return [{"scope": s, "description": d} for s, d in SCOPES.items()]


@router.get("")
async def list_keys(session: AsyncSession = Depends(get_session), user: User = Depends(require_permission("manager.view"))):
    rows = (await session.execute(select(ApiKey).order_by(ApiKey.created_at.desc()))).scalars().all()
    return [key_out(k) for k in rows]


class KeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    scopes: List[str] = Field(min_length=1)
    allowed_cidrs: str = Field(default="", max_length=1000)
    days: Optional[int] = Field(default=365, ge=1, le=3650)  # None = no expiry

    @field_validator("scopes")
    @classmethod
    def _scopes(cls, v):
        unknown = [s for s in v if s not in SCOPES]
        if unknown:
            raise ValueError(f"Scope sconosciuti: {', '.join(unknown)}")
        return sorted(set(v))

    @field_validator("allowed_cidrs")
    @classmethod
    def _cidrs(cls, v):
        return ",".join(str(n) for n in parse_cidrs(v))


@router.post("", status_code=201)
async def create_key(body: KeyCreate, session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("manager.manage"))):
    if (await session.execute(select(ApiKey).where(ApiKey.name == body.name))).first():
        raise HTTPException(409, "Esiste già una chiave con questo nome")
    key_id, secret, full = new_key()
    row = ApiKey(id=key_id, name=body.name, secret_hash=hash_secret(secret),
                 scopes_json=json.dumps(body.scopes), allowed_cidrs=body.allowed_cidrs,
                 created_by=user.username,
                 expires_at=datetime.utcnow() + timedelta(days=body.days) if body.days else None)
    session.add(row)
    await session.commit()
    return {"key": full, "api_key": key_out(row)}


@router.post("/{key_id}/revoke")
async def revoke_key(key_id: str, session: AsyncSession = Depends(get_session),
                     user: User = Depends(require_permission("manager.manage"))):
    row = await session.get(ApiKey, key_id)
    if row is None:
        raise HTTPException(404, "Chiave non trovata")
    row.revoked = True
    session.add(row)
    await session.commit()
    return key_out(row)
