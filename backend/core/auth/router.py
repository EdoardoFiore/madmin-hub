"""
MADMIN Authentication Router

API endpoints for authentication and user management.
"""
import json
import asyncio
from typing import List, Optional, Dict
from datetime import timedelta
import uuid
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, status, Query, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_session
from core.http import get_client_ip
from config import get_settings
from .models import (
    Token,
    UserCreate,
    UserUpdate,
    UserPreferencesUpdate,
    UserProfileUpdate,
    UserResponse,
    User
)
from . import service
from .totp import (
    generate_totp_secret, generate_backup_codes, hash_backup_codes,
    get_provisioning_uri, generate_qr_base64,
    verify_totp, verify_backup_code, check_totp
)
from .dependencies import (
    get_current_user,
    get_setup_user,
    require_permission,
    oauth2_scheme
)
from .rate_limiter import login_rate_limiter, user_key

router = APIRouter(prefix="/api/auth", tags=["Authentication"])
settings = get_settings()

# Per-user 2FA failure tracking (in-memory; temporary tokens expire in 5 min anyway)
_2fa_attempts: Dict[str, int] = {}  # str(user_id) → attempt count
_2FA_MAX_ATTEMPTS = 5


async def require_step_up(session: AsyncSession, user: User, code: Optional[str]) -> None:
    """
    A fresh TOTP code for a sensitive action (support access), whatever the
    age of the login session. Authenticator codes only, never backup codes; a
    code already used is refused (check_totp). Failures count with the login
    2FA failures: at the limit the 2FA is locked and every session revoked.
    The caller commits on success (the consumed step is stored on the user).
    """
    if not user.totp_enabled or not user.totp_secret:
        raise HTTPException(403, "Attivare la 2FA nel profilo per aprire sessioni di supporto")
    if user.totp_locked:
        raise HTTPException(403, "2FA bloccata: contattare un amministratore")
    plain_secret = service.decrypt_totp_secret(user.totp_secret)
    if code and check_totp(user, plain_secret, code.strip()):
        _2fa_attempts.pop(str(user.id), None)
        session.add(user)
        return
    user_id_str = str(user.id)
    attempts = _2fa_attempts.get(user_id_str, 0) + 1
    _2fa_attempts[user_id_str] = attempts
    if attempts >= _2FA_MAX_ATTEMPTS:
        user.totp_locked = True
        session.add(user)
        service.revoke_sessions(user)
        await session.commit()
        _2fa_attempts.pop(user_id_str, None)
        raise HTTPException(401, f"Troppi codici 2FA errati ({_2FA_MAX_ATTEMPTS}): 2FA bloccata e sessioni chiuse")
    raise HTTPException(403, f"Codice 2FA non valido o già usato ({attempts}/{_2FA_MAX_ATTEMPTS})")


# --- Pydantic models for 2FA ---

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class TwoFactorSetupResponse(BaseModel):
    secret: str
    qr_code: str
    backup_codes: List[str]

class TwoFactorVerifyRequest(BaseModel):
    code: str

class TwoFactorDisableRequest(BaseModel):
    password: str


class InitAdminRequest(BaseModel):
    username: str
    password: str


class PasswordChangePendingRequest(BaseModel):
    new_password: str


def _user_response(user: User, group_paths: Optional[Dict[str, str]] = None) -> UserResponse:
    """Helper to build a UserResponse from a User ORM object."""
    return UserResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        is_active=user.is_active,
        is_superuser=user.is_superuser,
        is_protected=user.is_protected,
        role=user.role,
        access=user.access,
        group_id=user.group_id,
        group_path=(group_paths or {}).get(user.group_id or "", ""),
        auth_source=user.auth_source,
        totp_enabled=user.totp_enabled,
        totp_enforced=user.totp_enforced,
        totp_locked=user.totp_locked,
        must_change_password=user.must_change_password,
        password_expires_at=user.password_expires_at,
        created_at=user.created_at,
        last_login=user.last_login,
        permissions=sorted(user.capabilities()),
        preferences=getattr(user, "preferences", "{}")
    )


