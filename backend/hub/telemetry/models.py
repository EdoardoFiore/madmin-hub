"""
Telemetry domain models: InstanceTelemetry (time-series), InstanceCommand (queue + log).
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger
from sqlmodel import Field, SQLModel


class InstanceTelemetry(SQLModel, table=True):
    __tablename__ = "instance_telemetry"

    id: int = Field(default=None, primary_key=True)
    instance_id: uuid.UUID = Field(foreign_key="managed_instance.id", index=True)
    ts: datetime = Field(default_factory=datetime.utcnow, index=True)

    cpu_percent: float = Field(default=0.0)
    ram_percent: float = Field(default=0.0)
    ram_total: int = Field(default=0, sa_type=BigInteger)
    ram_used: int = Field(default=0, sa_type=BigInteger)
    disk_percent: float = Field(default=0.0)
    disk_total: int = Field(default=0, sa_type=BigInteger)
    disk_used: int = Field(default=0, sa_type=BigInteger)
    net_in_bps: int = Field(default=0, sa_type=BigInteger)
    net_out_bps: int = Field(default=0, sa_type=BigInteger)

    services_status: str = Field(default="{}")  # JSON
    modules_status: str = Field(default="[]")  # JSON
    raw: str = Field(default="{}")  # JSON for forward-compatible payload


class InstanceCommand(SQLModel, table=True):
    __tablename__ = "instance_command"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    instance_id: uuid.UUID = Field(foreign_key="managed_instance.id", index=True)
    correlation_id: str = Field(unique=True, max_length=100, index=True)

    action: str = Field(max_length=50)  # firewall.apply, service.restart, backup.run, ssh.push, info, ssh.revoke
    payload: str = Field(default="{}")  # JSON
    status: str = Field(default="queued", max_length=20, index=True)  # queued/sent/done/failed/timeout
    result: Optional[str] = Field(default=None)  # JSON
    error: Optional[str] = Field(default=None, max_length=2000)

    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    sent_at: Optional[datetime] = Field(default=None)
    finished_at: Optional[datetime] = Field(default=None)
    expires_at: datetime
    requested_by: Optional[str] = Field(default=None, max_length=100)
