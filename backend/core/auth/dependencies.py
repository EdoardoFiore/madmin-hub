"""
FastAPI dependencies: get_current_user, require_permission, require_superuser.
"""
import uuid
from typing import Callable, List

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_session

from . import service
from .models import User
from .token_blacklist import token_blacklist

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> User:
    creds_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    payload = service.decode_access_token(token)
    if not payload:
        raise creds_exc

    username = payload.get("sub")
    user_id_str = payload.get("user_id")
    if not username or not user_id_str:
        raise creds_exc
    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError:
        raise creds_exc

    if token_blacklist.is_revoked(user_id):
        raise creds_exc

    user = await service.get_user_by_id(session, user_id)
    if not user:
        raise creds_exc
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User disabled")
    return user


def require_permission(slug: str) -> Callable:
    async def checker(user: User = Depends(get_current_user)) -> User:
        if not user.has_permission(slug):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied. Required: {slug}",
            )
        return user

    return checker


def require_any_permission(slugs: List[str]) -> Callable:
    async def checker(user: User = Depends(get_current_user)) -> User:
        if not user.has_any_permission(slugs):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied. Required one of: {', '.join(slugs)}",
            )
        return user

    return checker


def require_superuser() -> Callable:
    async def checker(user: User = Depends(get_current_user)) -> User:
        if not user.is_superuser:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Superuser access required"
            )
        return user

    return checker