async def _group_paths(session: AsyncSession) -> Dict[str, str]:
    from manager.groups import all_groups, paths
    return paths(await all_groups(session))


async def _response(session: AsyncSession, user: User) -> UserResponse:
    return _user_response(user, await _group_paths(session))


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")


def _visible_in(actor: User, target: User, ids) -> bool:
    """
    Whether actor may see target, given actor's scope (manager.scope.group_ids).
    Superusers see everyone; partners and customers see themselves and the
    partner/customer users of their scope, never a superuser.
    """
    if actor.is_superuser or target.id == actor.id:
        return True
    if target.is_superuser:
        return False
    return target.group_id is not None and target.group_id in (ids or set())


async def _visible(session: AsyncSession, actor: User, target: User) -> bool:
    from manager import scope
    return _visible_in(actor, target, await scope.group_ids(session, actor))


async def _get_visible_user(session: AsyncSession, actor: User, username: str) -> User:
    user = await service.get_user_by_username(session, username)
    if not user or not await _visible(session, actor, user):
        raise _not_found()
    return user


async def _check_assignment(session: AsyncSession, actor: User, role: str, group_id: Optional[str]) -> None:
    """
    Role and group actor may give an account. Only a superuser creates
    superusers; partners and customers need a group of the matching kind
    inside actor's scope. Any access level is allowed: actor holds rw
    (users.manage), the highest there is.
    """
    if role == "superuser":
        if not actor.is_superuser:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="Solo un superuser può creare o promuovere superuser")
        return
    if not group_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Un utente partner o cliente richiede un gruppo")
    from manager import scope
    group = await scope.check_group(session, actor, group_id)
    if group.kind != role:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Il ruolo partner va con un gruppo partner, il ruolo cliente con un gruppo cliente",
        )


def _assert_self_edit_allowed(user: User, data: UserUpdate) -> None:
    """
    What PATCH /users/{self} may not change. Your password and your 2FA
    enforcement have their own endpoints, which ask for the current password:
    here a stolen session alone could set a new password and keep the account.
    """
    if data.password is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Use /api/auth/me/password to change your own password"
        )
    if data.totp_enforced is not None and data.totp_enforced != user.totp_enforced:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot change 2FA enforcement on your own account"
        )
    if data.is_active is False:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot deactivate your own account"
        )
    if (data.role is not None and data.role != user.role) or \
            (data.access is not None and data.access != user.access) or \
            (data.group_id is not None and (data.group_id or None) != user.group_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Non puoi cambiare ruolo, accesso o gruppo del tuo account"
        )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session)
):
    """End every session of the current user (all browsers and devices)."""
    service.revoke_sessions(current_user)
    session.add(current_user)
    await session.commit()


@router.post("/init", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def init_first_user(
    request: Request,
    data: InitAdminRequest,
    session: AsyncSession = Depends(get_session)
):
    """
    Crea il primo utente superuser. Funziona solo se non esistono ancora utenti.
    Chiamato dallo script di installazione — non richiede autenticazione.

    Accepted only from a direct loopback call: the installer talks to
    127.0.0.1:8000, while anything through nginx carries X-Real-IP (and, with
    uvicorn's --proxy-headers, the real client address). Without this, anyone
    on the network could claim an instance in the window between nginx
    starting and the installer creating the account.
    """
    peer = request.client.host if request.client else ""
    via_proxy = "x-real-ip" in request.headers or "x-forwarded-for" in request.headers
    if peer not in ("127.0.0.1", "::1") or via_proxy:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")

    ok, msg = service.validate_username(data.username)
    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
    ok, msg = service.validate_password_strength(data.password)
    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
    try:
        user = await service.create_first_user(session, data.username, data.password)
        return _user_response(user)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Setup already completed: users already present"
        )


