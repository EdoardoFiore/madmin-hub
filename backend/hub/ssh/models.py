"""
SSH domain models: SSHKey vault, SSHKeyAssignment (push record).
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class SSHKey(SQLModel, table=True):
    __tablename__ = "ssh_key"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(max_length=100, index=True)
    owner: Optional[str] = Field(default=None, max_length=100)  # username who uploaded
    public_key: str = Field()  # full authorized_keys line
    fingerprint: str = Field(unique=True, max_length=128)  # sha256:...
    notes: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class SSHKeyAssignment(SQLModel, table=True):
    __tablename__ = "ssh_key_assignment"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    ssh_key_id: uuid.UUID = Field(foreign_key="ssh_key.id", index=True)

    # Target: single instance or group
    target_type: str = Field(max_length=20)  # "instance" | "group"
    target_id: uuid.UUID = Field(index=True)

    target_user: str = Field(default="madmin", max_length=64)  # linux user on remote
    allow_source_ips: str = Field(default="[]")  # JSON list of IPs (restricts from= in authorized_keys)

    status: str = Field(default="pending", max_length=20)  # pending/active/revoked
    pushed_at: Optional[datetime] = Field(default=None)
    revoked_at: Optional[datetime] = Field(default=None)
    assigned_by: Optional[str] = Field(default=None, max_length=100)
    created_at: datetime = Field(default_factory=datetime.utcnow)
