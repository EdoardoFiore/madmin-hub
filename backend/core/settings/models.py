"""
Manager settings: one row (id=1).
"""
import re
from typing import Optional
from urllib.parse import urlsplit

from pydantic import field_validator
from sqlmodel import Field, SQLModel


class SystemSettings(SQLModel, table=True):
    __tablename__ = "system_settings"

    id: int = Field(default=1, primary_key=True)
    company_name: str = Field(default="MADMIN Manager", max_length=100)
    primary_color: str = Field(default="#206bc4", max_length=7)
    default_language: str = Field(default="it", max_length=5)
    password_max_age_days: int = Field(default=0)

    # https://host:port the instances connect to (agent endpoint, mTLS):
    # written into every enrollment token
    agent_url: str = Field(default="", max_length=255)
    # Host operators use to reach the support ports (defaults to agent_url's)
    support_host: str = Field(default="", max_length=255)
    support_port_min: int = Field(default=9100)
    support_port_max: int = Field(default=9119)

    backup_interval_hours: int = Field(default=24)   # 0 = no scheduled backups
    backup_retention: int = Field(default=14)        # backups kept per instance

    license_validity_days: int = Field(default=30)   # lifetime of one license token

    # Registration without a token (approved later from Enrollment)
    registration_enabled: bool = Field(default=True)
    registration_allowed_cidrs: str = Field(default="", max_length=1000)  # comma-separated; empty = any
    registration_ttl_days: int = Field(default=14)
    registration_max_pending: int = Field(default=100)

    # Agent tuning, pushed in hello_ack.config (ranges: protocol.CONFIG_LIMITS)
    agent_heartbeat_interval: int = Field(default=60)
    agent_facts_interval: int = Field(default=300)
    agent_backoff_max: int = Field(default=60)

    # Release signing public keys (PEM, one or more): an uploaded release must
    # be signed by one of them. Empty = not checked here (the instances always check)
    release_keys: str = Field(default="", max_length=10000)

    # E-mail notifications (ROADMAP 10.2): new registration request, SSH key to
    # approve, rollout halted, failed update or kernel trial, instance in
    # rescue, new critical vulnerability. No host = no e-mail (the menu badges
    # stay). Recipients: notify_to, or every active superuser with an e-mail.
    smtp_host: str = Field(default="", max_length=255)
    smtp_port: int = Field(default=587)
    smtp_encryption: str = Field(default="tls", max_length=4)   # none | tls | ssl
    smtp_username: str = Field(default="", max_length=255)
    smtp_password: Optional[str] = Field(default=None, max_length=1000)   # encrypted, never returned
    smtp_from: str = Field(default="", max_length=255)
    notify_to: str = Field(default="", max_length=1000)

    updated_at: Optional[str] = Field(default=None)


class SystemSettingsUpdate(SQLModel):
    company_name: Optional[str] = None
    primary_color: Optional[str] = None
    default_language: Optional[str] = None
    password_max_age_days: Optional[int] = None
    agent_url: Optional[str] = None
    support_host: Optional[str] = None
    support_port_min: Optional[int] = None
    support_port_max: Optional[int] = None
    backup_interval_hours: Optional[int] = None
    backup_retention: Optional[int] = None
    license_validity_days: Optional[int] = None
    registration_enabled: Optional[bool] = None
    registration_allowed_cidrs: Optional[str] = None
    registration_ttl_days: Optional[int] = None
    registration_max_pending: Optional[int] = None
    agent_heartbeat_interval: Optional[int] = None
    agent_facts_interval: Optional[int] = None
    agent_backoff_max: Optional[int] = None
    release_keys: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_encryption: Optional[str] = None
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None   # "" = keep the stored one
    smtp_from: Optional[str] = None
    notify_to: Optional[str] = None

    @field_validator("smtp_encryption")
    @classmethod
    def _enc(cls, v):
        if v is not None and v not in ("none", "tls", "ssl"):
            raise ValueError("Cifratura: none, tls o ssl")
        return v

    @field_validator("smtp_port")
    @classmethod
    def _port(cls, v):
        if v is not None and not 1 <= v <= 65535:
            raise ValueError("Porta non valida")
        return v

    @field_validator("notify_to", "smtp_from")
    @classmethod
    def _emails(cls, v):
        if v:
            for a in (x.strip() for x in v.split(",")):
                if a and not re.match(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$", a):
                    raise ValueError(f"Indirizzo e-mail non valido: {a}")
        return v

    @field_validator("registration_allowed_cidrs")
    @classmethod
    def _cidrs(cls, v):
        if v:
            from manager.netutil import parse_cidrs
            v = ",".join(str(n) for n in parse_cidrs(v))
        return v

    @field_validator("registration_ttl_days")
    @classmethod
    def _ttl(cls, v):
        if v is not None and not 1 <= v <= 90:
            raise ValueError("Valore fuori intervallo (1-90)")
        return v

    @field_validator("registration_max_pending")
    @classmethod
    def _max_pending(cls, v):
        if v is not None and not 1 <= v <= 10000:
            raise ValueError("Valore fuori intervallo (1-10000)")
        return v

    @field_validator("primary_color")
    @classmethod
    def _color(cls, v):
        if v is not None and not re.fullmatch(r"#[0-9a-fA-F]{3,6}", v):
            raise ValueError("Colore non valido")
        return v

    @field_validator("default_language")
    @classmethod
    def _lang(cls, v):
        if v is not None and v not in ("it", "en"):
            raise ValueError("Lingua non supportata")
        return v

    @field_validator("agent_url")
    @classmethod
    def _agent_url(cls, v):
        if v:
            p = urlsplit(v)
            if p.scheme != "https" or not p.hostname or p.path not in ("", "/"):
                raise ValueError("URL agent non valido (atteso https://host:porta)")
            v = v.rstrip("/")
        return v

    @field_validator("support_host")
    @classmethod
    def _host(cls, v):
        if v and not re.fullmatch(r"[A-Za-z0-9.:-]{1,255}", v):
            raise ValueError("Host non valido")
        return v

    @field_validator("support_port_min", "support_port_max")
    @classmethod
    def _port(cls, v):
        if v is not None and not 1024 <= v <= 65535:
            raise ValueError("Porta fuori intervallo (1024-65535)")
        return v

    @field_validator("password_max_age_days", "backup_interval_hours")
    @classmethod
    def _non_negative(cls, v):
        if v is not None and not 0 <= v <= 3650:
            raise ValueError("Valore fuori intervallo")
        return v

    @field_validator("backup_retention")
    @classmethod
    def _retention(cls, v):
        if v is not None and not 1 <= v <= 365:
            raise ValueError("Valore fuori intervallo (1-365)")
        return v

    @field_validator("license_validity_days")
    @classmethod
    def _validity(cls, v):
        if v is not None and not 3 <= v <= 365:
            raise ValueError("Valore fuori intervallo (3-365)")
        return v

    @field_validator("agent_heartbeat_interval", "agent_facts_interval", "agent_backoff_max")
    @classmethod
    def _agent_config(cls, v, info):
        from manager.agents.protocol import CONFIG_LIMITS
        lo, hi, _ = CONFIG_LIMITS[info.field_name.removeprefix("agent_")]
        if v is not None and not lo <= v <= hi:
            raise ValueError(f"Valore fuori intervallo ({lo}-{hi})")
        return v

    @field_validator("release_keys")
    @classmethod
    def _release_keys(cls, v):
        if v:
            from manager.releases.service import load_keys
            load_keys(v)   # ValueError when a key is not an Ed25519 public key
            v = v.strip() + "\n"
        return v

