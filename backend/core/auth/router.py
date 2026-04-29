"""
Auth router: /api/auth/*
- init (first user)
- token (login)
- 2FA setup/verify
- users CRUD
- permissions
- self-service (me, password change, preferences)
"""
import json
import logging
import uuid
from datetime import timedelta
from typing import List, Optional

import pyotp
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_session

from . import service
from .dependencies import get_current_user, require_permission
from .models import (
    PermissionResponse,
    Token,
    User,
    UserCreate,
    UserResponse,
    UserUpdate,
)
from .token_blacklist import token_blacklist

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["Auth"])


class InitPayload(BaseModel):
    username: str
    password: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


class PreferencesUpdate(BaseModel):
    preferences: str


class TOTPVerify(BaseModel):
    code: str


# --- Init ---

@router.post("/init", response_model=UserResponse)
async def init_first_user(payload: InitPayload, session: AsyncSession = Depends(get_session)):
    try:
        user = await service.create_first_user(session, payload.username, payload.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return service.user_to_response(user)


# --- Login ---

@router.post("/token", response_model=Token)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    session: AsyncSession = Depends(get_session),
):
    user = await service.authenticate_user(session, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Username o password non validi",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 2FA gate
    if user.totp_enabled:
        temp = service.create_access_token(
            {"sub": user.username, "user_id": str(user.id), "2fa_pending": True},
            expires_delta=timedelta(minutes=5),
        )
        return Token(access_token=temp, token_type="2fa_required")

    if user.totp_enforced and not user.totp_enabled:
        temp = service.create_access_token(
            {"sub": user.username, "user_id": str(user.id), "2fa_setup_required": True},
            expires_delta=timedelta(minutes=15),
        )
        return Token(access_token=temp, token_type="2fa_setup_required")

    await service.update_last_login(session, user)
    token = service.create_access_token({"sub": user.username, "user_id": str(user.id)})
    return Token(access_token=token)


@router.post("/token/2fa", response_model=Token)
async def login_2fa(
    code: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if not current_user.totp_enabled or not current_user.totp_secret:
        raise HTTPException(status_code=400, detail="2FA non abilitata")
    secret = service.decrypt_secret(current_user.totp_secret, purpose="totp")
    if not pyotp.TOTP(secret).verify(code, valid_window=1):
        raise HTTPException(status_code=401, detail="Codice 2FA non valido")
    await service.update_last_login(session, current_user)
    token = service.create_access_token(
        {"sub": current_user.username, "user_id": str(current_user.id)}
    )
    return Token(access_token=token)


# --- Self ---

@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)):
    return service.user_to_response(current_user)


