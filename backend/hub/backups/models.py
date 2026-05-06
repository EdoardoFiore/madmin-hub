"""
Backup domain models: BackupRepo, InstanceBackup, BackupSchedule.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class BackupRepo(SQLModel, table=True):
    __tablename__ = "backup_repo"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(max_length=100, unique=True)
    type: str = Field(max_length=20)          # "local" | "sftp" | "ftp" | "scp"
    is_default: bool = Field(default=False)

    # Remote connection (None for local)
    host: Optional[str] = Field(default=None, max_length=255)
    port: Optional[int] = Field(default=None)
    username: Optional[str] = Field(default=None, max_length=100)
    password: Optional[str] = Field(default=None, max_length=1000)  # Fernet encrypted
    remote_path: str = Field(default="/backups", max_length=500)

    # Local path override (None → use config.backup_storage_path)
    local_path: Optional[str] = Field(default=None, max_length=500)
    retention_days: int = Field(default=30)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    created_by: Optional[str] = Field(default=None, max_length=100)


class InstanceBackup(SQLModel, table=True):
    __tablename__ = "instance_backup"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    instance_id: uuid.UUID = Field(foreign_key="managed_instance.id", index=True)
    repo_id: uuid.UUID = Field(foreign_key="backup_repo.id", index=True)
    filename: str = Field(max_length=255)
    size_bytes: Optional[int] = Field(default=None)
    # For local repo: absolute path on hub filesystem.
    # For sftp/ftp/scp: remote path on the repo server.
    storage_path: str = Field(max_length=1000)
    triggered_by: Optional[str] = Field(default=None, max_length=100)  # username or "scheduler"
    schedule_id: Optional[uuid.UUID] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    status: str = Field(default="ok", max_length=20)  # "ok" | "partial" | "failed"
    errors: Optional[str] = Field(default=None)        # JSON array of error strings


class BackupSchedule(SQLModel, table=True):
    __tablename__ = "backup_schedule"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(max_length=100)
    repo_id: uuid.UUID = Field(foreign_key="backup_repo.id", index=True)

    # Scope: JSON array of instance UUIDs. If empty, group_id is used.
    instance_ids: str = Field(default="[]")
    group_id: Optional[uuid.UUID] = Field(default=None)

    interval_hours: int = Field(default=24, ge=1)
    enabled: bool = Field(default=True)
    last_run: Optional[datetime] = Field(default=None)
    next_run: datetime = Field(default_factory=datetime.utcnow)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    created_by: Optional[str] = Field(default=None, max_length=100)
