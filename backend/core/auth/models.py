"""
Auth models: User, Permission, UserPermission, RevokedToken.

RBAC slug-based, identical pattern to MADMIN core.
"""
import uuid
from datetime import datetime
from typing import List, Optional

from sqlmodel import Field, Relationship, SQLModel


class UserPermission(SQLModel, table=True):
    __tablename__ = "user_permission"

    user_id: uuid.UUID = Field(foreign_key="user.id", primary_key=True)
    permission_slug: str = Field(foreign_key="permission.slug", primary_key=True)


class Permission(SQLModel, table=True):
    __tablename__ = "permission"

    slug: str = Field(primary_key=True, max_length=100)
    description: str = Field(max_length=255)

    users: List["User"] = Relationship(back_populates="permissions", link_model=UserPermission)


class User(SQLModel, table=True):
    __tablename__ = "user"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    username: str = Field(unique=True, index=True, max_length=50)
    email: Optional[str] = Field(default=None, max_length=255)
    hashed_password: str = Field(max_length=255)

    is_active: bool = Field(default=True)
    is_superuser: bool = Field(default=False)
    is_protected: bool = Field(default=False)

    totp_secret: Optional[str] = Field(default=None, max_length=512)
    totp_enabled: bool = Field(default=False)
    totp_enforced: bool = Field(default=False)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_login: Optional[datetime] = Field(default=None)
    preferences: str = Field(default="{}")

    permissions: List[Permission] = Relationship(back_populates="users", link_model=UserPermission)

    def has_permission(self, slug: str) -> bool:
        if self.is_superuser:
            return True
        return any(p.slug == slug for p in self.permissions)

    def has_any_permission(self, slugs: List[str]) -> bool:
        if self.is_superuser:
            return True
        user_slugs = {p.slug for p in self.permissions}
        return bool(user_slugs.intersection(slugs))


class RevokedToken(SQLModel, table=True):
    __tablename__ = "revoked_token"

    user_id: uuid.UUID = Field(primary_key=True)
    revoked_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: datetime


# --- API schemas ---

class UserCreate(SQLModel):
    username: str = Field(min_length=3, max_length=50)
    password: str
    email: Optional[str] = None
    is_superuser: bool = False


class UserUpdate(SQLModel):
    password: Optional[str] = None
    email: Optional[str] = None
    is_active: Optional[bool] = None
    is_superuser: Optional[bool] = None


class UserResponse(SQLModel):
    id: uuid.UUID
    username: str
    email: Optional[str]
    is_active: bool
    is_superuser: bool
    is_protected: bool = False
    totp_enabled: bool = False
    totp_enforced: bool = False
    created_at: datetime
    last_login: Optional[datetime]
    permissions: List[str] = []
    preferences: str = "{}"


class PermissionResponse(SQLModel):
    slug: str
    description: str


class Token(SQLModel):
    access_token: str
    token_type: str = "bearer"


# Core + hub permissions
CORE_PERMISSIONS = [
    {"slug": "users.view", "description": "View user list"},
    {"slug": "users.manage", "description": "Create, edit, delete users"},
    {"slug": "permissions.manage", "description": "Assign permissions to users"},
    {"slug": "settings.view", "description": "View system settings"},
    {"slug": "settings.manage", "description": "Modify system settings"},
    {"slug": "logs.view", "description": "View audit logs"},
    {"slug": "hub.view", "description": "View fleet, telemetry, instances"},
    {"slug": "hub.manage", "description": "Manage instances, groups, enrollment"},
    {"slug": "hub.ssh", "description": "Manage SSH keys and push assignments"},
]
