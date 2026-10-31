"""
MADMIN Authentication Service

Business logic for authentication operations including:
- Password hashing and verification
- JWT token creation and validation
- User CRUD operations
- Password strength validation
- TOTP secret encryption/decryption
"""
import re
import time
import asyncio
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Tuple
import bcrypt
import jwt
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, text
from sqlalchemy.orm import selectinload
import uuid
import logging

from config import get_settings
from core import secrets as data_secrets
from .models import User, Permission, UserPermission, UserCreate, UserUpdate, CORE_PERMISSIONS

logger = logging.getLogger(__name__)
settings = get_settings()


# JWT Configuration
ALGORITHM = "HS256"


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash."""
    # bcrypt directly (passlib is unmaintained); hashes are the same $2b$ format
    try:
        return bcrypt.checkpw(plain_password.encode(), hashed_password.encode())
    except ValueError:  # not a bcrypt hash
        return False


def get_password_hash(password: str) -> str:
    """Hash a password for storage."""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


_DUMMY_HASH: Optional[str] = None


def _dummy_hash() -> str:
    """A bcrypt hash nobody knows the password of, for unknown usernames."""
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = get_password_hash(secrets.token_urlsafe(16))
    return _DUMMY_HASH


def is_password_expired(user: User) -> bool:
    """True if the user has an expiry date that is already in the past."""
    return user.password_expires_at is not None and datetime.utcnow() > user.password_expires_at


def password_change_required(user: User) -> bool:
    """True if the user must change password before getting a full session."""
    return user.must_change_password or is_password_expired(user)


async def _get_password_max_age_days(session: AsyncSession) -> int:
    """Read the global password validity policy (0 = disabled)."""
    from core.settings.models import SystemSettings
    result = await session.execute(select(SystemSettings).where(SystemSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if not settings_row:
        return 0
    return getattr(settings_row, "password_max_age_days", 0) or 0


async def _compute_password_expiry(session: AsyncSession, changed_at: datetime) -> Optional[datetime]:
    """Compute expiry date from the global policy, or None if disabled."""
    max_age = await _get_password_max_age_days(session)
    return changed_at + timedelta(days=max_age) if max_age > 0 else None


USERNAME_PATTERN = re.compile(r'^[a-zA-Z0-9._-]{3,50}$')


def validate_username(username: str) -> Tuple[bool, str]:
    """
    Validate username charset to prevent injection into HTML contexts.

    Only allows letters, digits, dot, underscore and hyphen (3-50 chars).
    Returns (True, "") if valid, (False, error_message) otherwise.
    """
    if not USERNAME_PATTERN.match(username or ""):
        return False, "Username non valido: usa solo lettere, numeri, '.', '_' o '-' (3-50 caratteri)"
    return True, ""


def validate_password_strength(password: str) -> Tuple[bool, str]:
    """
    Validate password strength requirements.

    Returns:
        (True, "") if valid, (False, error_message) if invalid.
    """
    if len(password) < 8:
        return False, "La password deve essere di almeno 8 caratteri"
    if not re.search(r'[A-Z]', password):
        return False, "La password deve contenere almeno una lettera maiuscola"
    if not re.search(r'[0-9]', password):
        return False, "La password deve contenere almeno un numero"
    if not re.search(r'[!@#$%^&*()\-_=+\[\]{}|;:,.<>?]', password):
        return False, "La password deve contenere almeno un carattere speciale"
    return True, ""


def encrypt_totp_secret(secret: str) -> str:
    """Encrypt a TOTP secret before storing in the database (see core.secrets)."""
    return data_secrets.encrypt(secret)


def decrypt_totp_secret(encrypted: str) -> str:
    """Decrypt a TOTP secret retrieved from the database (older keys included)."""
    return data_secrets.decrypt(encrypted)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Create a JWT access token.

    Args:
        data: Payload data (typically {"sub": username, "user_id": uuid})
        expires_delta: Token lifetime. Defaults to settings value.

    Returns:
        Encoded JWT token string
    """
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.access_token_expire_minutes)

    # iat to sub-second precision: a login right after a revocation must not
    # land in the same whole second and be refused (see token_is_current)
    to_encode.update({"exp": expire, "iat": time.time()})
    encoded_jwt = jwt.encode(to_encode, settings.secret_key, algorithm=ALGORITHM)
    return encoded_jwt


def revoke_sessions(user: User) -> None:
    """Invalidate every token issued to the user until now. Caller commits."""
    user.tokens_valid_after = datetime.utcnow()


def token_is_current(payload: dict, user: User) -> bool:
    """False if the token was issued before the user's sessions were revoked."""
    if user.tokens_valid_after is None:
        return True
    iat = payload.get("iat")
    if not isinstance(iat, (int, float)):
        return False  # issued before iat existed, and a revocation happened since
    return iat >= user.tokens_valid_after.replace(tzinfo=timezone.utc).timestamp()