@router.post("/token", response_model=Token)
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    session: AsyncSession = Depends(get_session)
):
    """
    OAuth2 compatible token login.
    Returns JWT access token on successful authentication.
    If 2FA is enabled, returns token_type='2fa_required' and a temporary token.
    If 2FA is enforced but not set up, returns token_type='2fa_setup_required'.
    """
    # Rate limiting — keyed on the real caller, not on the proxy: behind
    # Nginx the socket peer is always 127.0.0.1, which would collapse every
    # user into one bucket and let anyone lock out the whole instance.
    client_ip = get_client_ip(request)
    # Per IP and per target account: per IP alone, a login with one's own
    # account reset the counter between guesses at someone else's
    limit_keys = (client_ip, user_key(form_data.username))
    login_rate_limiter.begin_attempt(*limit_keys)

    user = await service.authenticate_user(session, form_data.username, form_data.password)

    # Inactive: same error, so the account status is not revealed
    if not user or not user.is_active:
        await login_rate_limiter.record_failure(session, *limit_keys)
        # Committed here: the exception below makes get_session roll back,
        # which used to discard every recorded failure
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Authentication successful — reset rate limit. A revocation is never undone
    # here: tokens issued from now on have a later iat and are valid anyway.
    await login_rate_limiter.record_success(session, *limit_keys)

    # If 2FA is enabled, require OTP verification
    if user.totp_enabled:
        temp_token = service.create_access_token(
            data={"sub": user.username, "user_id": str(user.id), "2fa_pending": True},
            expires_delta=timedelta(minutes=5)
        )
        return {"access_token": temp_token, "token_type": "2fa_required"}

    # If 2FA is enforced but not yet set up, require setup
    if user.totp_enforced and not user.totp_enabled:
        temp_token = service.create_access_token(
            data={"sub": user.username, "user_id": str(user.id), "2fa_setup_required": True},
            expires_delta=timedelta(minutes=15)  # More time to set up
        )
        return {"access_token": temp_token, "token_type": "2fa_setup_required"}

    # If a password change is required (forced or expired), gate before full session
    if service.password_change_required(user):
        temp_token = service.create_access_token(
            data={"sub": user.username, "user_id": str(user.id), "pwd_change_pending": True},
            expires_delta=timedelta(minutes=15)
        )
        return {"access_token": temp_token, "token_type": "password_change_required"}

    # Update last login
    await service.update_last_login(session, user)
    await session.commit()

    # Create token
    access_token = service.create_access_token(
        data={"sub": user.username, "user_id": str(user.id)},
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes)
    )

    return Token(access_token=access_token)


