"""
Instances domain models: ManagedInstance, InstanceGroup, EnrollmentToken, Tag, InstanceTag.
"""
import uuid
from datetime import datetime
from typing import List, Optional

from sqlmodel import Field, SQLModel


class InstanceGroup(SQLModel, table=True):
    __tablename__ = "instance_group"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(unique=True, max_length=100)
    description: Optional[str] = Field(default=None, max_length=255)
    color: str = Field(default="#206bc4", max_length=20)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ManagedInstance(SQLModel, table=True):
    __tablename__ = "managed_instance"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(index=True, max_length=100)
    fingerprint: str = Field(unique=True, index=True, max_length=128)

    # argon2 hash of agent token (token used by agent on the WS handshake)
    agent_token_hash: str = Field(max_length=255)

    enrollment_status: str = Field(default="pending", max_length=20)  # pending/active/revoked
    last_seen_at: Optional[datetime] = Field(default=None, index=True)
    ws_connected: bool = Field(default=False)
    ws_connected_at: Optional[datetime] = Field(default=None)

    version: Optional[str] = Field(default=None, max_length=20)
    os_info: str = Field(default="{}")  # JSON
    tags: str = Field(default="[]")  # JSON list of strings
    notes: Optional[str] = Field(default=None)

    group_id: Optional[uuid.UUID] = Field(default=None, foreign_key="instance_group.id", index=True)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Tag(SQLModel, table=True):
    __tablename__ = "tag"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(unique=True, max_length=64, index=True)
    color: str = Field(default="#6c757d", max_length=9)
    description: Optional[str] = Field(default=None, max_length=255)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class InstanceTag(SQLModel, table=True):
    __tablename__ = "instance_tag"

    instance_id: uuid.UUID = Field(foreign_key="managed_instance.id", primary_key=True)
    tag_id: uuid.UUID = Field(foreign_key="tag.id", primary_key=True)


class EnrollmentToken(SQLModel, table=True):
    __tablename__ = "enrollment_token"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    token_hash: str = Field(unique=True, max_length=255)
    expires_at: datetime = Field(index=True)
    used_at: Optional[datetime] = Field(default=None)
    used_by_instance_id: Optional[uuid.UUID] = Field(default=None)
    target_group_id: Optional[uuid.UUID] = Field(default=None, foreign_key="instance_group.id")
    default_tags: str = Field(default="[]")  # JSON
    created_by: Optional[str] = Field(default=None, max_length=100)
    created_at: datetime = Field(default_factory=datetime.utcnow)

    name: Optional[str] = Field(default=None, max_length=100)
    token_type: str = Field(default="one_time", max_length=20)  # one_time | reusable
    max_uses: int = Field(default=1)
    use_count: int = Field(default=0)
    revoked_at: Optional[datetime] = Field(default=None)
