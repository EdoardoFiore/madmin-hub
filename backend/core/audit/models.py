"""
AuditLog model.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class AuditLog(SQLModel, table=True):
    __tablename__ = "audit_log"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    timestamp: datetime = Field(default_factory=datetime.utcnow, index=True)
    username: str = Field(max_length=100, index=True)
    method: str = Field(max_length=10)
    path: str = Field(max_length=500)
    status_code: int = Field()
    duration_ms: int = Field()
    client_ip: str = Field(max_length=45, default="")
    category: str = Field(max_length=20, index=True, default="read")  # read/write/agent_ws
    request_body: Optional[str] = Field(default=None)
    response_summary: Optional[str] = Field(default=None, max_length=500)