@router.post("/token/2fa", response_model=Token)
async def verify_2fa_login(
    request: Request,
    data: TwoFactorVerifyRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session)
):
    """
    Complete login with 2FA verification.
    Requires the temporary token from /token endpoint.
    The code (TOTP or backup code) travels in the JSON body: in the query
    string it ended up in the nginx and uvicorn access logs.
    After 5 failed attempts, the user's 2FA is locked and must be reset by a superuser.
    """
    code = data.code
    # Rate limiting by IP
    client_ip = get_client_ip(request)
    login_rate_limiter.begin_attempt(client_ip)

    payload = service.decode_access_token(token)
    if not payload or not payload.get("2fa_pending"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired 2FA token"
        )

    user = await service.get_user_by_username(session, payload.get("sub"))
    if not user or not service.token_is_current(payload, user):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired 2FA token"
        )

    # Refuse locked accounts immediately
    if user.totp_locked:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="2FA access is locked. Contact an administrator to unlock the account."
        )

    user_id_str = str(user.id)

    # Verify TOTP code first (a code already used is refused: see check_totp)
    plain_secret = service.decrypt_totp_secret(user.totp_secret)
    if not check_totp(user, plain_secret, code):
        # Try backup code (up to 8 bcrypt checks: off the event loop)
        valid, new_codes = await asyncio.to_thread(verify_backup_code, user.backup_codes or "[]", code)
        if not valid:
            # Record failures
            await login_rate_limiter.record_failure(session, client_ip)
            attempts = _2fa_attempts.get(user_id_str, 0) + 1
            _2fa_attempts[user_id_str] = attempts

            if attempts >= _2FA_MAX_ATTEMPTS:
                # Lock the user's 2FA — superuser must reset it
                user.totp_locked = True
                session.add(user)
                # Also revoke the temporary token and every session
                service.revoke_sessions(user)
                await session.commit()
                _2fa_attempts.pop(user_id_str, None)
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail=(
                        f"Troppi tentativi falliti ({_2FA_MAX_ATTEMPTS}/{_2FA_MAX_ATTEMPTS}). "
                        "La 2FA è stata bloccata. Contatta un amministratore."
                    )
                )

            await session.commit()  # keep the recorded failure (see /token)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid 2FA code ({attempts}/{_2FA_MAX_ATTEMPTS} attempts)"
            )
        # Backup code used — save updated codes list
        user.backup_codes = new_codes
        session.add(user)

    # Success — clear per-user attempt counter
    _2fa_attempts.pop(user_id_str, None)
    await login_rate_limiter.record_success(session, client_ip)

    # 2FA satisfied — now gate on password change if required
    if service.password_change_required(user):
        await session.commit()  # persist any backup-code update done above
        temp_token = service.create_access_token(
            data={"sub": user.username, "user_id": str(user.id), "pwd_change_pending": True},
            expires_delta=timedelta(minutes=15)
        )
        return {"access_token": temp_token, "token_type": "password_change_required"}

    # Update last login
    await service.update_last_login(session, user)
    await session.commit()

    # Create final access token
    access_token = service.create_access_token(
        data={"sub": user.username, "user_id": str(user.id)},
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes)
    )

    return Token(access_token=access_token)


@router.post("/token/password-change", response_model=Token)
async def complete_password_change(
    data: PasswordChangePendingRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session)
):
    """
    Complete a forced/expired password change started at login.
    Requires the temporary token (pwd_change_pending) from /token or /token/2fa.
    On success the password is updated and a full access token is returned.
    """
    payload = service.decode_access_token(token)
    if not payload or not payload.get("pwd_change_pending"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired password-change token"
        )

    user = await service.get_user_by_username(session, payload.get("sub"))
    if not user or not user.is_active or not service.token_is_current(payload, user):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive"
        )

    ok, msg = service.validate_password_strength(data.new_password)
    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)

    # Disallow reusing the current password
    if service.verify_password(data.new_password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La nuova password deve essere diversa dalla precedente"
        )

    # Updates password, clears must_change_password, recomputes expiry from policy.
    # New password: sessions opened with the old one end (the token below is newer).
    await service.update_user(session, user.id, UserUpdate(password=data.new_password))
    service.revoke_sessions(user)
    await service.update_last_login(session, user)
    await session.commit()

    access_token = service.create_access_token(
        data={"sub": user.username, "user_id": str(user.id)},
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes)
    )
    return Token(access_token=access_token)


@router.post("/token/2fa-setup", response_model=Token)
async def complete_2fa_setup(
    data: TwoFactorVerifyRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session)
):
    """
    Complete the enforced 2FA enrollment started at login.

    Requires the temporary token (2fa_setup_required) from /token, plus a valid code
    from the secret generated by /me/2fa/setup. This is the only way out of the
    enforced-but-not-configured state: get_current_user rejects the temporary token,
    so without this endpoint the account would be locked out.
    """
    payload = service.decode_access_token(token)
    if not payload or not payload.get("2fa_setup_required"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired 2FA setup token"
        )

    user = await service.get_user_by_username(session, payload.get("sub"))
    if not user or not user.is_active or not service.token_is_current(payload, user):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive"
        )

    if user.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="2FA is already active"
        )

    if not user.totp_secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Run /me/2fa/setup first to generate the secret"
        )

    plain_secret = service.decrypt_totp_secret(user.totp_secret)
    if not check_totp(user, plain_secret, data.code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid code. Make sure your device time is correct."
        )

    user.totp_enabled = True
    session.add(user)

    # 2FA satisfied — now gate on password change if required
    if service.password_change_required(user):
        await session.commit()
        temp_token = service.create_access_token(
            data={"sub": user.username, "user_id": str(user.id), "pwd_change_pending": True},
            expires_delta=timedelta(minutes=15)
        )
        return {"access_token": temp_token, "token_type": "password_change_required"}

    await service.update_last_login(session, user)
    await session.commit()

    access_token = service.create_access_token(
        data={"sub": user.username, "user_id": str(user.id)},
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes)
    )
    return Token(access_token=access_token)


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session)
):
    """Get current authenticated user information."""
    return await _response(session, current_user)