def decode_access_token(token: str) -> Optional[dict]:
    """
    Decode and validate a JWT token.

    Returns:
        Token payload dict if valid, None otherwise
    """
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        return payload
    except jwt.PyJWTError as e:
        # Expired tokens are routine (every idle browser tab): not a warning
        logger.debug(f"JWT decode error: {e}")
        return None


async def authenticate_user(session: AsyncSession, username: str, password: str) -> Optional[User]:
    """
    Authenticate a user by username and password.

    Returns:
        User object if authentication successful, None otherwise
    """
    result = await session.execute(
        select(User)
        .options(selectinload(User.permissions))
        .where(User.username == username)
    )
    user = result.scalar_one_or_none()

    # bcrypt takes ~0.25 s of CPU: in a thread, so logins do not stall every
    # other request. An unknown username is checked against a dummy hash, or
    # the response time would tell which usernames exist.
    hashed = user.hashed_password if user else _dummy_hash()
    if not await asyncio.to_thread(verify_password, password, hashed) or not user:
        return None
    if not user.is_active:
        return None

    return user


async def get_user_by_id(session: AsyncSession, user_id: uuid.UUID) -> Optional[User]:
    """Get a user by their UUID, including permissions."""
    result = await session.execute(
        select(User)
        .options(selectinload(User.permissions))
        .where(User.id == user_id)
    )
    return result.scalar_one_or_none()


async def get_user_by_username(session: AsyncSession, username: str) -> Optional[User]:
    """Get a user by username, including permissions."""
    result = await session.execute(
        select(User)
        .options(selectinload(User.permissions))
        .where(User.username == username)
    )
    return result.scalar_one_or_none()


async def get_all_users(session: AsyncSession) -> List[User]:
    """Get all users with their permissions."""
    result = await session.execute(
        select(User)
        .options(selectinload(User.permissions))
        .order_by(User.username)
    )
    return result.scalars().all()


async def create_user(session: AsyncSession, user_data: UserCreate) -> User:
    """
    Create a new user.

    Raises:
        ValueError: If username already exists or password is too weak.
    """
    ok, msg = validate_username(user_data.username)
    if not ok:
        raise ValueError(msg)

    ok, msg = validate_password_strength(user_data.password)
    if not ok:
        raise ValueError(msg)

    existing = await get_user_by_username(session, user_data.username)
    if existing:
        raise ValueError(f"Username '{user_data.username}' already exists")

    now = datetime.utcnow()
    user = User(
        username=user_data.username,
        email=user_data.email,
        hashed_password=get_password_hash(user_data.password),
        is_superuser=user_data.is_superuser,
        totp_enforced=user_data.totp_enforced,
        must_change_password=user_data.must_change_password,
        module_default_level=user_data.module_default_level,
        module_default_capabilities=user_data.module_default_capabilities,
        password_changed_at=now,
        # An explicit expiry wins over the global policy, same as on update
        password_expires_at=(
            user_data.password_expires_at
            if user_data.password_expires_at is not None
            else await _compute_password_expiry(session, now)
        ),
    )

    session.add(user)
    await session.flush()
    await session.refresh(user)

    return user


async def update_user(session: AsyncSession, user_id: uuid.UUID, user_data: UserUpdate) -> User:
    """
    Update an existing user.

    Raises:
        ValueError: If user not found or new password is too weak.
    """
    user = await get_user_by_id(session, user_id)
    if not user:
        raise ValueError("User not found")

    if user_data.password is not None:
        ok, msg = validate_password_strength(user_data.password)
        if not ok:
            raise ValueError(msg)
        user.hashed_password = get_password_hash(user_data.password)
        # Password changed: reset force-change flag and recompute expiry from policy
        now = datetime.utcnow()
        user.password_changed_at = now
        user.must_change_password = False
        user.password_expires_at = await _compute_password_expiry(session, now)
    if user_data.email is not None:
        user.email = user_data.email
    if user_data.is_active is not None:
        user.is_active = user_data.is_active
    if user_data.is_superuser is not None:
        user.is_superuser = user_data.is_superuser
    if user_data.totp_enforced is not None:
        user.totp_enforced = user_data.totp_enforced
    # Admin explicit overrides (applied after password-change recompute)
    if user_data.must_change_password is not None:
        user.must_change_password = user_data.must_change_password
    if user_data.password_expires_at is not None:
        user.password_expires_at = user_data.password_expires_at
    if user_data.module_default_level is not None:
        user.module_default_level = user_data.module_default_level
    if user_data.module_default_capabilities is not None:
        user.module_default_capabilities = user_data.module_default_capabilities

    session.add(user)
    await session.flush()
    await session.refresh(user)

    return user


async def delete_user(session: AsyncSession, user_id: uuid.UUID) -> bool:
    """
    Delete a user.

    Returns:
        True if deleted, False if not found
    """
    user = await get_user_by_id(session, user_id)
    if not user:
        return False

    await session.delete(user)
    return True


