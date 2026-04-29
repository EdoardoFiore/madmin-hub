"""
System and SMTP settings (singleton rows id=1).
"""
from typing import Optional

from sqlmodel import Field, SQLModel


class SystemSettings(SQLModel, table=True):
    __tablename__ = "system_settings"

    id: int = Field(default=1, primary_key=True)
    company_name: str = Field(default="MADMIN Hub", max_length=100)
    primary_color: str = Field(default="#206bc4", max_length=20)
    logo_url: Optional[str] = Field(default=None, max_length=500)
    favicon_url: Optional[str] = Field(default=None, max_length=500)
    audit_retention_days: int = Field(default=90)
    telemetry_retention_days: int = Field(default=30)


class SMTPSettings(SQLModel, table=True):
    __tablename__ = "smtp_settings"

    id: int = Field(default=1, primary_key=True)
    enabled: bool = Field(default=False)
    host: Optional[str] = Field(default=None, max_length=255)
    port: int = Field(default=587)
    username: Optional[str] = Field(default=None, max_length=255)
    password: Optional[str] = Field(default=None, max_length=512)  # encrypted
    use_tls: bool = Field(default=True)
    from_address: Optional[str] = Field(default=None, max_length=255)
    from_name: str = Field(default="MADMIN Hub", max_length=100)