@router.patch("/me/preferences", response_model=UserResponse)
async def update_user_preferences(
    preferences_data: UserPreferencesUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session)
):
    """Update current user preferences."""
    current_user.preferences = preferences_data.preferences
    session.add(current_user)
    await session.commit()
    await session.refresh(current_user)
    return await _response(session, current_user)


@router.patch("/me/profile", response_model=UserResponse)
async def update_own_profile(
    profile_data: UserProfileUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session)
):
    """Self-service update of the current user's own profile (e.g. contact email)."""
    if profile_data.email is not None:
        email = profile_data.email.strip()
        current_user.email = email or None
    session.add(current_user)
    await session.commit()
    updated = await service.get_user_by_username(session, current_user.username)
    return await _response(session, updated)


# --- User Management ---

@router.get("/users", response_model=List[UserResponse])
async def list_users(
    current_user: User = Depends(require_permission("users.view")),
    session: AsyncSession = Depends(get_session)
):
    """Users the caller may see (superusers: everyone; others: their scope)."""
    from manager import scope
    users = await service.get_all_users(session)
    group_paths = await _group_paths(session)
    ids = await scope.group_ids(session, current_user)
    # Serialize through the shared helper: a second hand-written UserResponse
    # silently dropped every field added to the schema afterwards.
    return [_user_response(u, group_paths) for u in users if _visible_in(current_user, u, ids)]


@router.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    user_data: UserCreate,
    current_user: User = Depends(require_permission("users.manage")),
    session: AsyncSession = Depends(get_session)
):
    """Create a user in the caller's scope (see _check_assignment)."""
    await _check_assignment(session, current_user, user_data.role, user_data.group_id)
    try:
        user = await service.create_user(session, user_data)
        await session.commit()
        user = await service.get_user_by_username(session, user.username)
        return await _response(session, user)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/users/{username}", response_model=UserResponse)
async def get_user(
    username: str,
    current_user: User = Depends(require_permission("users.view")),
    session: AsyncSession = Depends(get_session)
):
    """Get a specific user by username (404 when out of the caller's scope)."""
    return await _response(session, await _get_visible_user(session, current_user, username))


