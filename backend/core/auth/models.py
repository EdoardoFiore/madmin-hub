"""
MADMIN Manager authentication models.

Access is a role, an access level and, for partners and customers, one group:

    role        superuser | partner | customer
    access      rw | ro
    group_id    the partner or customer group (None for superusers)

A superuser sees the whole manager; a partner its partner group and the customers
under it; a customer its own group. rw lets the user change what is in that
scope (instances, backups, users); ro only lets it look. What only the manager
operator does (support access, enrollment, licenses, groups, settings, API
keys, logs, revoking instances) needs a superuser, rw to change it.

Capabilities are derived from role and access, never stored: there is nothing
to grant one by one and nothing that can drift.
"""
from sqlmodel import SQLModel, Field
from pydantic import field_validator
from typing import Literal, Optional, List, Set
from datetime import datetime
import re
import uuid


ROLES = ("superuser", "partner", "customer")
ACCESS_LEVELS = ("rw", "ro")
Role = Literal["superuser", "partner", "customer"]
Access = Literal["rw", "ro"]

# Capability slugs (what the API checks and the UI reads from /me):
#   scope.view    instances, backups and licenses in the user's scope
#   scope.manage  edit instances, run/download/delete/restore backups in scope
#   users.view    users in the scope (superusers: every user)
#   users.manage  create and edit users in the scope, never above one's own level
#   manager.view      manager-wide areas: support sessions, enrollment, licenses, groups,
#                 settings, API keys, logs
#   manager.manage    change them, revoke and delete instances
CAPABILITIES = ("scope.view", "scope.manage", "users.view", "users.manage", "manager.view", "manager.manage")


def capabilities_for(role: str, access: str) -> Set[str]:
    caps = {"scope.view"}
    if access == "rw":
        caps |= {"scope.manage", "users.view", "users.manage"}
    if role == "superuser":
        caps |= {"manager.view", "users.view"}
        if access == "rw":
            caps.add("manager.manage")
    return caps


class User(SQLModel, table=True):
    """System user with authentication and authorization data."""
    __tablename__ = "user"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    username: str = Field(unique=True, index=True, max_length=50)
    email: Optional[str] = Field(default=None, max_length=255)
    hashed_password: str = Field(max_length=255)

    # Status
    is_active: bool = Field(default=True)
    is_protected: bool = Field(default=False)  # First setup user — cannot be modified or deleted by others

    # Access (see the module docstring). Defaults are the least privileged.
    role: str = Field(default="customer", max_length=10, index=True)
    access: str = Field(default="ro", max_length=2)
    group_id: Optional[str] = Field(default=None, foreign_key="instance_group.id", max_length=36, index=True)

    # 2FA Fields
    totp_secret: Optional[str] = Field(default=None, max_length=512)  # encrypted, longer than plain
    totp_enabled: bool = Field(default=False)
    totp_enforced: bool = Field(default=False)  # 2FA required by admin
    totp_locked: bool = Field(default=False)    # Locked after too many failed 2FA attempts
    totp_last_step: Optional[int] = Field(default=None)  # TOTP time step last accepted (replay guard)
    backup_codes: Optional[str] = Field(default=None)  # JSON array of hashed backup codes

    # Password lifecycle
    must_change_password: bool = Field(default=False)  # Force change at next login
    password_changed_at: Optional[datetime] = Field(default=None)
    password_expires_at: Optional[datetime] = Field(default=None)  # None = no expiry

    # Sessions: a token whose iat is earlier than this is rejected. Set on
    # logout, password change or reset, 2FA reset or lockout, deactivation.
    # One timestamp per user rather than a list of revoked tokens: nothing to
    # clean up, nothing to "unrevoke", and a new login is never affected.
    tokens_valid_after: Optional[datetime] = Field(default=None)

    # Metadata
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_login: Optional[datetime] = Field(default=None)

    # Preferences (JSON string)
    preferences: str = Field(default="{}")

    @property
    def is_superuser(self) -> bool:
        """Manager-wide scope (read only too: writing also needs can_write)."""
        return self.role == "superuser"

    @property
    def can_write(self) -> bool:
        return self.access == "rw"

    def capabilities(self) -> Set[str]:
        return capabilities_for(self.role, self.access)

    def has_permission(self, slug: str) -> bool:
        return slug in self.capabilities()


