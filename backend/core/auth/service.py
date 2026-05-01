"""
Auth service: password hashing, JWT, user CRUD, permissions.
"""
import base64
import hashlib
import logging
import re
import uuid
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from cryptography.fernet import Fernet
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from config import get_settings

from .models import CORE_PERMISSIONS, Permission, User, UserCreate, UserPermission, UserUpdate

logger = logging.getLogger(__name__)
settings = get_settings()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
ALGORITHM = "HS256"


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def validate_password_strength(password: str) -> Tuple[bool, str]:
    if len(password) < 8:
        return False, "La password deve essere di almeno 8 caratteri"
    if not re.search(r"[A-Z]", password):
        return False, "La password deve contenere almeno una lettera maiuscola"
    if not re.search(r"[0-9]", password):
        return False, "La password deve contenere almeno un numero"
    if not re.search(r"[!@#$%^&*()\-_=+\[\]{}|;:,.<>?]", password):
        return False, "La password deve contenere almeno un carattere speciale"
    return True, ""


def _fernet_for_purpose(purpose: str) -> Fernet:
    """Derive a Fernet key from SECRET_KEY scoped to a purpose (HKDF-like)."""
    material = hashlib.sha256(f"{settings.secret_key}|{purpose}".encode()).digest()
    return Fernet(base64.urlsafe_b64encode(material))


def encrypt_secret(value: str, purpose: str = "totp") -> str:
    return _fernet_for_purpose(purpose).encrypt(value.encode()).decode()


def decrypt_secret(value: str, purpose: str = "totp") -> str:
    return _fernet_for_purpose(purpose).decrypt(value.encode()).decode()


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=settings.access_token_expire_minutes)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError as e:
        logger.warning(f"JWT decode error: {e}")
        return None


async def authenticate_user(session: AsyncSession, username: str, password: str) -> Optional[User]:
    result = await session.execute(
        select(User).options(selectinload(User.permissions)).where(User.username == username)
    )
    user = result.scalar_one_or_none()
    if not user or not verify_password(password, user.hashed_password) or not user.is_active:
        return None
    return user


async def get_user_by_id(session: AsyncSession, user_id: uuid.UUID) -> Optional[User]:
    result = await session.execute(
        select(User).options(selectinload(User.permissions)).where(User.id == user_id)
    )
    return result.scalar_one_or_none()


async def get_user_by_username(session: AsyncSession, username: str) -> Optional[User]:
    result = await session.execute(
        select(User).options(selectinload(User.permissions)).where(User.username == username)
    )
    return result.scalar_one_or_none()


async def get_all_users(session: AsyncSession) -> List[User]:
    result = await session.execute(
        select(User).options(selectinload(User.permissions)).order_by(User.username)
    )
    return result.scalars().all()


async def create_user(session: AsyncSession, data: UserCreate) -> User:
    ok, msg = validate_password_strength(data.password)
    if not ok:
        raise ValueError(msg)
    if await get_user_by_username(session, data.username):
        raise ValueError(f"Username '{data.username}' already exists")

    user = User(
        username=data.username,
        email=data.email,
        hashed_password=get_password_hash(data.password),
        is_superuser=data.is_superuser,
    )
    session.add(user)
    await session.flush()
    await session.refresh(user)
    return user


async def update_user(session: AsyncSession, user_id: uuid.UUID, data: UserUpdate) -> User:
    user = await get_user_by_id(session, user_id)
    if not user:
        raise ValueError("User not found")

    if data.password is not None:
        ok, msg = validate_password_strength(data.password)
        if not ok:
            raise ValueError(msg)
        user.hashed_password = get_password_hash(data.password)
    if data.email is not None:
        user.email = data.email
    if data.is_active is not None:
        user.is_active = data.is_active
    if data.is_superuser is not None:
        user.is_superuser = data.is_superuser

    session.add(user)
    await session.flush()
    await session.refresh(user)
    return user


async def delete_user(session: AsyncSession, user_id: uuid.UUID) -> bool:
    user = await get_user_by_id(session, user_id)
    if not user:
        return False
    await session.delete(user)
    return True


async def update_last_login(session: AsyncSession, user: User) -> None:
    user.last_login = datetime.utcnow()
    session.add(user)


async def get_all_permissions(session: AsyncSession) -> List[Permission]:
    result = await session.execute(select(Permission).order_by(Permission.slug))
    return result.scalars().all()


async def set_user_permissions(
    session: AsyncSession, user_id: uuid.UUID, slugs: List[str]
) -> User:
    user = await get_user_by_id(session, user_id)
    if not user:
        raise ValueError("User not found")
    await session.execute(UserPermission.__table__.delete().where(UserPermission.user_id == user_id))
    for slug in slugs:
        session.add(UserPermission(user_id=user_id, permission_slug=slug))
    await session.flush()
    return await get_user_by_id(session, user_id)


async def init_core_permissions(session: AsyncSession) -> None:
    for perm in CORE_PERMISSIONS:
        existing = await session.execute(select(Permission).where(Permission.slug == perm["slug"]))
        if existing.scalar_one_or_none():
            continue
        session.add(Permission(slug=perm["slug"], description=perm["description"]))
        logger.info(f"Created permission: {perm['slug']}")
    await session.commit()


async def create_first_user(session: AsyncSession, username: str, password: str) -> User:
    result = await session.execute(select(User).limit(1))
    if result.scalar_one_or_none() is not None:
        raise ValueError("Setup already completed")

    user = User(
        username=username,
        email=f"{username}@localhost",
        hashed_password=get_password_hash(password),
        is_superuser=True,
        is_protected=True,
    )
    session.add(user)
    await session.commit()
    result = await session.execute(
        select(User).options(selectinload(User.permissions)).where(User.id == user.id)
    )
    user = result.scalar_one()
    logger.info(f"Created first superuser: {username}")
    return user


def user_to_response(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "is_active": user.is_active,
        "is_superuser": user.is_superuser,
        "is_protected": user.is_protected,
        "totp_enabled": user.totp_enabled,
        "totp_enforced": user.totp_enforced,
        "created_at": user.created_at,
        "last_login": user.last_login,
        "permissions": [p.slug for p in user.permissions],
        "preferences": user.preferences,
    }