@router.patch("/users/{username}", response_model=UserResponse)
async def update_user(
    username: str,
    user_data: UserUpdate,
    current_user: User = Depends(require_permission("users.manage")),
    session: AsyncSession = Depends(get_session)
):
    """Update a user in the caller's scope."""
    user = await _get_visible_user(session, current_user, username)

    # Protected user: the first setup user can only be modified by themselves
    if user.is_protected and user.id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The system first user can only be modified by themselves"
        )

    if user.auth_source == "ldap" and (user_data.password is not None or user_data.role is not None
                                        or user_data.access is not None or user_data.group_id is not None):
        raise HTTPException(400, "Utente LDAP: password, ruolo, accesso e gruppo vengono dalla directory")
    if user.id == current_user.id:
        _assert_self_edit_allowed(user, user_data)
    elif user_data.role is not None or user_data.group_id is not None:
        # The resulting role and group, checked as on creation
        role = user_data.role or user.role
        group_id = user_data.group_id if user_data.group_id is not None else user.group_id
        await _check_assignment(session, current_user, role, group_id)

    before = (user.role, user.access, user.group_id)
    try:
        updated_user = await service.update_user(session, user.id, user_data)

        # Disabled, given a new password, or moved to another role, access or
        # group: sessions opened before end now. Re-enabling revokes nothing.
        if user_data.is_active is False or user_data.password is not None or \
                (updated_user.role, updated_user.access, updated_user.group_id) != before:
            service.revoke_sessions(updated_user)
        if (updated_user.role, updated_user.access, updated_user.group_id) != before:
            # Support SSH keys are approved for a role: approved again by another superuser
            from manager.keys import reset_approvals
            await reset_approvals(session, updated_user.id)
        await session.commit()

        updated_user = await service.get_user_by_username(session, username)
        return await _response(session, updated_user)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/users/{username}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    username: str,
    current_user: User = Depends(require_permission("users.manage")),
    session: AsyncSession = Depends(get_session)
):
    """Delete a user in the caller's scope."""
    user = await _get_visible_user(session, current_user, username)

    # Prevent self-deletion
    if user.id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete your own account"
        )

    # Protected user: the first setup user cannot be deleted by anyone
    if user.is_protected:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The system first user cannot be deleted"
        )

    from manager.keys import delete_for_user
    await delete_for_user(session, user.id)
    await service.delete_user(session, user.id)
    await session.commit()


@router.delete("/users/{username}/2fa", status_code=status.HTTP_204_NO_CONTENT)
async def disable_user_2fa(
    username: str,
    current_user: User = Depends(require_permission("users.manage")),
    session: AsyncSession = Depends(get_session)
):
    """
    Administrator endpoint to disable and reset 2FA for a specific user.
    Useful for resetting 2FA if a user lost their device or was locked out.
    """
    user = await _get_visible_user(session, current_user, username)

    if user.is_protected and user.id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The system first user can only manage their own 2FA"
        )

    # Your own 2FA goes through /me/2fa/disable, which asks for the password:
    # otherwise a stolen session of a users.manage holder could drop it.
    if user.id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Use /api/auth/me/2fa/disable to turn off your own 2FA"
        )

    # Disable 2FA and clear lock
    user.totp_enabled = False
    user.totp_locked = False
    user.totp_secret = None
    user.backup_codes = None

    session.add(user)

    # Revoke active tokens so user must re-login
    service.revoke_sessions(user)

    await session.commit()


# --- Self-Service Password Change ---

@router.post("/me/password")
async def change_own_password(
    data: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session)
):
    """
    Change own password (requires current password verification).
    """
    from manager.ldapauth import require_local
    require_local(current_user)
    if not service.verify_password(data.current_password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect"
        )

    ok, msg = service.validate_password_strength(data.new_password)
    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)

    await service.update_user(session, current_user.id, UserUpdate(password=data.new_password))

    # Revoke existing tokens — forces re-login with new password
    service.revoke_sessions(current_user)

    await session.commit()

    return {"message": "Password updated successfully. Please log in again."}


# --- 2FA Management ---

@router.get("/me/2fa/status")
async def get_2fa_status(
    current_user: User = Depends(get_current_user)
):
    """Get 2FA status for current user."""
    has_backup_codes = False
    if current_user.backup_codes:
        try:
            codes = json.loads(current_user.backup_codes)
            has_backup_codes = any(not c.get("used", False) for c in codes)
        except (json.JSONDecodeError, AttributeError):
            has_backup_codes = False

    return {
        "enabled": current_user.totp_enabled,
        "enforced": current_user.totp_enforced,
        "locked": current_user.totp_locked,
        "has_backup_codes": has_backup_codes
    }