async def update_last_login(session: AsyncSession, user: User) -> None:
    """Update user's last login timestamp."""
    user.last_login = datetime.utcnow()
    session.add(user)


# --- Permission Management ---

async def get_all_permissions(session: AsyncSession) -> List[Permission]:
    """Get all registered permissions."""
    result = await session.execute(
        select(Permission).order_by(Permission.slug)
    )
    return result.scalars().all()


async def get_user_permissions(session: AsyncSession, user_id: uuid.UUID) -> List[str]:
    """Get list of permission slugs for a user."""
    user = await get_user_by_id(session, user_id)
    if not user:
        return []
    if user.is_superuser:
        # Return all permissions for superuser
        perms = await get_all_permissions(session)
        return [p.slug for p in perms]
    return [p.slug for p in user.permissions]


async def set_user_permissions(session: AsyncSession, user_id: uuid.UUID, permission_slugs: List[str]) -> User:
    """
    Set permissions for a user (replaces existing permissions).
    """
    user = await get_user_by_id(session, user_id)
    if not user:
        raise ValueError("User not found")

    # Clear existing permissions
    await session.execute(
        UserPermission.__table__.delete().where(UserPermission.user_id == user_id)
    )

    # Add new permissions
    for slug in permission_slugs:
        link = UserPermission(user_id=user_id, permission_slug=slug)
        session.add(link)

    await session.flush()

    # Refresh to get updated permissions
    return await get_user_by_id(session, user_id)


async def apply_password_expiry_policy(session: AsyncSession, max_age_days: int) -> int:
    """
    Backfill password_expires_at for all users that don't have one set.
    Called when the global policy is enabled or changed.
    Uses password_changed_at as reference; falls back to utcnow().
    Returns the number of users updated.
    """
    if max_age_days <= 0:
        return 0

    now = datetime.utcnow()
    delta = timedelta(days=max_age_days)

    result = await session.execute(select(User).where(User.password_expires_at == None))
    users_to_update = result.scalars().all()

    for user in users_to_update:
        ref = user.password_changed_at if user.password_changed_at else now
        user.password_expires_at = ref + delta
        session.add(user)

    return len(users_to_update)


async def init_core_permissions(session: AsyncSession) -> None:
    """
    Reconcile core permissions with CORE_PERMISSIONS.

    Authoritative, not merely additive: slugs that were removed or renamed in
    code are dropped from the database too. Without this, a retired slug would
    linger forever in the permission picker while governing nothing — grantable
    but dead. Module permissions (module_id NOT NULL) are untouched; they are
    owned by the module lifecycle.

    Called during application startup.
    """
    known_slugs = {p["slug"] for p in CORE_PERMISSIONS}

    result = await session.execute(
        select(Permission).where(Permission.module_id.is_(None))
    )
    existing_by_slug = {p.slug: p for p in result.scalars().all()}

    for perm_data in CORE_PERMISSIONS:
        existing = existing_by_slug.get(perm_data["slug"])

        if not existing:
            session.add(Permission(
                slug=perm_data["slug"],
                description=perm_data["description"],
                module_id=None  # Core permissions have no module
            ))
            logger.info(f"Created core permission: {perm_data['slug']}")
        elif existing.description != perm_data["description"]:
            existing.description = perm_data["description"]
            session.add(existing)

    stale_slugs = sorted(set(existing_by_slug) - known_slugs)
    if stale_slugs:
        # user_permission has no ON DELETE CASCADE: clear the link rows first,
        # or the delete below fails on the foreign key.
        await session.execute(
            delete(UserPermission).where(UserPermission.permission_slug.in_(stale_slugs))
        )
        await session.execute(
            delete(Permission).where(Permission.slug.in_(stale_slugs))
        )
        logger.warning(
            f"Removed {len(stale_slugs)} stale core permissions (grants revoked): "
            f"{', '.join(stale_slugs)}"
        )

    await session.commit()


async def create_first_user(
    session: AsyncSession,
    username: str,
    password: str,
    force_password_change: bool = False
) -> User:
    """
    Create the first superuser. Fails if any users already exist.
    Called by POST /api/auth/init during initial setup.
    """
    ok, msg = validate_username(username)
    if not ok:
        raise ValueError(msg)

    # Serialise concurrent calls: check-then-insert alone let two requests both
    # see an empty table and create two superusers. Released at commit.
    await session.execute(text("SELECT pg_advisory_xact_lock(7443002)"))
    result = await session.execute(select(User).limit(1))
    if result.scalar_one_or_none() is not None:
        raise ValueError("Setup already completed: users already exist")

    now = datetime.utcnow()
    user = User(
        username=username,
        email=f"{username}@localhost",
        hashed_password=get_password_hash(password),
        is_superuser=True,
        is_protected=True,
        must_change_password=force_password_change,
        password_changed_at=now
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    logger.info(f"Created first superuser: {username}")
    return user