class LoginAttempt(SQLModel, table=True):
    """
    Persistent rate limiting state per key (client IP, or "u:<username>").
    Survives application restarts, preventing brute-force reset via restart.
    """
    __tablename__ = "login_attempt"

    ip: str = Field(primary_key=True, max_length=64)  # IP or "u:<username>" (rate_limiter.user_key)
    attempts: int = Field(default=0)
    block_count: int = Field(default=0)
    blocked_until: Optional[datetime] = Field(default=None)
    last_attempt: datetime = Field(default_factory=datetime.utcnow)


# --- Pydantic Schemas for API ---

class UserCreate(SQLModel):
    """Schema for creating a new user."""
    username: str = Field(min_length=3, max_length=50)

    @field_validator("username")
    @classmethod
    def _validate_username_charset(cls, v: str) -> str:
        # Defense in depth: charset is also enforced in the auth service layer.
        # Restricts username to chars safe in HTML text/attribute contexts.
        if not re.match(r'^[a-zA-Z0-9._-]+$', v or ""):
            raise ValueError("Username non valido: usa solo lettere, numeri, '.', '_' o '-'")
        return v
    password: str  # strength validated in service layer
    email: Optional[str] = None
    role: Role = "customer"
    access: Access = "ro"
    group_id: Optional[str] = Field(default=None, max_length=36)  # required for partner/customer
    # Account policy, applied as the user is created rather than by a follow-up
    # PATCH — a failed second call would otherwise leave an account that is live
    # but not subject to the policy the admin asked for.
    totp_enforced: bool = False              # Force 2FA on first login
    must_change_password: bool = False       # Force password change at first login
    password_expires_at: Optional[datetime] = None  # Overrides the global policy


class UserUpdate(SQLModel):
    """Schema for updating a user. Omitted fields are left unchanged."""
    password: Optional[str] = None  # strength validated in service layer
    email: Optional[str] = None
    is_active: Optional[bool] = None
    role: Optional[Role] = None
    access: Optional[Access] = None
    group_id: Optional[str] = Field(default=None, max_length=36)
    totp_enforced: Optional[bool] = None  # Force 2FA on user
    must_change_password: Optional[bool] = None  # Force password change at next login
    password_expires_at: Optional[datetime] = None  # Manual per-user expiry override


class UserPreferencesUpdate(SQLModel):
    """Schema for updating user preferences."""
    preferences: str


class UserProfileUpdate(SQLModel):
    """Schema for the current user editing their own profile (self-service)."""
    email: Optional[str] = Field(default=None, max_length=255)


class UserResponse(SQLModel):
    """Schema for user API responses (excludes password)."""
    id: uuid.UUID
    username: str
    email: Optional[str]
    is_active: bool
    is_superuser: bool
    is_protected: bool = False
    role: str
    access: str
    group_id: Optional[str] = None
    group_path: str = ""          # "Partner / Customer", for display
    totp_enabled: bool = False
    totp_enforced: bool = False
    totp_locked: bool = False
    must_change_password: bool = False
    password_expires_at: Optional[datetime] = None
    created_at: datetime
    last_login: Optional[datetime]
    permissions: List[str] = []  # capability slugs (derived from role and access)
    preferences: str = "{}"


class Token(SQLModel):
    """JWT token response."""
    access_token: str
    token_type: str = "bearer"


class TokenData(SQLModel):
    """Data extracted from JWT token."""
    username: Optional[str] = None
    user_id: Optional[uuid.UUID] = None