@router.post("/me/2fa/setup", response_model=TwoFactorSetupResponse)
async def setup_2fa(
    current_user: User = Depends(get_setup_user),
    session: AsyncSession = Depends(get_session)
):
    """
    Start 2FA setup — generates secret and QR code.
    Plaintext secret and backup codes are returned ONCE and never again.
    The user must verify a code with /me/2fa/enable to activate 2FA.
    """
    if current_user.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="2FA is already active. Disable it before setting it up again."
        )

    secret = generate_totp_secret()
    backup_codes_plain = generate_backup_codes()
    uri = get_provisioning_uri(secret, current_user.username)
    qr = generate_qr_base64(uri)

    # Store encrypted secret and hashed backup codes
    current_user.totp_secret = service.encrypt_totp_secret(secret)
    current_user.totp_last_step = None  # a new secret: the replay guard starts over
    current_user.backup_codes = json.dumps(hash_backup_codes(backup_codes_plain))
    session.add(current_user)
    await session.commit()

    return TwoFactorSetupResponse(
        secret=secret,                  # plaintext shown to user once
        qr_code=qr,
        backup_codes=backup_codes_plain  # plaintext shown to user once
    )


@router.post("/me/2fa/enable")
async def enable_2fa(
    data: TwoFactorVerifyRequest,
    current_user: User = Depends(get_setup_user),
    session: AsyncSession = Depends(get_session)
):
    """
    Verify code and enable 2FA.
    Requires a valid TOTP code from the authenticator app.
    """
    if not current_user.totp_secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Run /me/2fa/setup first to generate the secret"
        )

    if current_user.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="2FA is already active"
        )

    plain_secret = service.decrypt_totp_secret(current_user.totp_secret)
    if not check_totp(current_user, plain_secret, data.code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid code. Make sure your device time is correct."
        )

    current_user.totp_enabled = True
    session.add(current_user)
    await session.commit()

    return {"message": "2FA activated successfully"}


@router.delete("/me/2fa/disable")
async def disable_2fa(
    data: TwoFactorDisableRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session)
):
    """
    Disable 2FA (requires password verification).
    Non-superusers cannot disable 2FA if it was enforced by an admin.
    """
    if not current_user.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="2FA is not active"
        )

    # Block non-superusers from disabling enforced 2FA
    if current_user.totp_enforced and not current_user.is_superuser:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="2FA has been enforced by the administrator and cannot be disabled"
        )

    if not service.verify_password(data.password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Incorrect password"
        )

    current_user.totp_secret = None
    current_user.totp_enabled = False
    current_user.totp_locked = False
    # Note: totp_enforced remains true - admin must remove it
    current_user.backup_codes = None
    session.add(current_user)
    await session.commit()

    return {"message": "2FA disabled"}


@router.post("/me/2fa/backup-codes")
async def regenerate_backup_codes(
    data: TwoFactorVerifyRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session)
):
    """
    Regenerate backup codes (requires TOTP code verification).
    Returns a new set of 8 backup codes (plaintext, shown once).
    """
    if not current_user.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="2FA is not active"
        )

    plain_secret = service.decrypt_totp_secret(current_user.totp_secret)
    if not check_totp(current_user, plain_secret, data.code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid code"
        )

    backup_codes_plain = generate_backup_codes()
    current_user.backup_codes = json.dumps(hash_backup_codes(backup_codes_plain))
    session.add(current_user)
    await session.commit()

    return {"backup_codes": backup_codes_plain}


# --- User Edit Permission Check ---

@router.get("/users/{username}/can-edit")
async def can_edit_user(
    username: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session)
):
    """
    Check if current user can edit target user.
    Used by frontend to show/hide edit buttons.
    """
    # Probing other usernames requires users.view, and only users in scope
    # answer: the 404/200 split would otherwise enumerate accounts.
    if username != current_user.username and not current_user.has_permission("users.view"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied. Required: users.view"
        )
    user = await _get_visible_user(session, current_user, username)

    self_edit = user.id == current_user.id
    manage = current_user.has_permission("users.manage") and not self_edit
    if user.is_protected and not self_edit:
        manage = False
    return {
        "can_edit": manage,
        "can_change_password": self_edit or manage,
        "can_delete": manage,
    }