@router.patch("/me/preferences", response_model=UserResponse)
async def update_preferences(
    payload: PreferencesUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        json.loads(payload.preferences)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Preferences must be valid JSON")
    current_user.preferences = payload.preferences
    session.add(current_user)
    return service.user_to_response(current_user)


@router.post("/me/password")
async def change_my_password(
    payload: PasswordChange,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if not service.verify_password(payload.current_password, current_user.hashed_password):
        raise HTTPException(status_code=401, detail="Password attuale non valida")
    ok, msg = service.validate_password_strength(payload.new_password)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    current_user.hashed_password = service.get_password_hash(payload.new_password)
    session.add(current_user)
    await token_blacklist.revoke_user(session, current_user.id)
    return {"detail": "Password aggiornata"}


# --- 2FA setup ---

@router.get("/me/2fa/status")
async def my_2fa_status(current_user: User = Depends(get_current_user)):
    return {
        "enabled": current_user.totp_enabled,
        "enforced": current_user.totp_enforced,
    }


@router.post("/me/2fa/setup")
async def setup_2fa(current_user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    if current_user.totp_enabled:
        raise HTTPException(status_code=400, detail="2FA already enabled")
    secret = pyotp.random_base32()
    current_user.totp_secret = service.encrypt_secret(secret, purpose="totp")
    session.add(current_user)
    uri = pyotp.TOTP(secret).provisioning_uri(
        name=current_user.username, issuer_name="MADMIN Hub"
    )
    return {"secret": secret, "provisioning_uri": uri}


@router.post("/me/2fa/enable")
async def enable_2fa(
    payload: TOTPVerify,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if not current_user.totp_secret:
        raise HTTPException(status_code=400, detail="No 2FA setup initiated")
    secret = service.decrypt_secret(current_user.totp_secret, purpose="totp")
    if not pyotp.TOTP(secret).verify(payload.code, valid_window=1):
        raise HTTPException(status_code=401, detail="Codice non valido")
    current_user.totp_enabled = True
    session.add(current_user)
    return {"detail": "2FA attivata"}


@router.delete("/me/2fa/disable")
async def disable_2fa(current_user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    if current_user.totp_enforced:
        raise HTTPException(status_code=403, detail="2FA enforced — non disabilitabile")
    current_user.totp_enabled = False
    current_user.totp_secret = None
    session.add(current_user)
    return {"detail": "2FA disattivata"}


# --- Users management ---

@router.get("/users", response_model=List[UserResponse])
async def list_users(
    user: User = Depends(require_permission("users.view")),
    session: AsyncSession = Depends(get_session),
):
    users = await service.get_all_users(session)
    return [service.user_to_response(u) for u in users]


@router.post("/users", response_model=UserResponse)
async def create_user(
    payload: UserCreate,
    user: User = Depends(require_permission("users.manage")),
    session: AsyncSession = Depends(get_session),
):
    try:
        new_user = await service.create_user(session, payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return service.user_to_response(new_user)


@router.get("/users/{username}", response_model=UserResponse)
async def get_user(
    username: str,
    user: User = Depends(require_permission("users.view")),
    session: AsyncSession = Depends(get_session),
):
    target = await service.get_user_by_username(session, username)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    return service.user_to_response(target)


@router.patch("/users/{username}", response_model=UserResponse)
async def update_user(
    username: str,
    payload: UserUpdate,
    current_user: User = Depends(require_permission("users.manage")),
    session: AsyncSession = Depends(get_session),
):
    target = await service.get_user_by_username(session, username)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.is_protected and target.id != current_user.id:
        raise HTTPException(status_code=403, detail="Utente protetto: solo il proprietario può modificarlo")
    try:
        updated = await service.update_user(session, target.id, payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if payload.is_active is False or payload.password is not None:
        await token_blacklist.revoke_user(session, target.id)
    return service.user_to_response(updated)


@router.delete("/users/{username}")
async def delete_user(
    username: str,
    current_user: User = Depends(require_permission("users.manage")),
    session: AsyncSession = Depends(get_session),
):
    target = await service.get_user_by_username(session, username)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.is_protected:
        raise HTTPException(status_code=403, detail="Utente protetto non eliminabile")
    if target.id == current_user.id:
        raise HTTPException(status_code=400, detail="Non puoi eliminare te stesso")
    await token_blacklist.revoke_user(session, target.id)
    await service.delete_user(session, target.id)
    return {"detail": "Eliminato"}


# --- Permissions ---

@router.get("/permissions", response_model=List[PermissionResponse])
async def list_permissions(
    user: User = Depends(require_permission("permissions.manage")),
    session: AsyncSession = Depends(get_session),
):
    return await service.get_all_permissions(session)


class PermissionAssign(BaseModel):
    permissions: List[str]


@router.put("/users/{username}/permissions", response_model=UserResponse)
async def set_permissions(
    username: str,
    payload: PermissionAssign,
    user: User = Depends(require_permission("permissions.manage")),
    session: AsyncSession = Depends(get_session),
):
    target = await service.get_user_by_username(session, username)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    updated = await service.set_user_permissions(session, target.id, payload.permissions)
    return service.user_to_response(updated)
