"""
MADMIN Authentication Dependencies

FastAPI dependencies for authentication and authorization.
Use these in route handlers to protect endpoints.
"""
from typing import Optional, List, Callable
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
import uuid

from core.database import get_session
from .models import User, TokenData
from . import service

# OAuth2 scheme for Bearer token authentication
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")

# Flags carried by the *temporary* tokens issued during incomplete login flows
# (2FA verification, forced 2FA setup, forced/expired password change). A token
# carrying any of these is NOT a full session and must be rejected by
# get_current_user — otherwise it would bypass the very gate that issued it.
PENDING_FLAGS = ("2fa_pending", "2fa_setup_required", "pwd_change_pending")


async def _resolve_user_from_payload(
    payload: dict,
    session: AsyncSession,
    credentials_exception: HTTPException,
) -> User:
    """Resolve and validate the User referenced by a decoded JWT payload.

    Shared by get_current_user and get_setup_user: checks sub/user_id presence,
    active status, and that the token was issued after the user's last session
    revocation. Does NOT inspect pending flags.
    """
    username: str = payload.get("sub")
    user_id_str: str = payload.get("user_id")

    if username is None or user_id_str is None:
        raise credentials_exception

    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError:
        raise credentials_exception

    user = await service.get_user_by_id(session, user_id)

    if user is None:
        raise credentials_exception
    if not service.token_is_current(payload, user):
        raise credentials_exception
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is disabled"
        )

    return user


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session)
) -> User:
    """
    Dependency to get the current authenticated user.

    Validates the JWT token and returns the User object.
    Raises 401 Unauthorized if token is invalid or user not found.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    payload = service.decode_access_token(token)
    if payload is None:
        raise credentials_exception

    # Reject temporary tokens from incomplete login flows: they carry a valid
    # sub/user_id but must never grant a full session (2FA / forced-password-change bypass).
    if any(payload.get(flag) for flag in PENDING_FLAGS):
        raise credentials_exception

    return await _resolve_user_from_payload(payload, session, credentials_exception)


async def get_setup_user(
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session)
) -> User:
    """
    Dependency for the 2FA setup endpoints (/me/2fa/setup, /me/2fa/enable).

    These serve two legitimate callers:
    - a fully-authenticated user enabling 2FA voluntarily (token with no pending flag);
    - a user whose 2FA is enforced-but-not-configured, holding a temporary
      `2fa_setup_required` token, completing the forced setup.

    Accepts either of the above. Rejects `2fa_pending` (2FA already configured —
    must verify OTP first) and `pwd_change_pending` (must change password first),
    so this remains a narrow exception to get_current_user's blanket rejection.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    payload = service.decode_access_token(token)
    if payload is None:
        raise credentials_exception

    # Never allow the other incomplete-flow tokens onto the setup endpoints.
    if payload.get("2fa_pending") or payload.get("pwd_change_pending"):
        raise credentials_exception

    return await _resolve_user_from_payload(payload, session, credentials_exception)


async def get_current_active_user(
    current_user: User = Depends(get_current_user)
) -> User:
    """Alias for get_current_user that ensures user is active."""
    return current_user


def require_permission(permission_slug: str) -> Callable:
    """
    Dependency factory that requires a specific permission.
    
    Usage:
        @router.get("/protected")
        async def protected_route(user: User = Depends(require_permission("users.manage"))):
            ...
    """
    async def permission_checker(
        current_user: User = Depends(get_current_user)
    ) -> User:
        if not current_user.has_permission(permission_slug):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied. Required: {permission_slug}"
            )
        return current_user
    
    return permission_checker


def require_any_permission(permission_slugs: List[str]) -> Callable:
    """
    Dependency factory that requires any of the specified permissions.
    
    Usage:
        @router.get("/protected")
        async def protected_route(
            user: User = Depends(require_any_permission(["users.view", "users.manage"]))
        ):
            ...
    """
    async def permission_checker(
        current_user: User = Depends(get_current_user)
    ) -> User:
        if not current_user.has_any_permission(permission_slugs):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied. Required one of: {', '.join(permission_slugs)}"
            )
        return current_user
    
    return permission_checker


def require_all_permissions(permission_slugs: List[str]) -> Callable:
    """
    Dependency factory that requires ALL of the specified permissions.

    Used where a capability is a modifier of another one rather than a standalone
    grant — e.g. editing a user's permissions requires both managing users and
    managing permissions.

    Usage:
        @router.put("/protected")
        async def protected_route(
            user: User = Depends(require_all_permissions(["users.manage", "permissions.manage"]))
        ):
            ...
    """
    async def permission_checker(
        current_user: User = Depends(get_current_user)
    ) -> User:
        if not current_user.has_all_permissions(permission_slugs):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied. Required all of: {', '.join(permission_slugs)}"
            )
        return current_user

    return permission_checker


def require_superuser() -> Callable:
    """
    Dependency factory that requires superuser status.
    
    Usage:
        @router.delete("/dangerous")
        async def dangerous_route(user: User = Depends(require_superuser())):
            ...
    """
    async def superuser_checker(
        current_user: User = Depends(get_current_user)
    ) -> User:
        if not current_user.is_superuser:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Superuser access required"
            )
        return current_user
    
    return superuser_checker
