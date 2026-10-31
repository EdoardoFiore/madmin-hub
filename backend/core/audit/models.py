"""
MADMIN Audit Log Models

Defines the AuditLog table for tracking API calls with user identity.
"""
from sqlalchemy import Index
from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime
import uuid


class AuditLog(SQLModel, table=True):
    """
    Structured audit log entry for API calls.
    
    Stores who did what, when, and from where.
    Category 'write' = POST/PUT/PATCH/DELETE, 'read' = GET.
    """
    __tablename__ = "audit_log"
    # The Logs page filters by category and pages by timestamp (newest first)
    __table_args__ = (Index("ix_audit_log_category_timestamp", "category", "timestamp"),)
    
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    timestamp: datetime = Field(default_factory=datetime.utcnow, index=True)
    username: str = Field(max_length=100, index=True)  # From JWT, "anonymous" if unauthenticated
    method: str = Field(max_length=10)  # GET, POST, PUT, PATCH, DELETE
    path: str = Field(max_length=500)  # API path called
    status_code: int = Field()
    duration_ms: int = Field()  # Response time in milliseconds
    client_ip: str = Field(max_length=45, default="")  # IPv4 or IPv6
    category: str = Field(max_length=10, index=True, default="read")  # "write" or "read"
    request_body: Optional[str] = Field(default=None)  # JSON stringified payload or truncated text
    response_summary: Optional[str] = Field(default=None, max_length=500)  # Error detail for 4xx/5xx responses
