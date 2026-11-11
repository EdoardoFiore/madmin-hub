"""
MADMIN Manager database models.

No migrations (same rule as MADMIN): init_db only creates missing tables, so
a column added later must have a default.

The identity of an instance is its id (UUID, the CN of its client
certificate). Hostname and addresses are facts that change: the addresses
are kept as a history (InstanceAddress).
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Index
from sqlmodel import Field, SQLModel


def _uuid() -> str:
    return str(uuid.uuid4())


class InstanceGroup(SQLModel, table=True):
    """
    Where an instance belongs. The manager operator (the main site) sees every
    group; under it there are customers directly, or partners that have their
    own customers:

        (manager) ── customer
              └─ partner ── customer

    kind "partner" is top level only; a "customer" sits at the top or under a
    partner. Names are unique among siblings. Designed so that a future
    partner role can be limited to the subtree of its partner group
    (manager.groups.subtree_ids).
    """
    __tablename__ = "instance_group"

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    name: str = Field(max_length=100, index=True)
    kind: str = Field(default="customer", max_length=10)  # partner | customer
    parent_id: Optional[str] = Field(default=None, foreign_key="instance_group.id", max_length=36, index=True)
    description: str = Field(default="", max_length=500)


class Instance(SQLModel, table=True):
    __tablename__ = "instance"

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    name: str = Field(max_length=100, index=True)
    description: str = Field(default="", max_length=500)
    group_id: Optional[str] = Field(default=None, foreign_key="instance_group.id", max_length=36)
    # active | revoked | decommissioned
    status: str = Field(default="active", max_length=20, index=True)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    enrolled_at: datetime = Field(default_factory=datetime.utcnow)
    last_seen_at: Optional[datetime] = Field(default=None)
    last_ip: Optional[str] = Field(default=None, max_length=45)

    # Facts (from hello / heartbeat)
    hostname: str = Field(default="", max_length=255)
    machine_id: str = Field(default="", max_length=64, index=True)
    madmin_version: str = Field(default="", max_length=30)
    os: str = Field(default="", max_length=100)
    protocol: int = Field(default=0)
    facts_json: str = Field(default="{}")
    capabilities_json: str = Field(default="[]")
    stats_json: str = Field(default="{}")

    # Passphrase the instance encrypts its manager backups with (encrypted here
    # with the data key): kept across re-enrollments, so old backups restore
    backup_passphrase_enc: str = Field(default="")
    backup_enabled: bool = Field(default=True)

    # Free key/value labels (site, contract, ...) and the id of the machine
    # in the provisioning system: both optional, set by the token or at approval
    labels_json: str = Field(default="{}")
    external_ref: Optional[str] = Field(default=None, max_length=100, index=True)


class InstanceAddress(SQLModel, table=True):
    """Where an instance was seen: the source IP of its connections, and the
    addresses of its interfaces. One row per (kind, interface, address)."""
    __tablename__ = "instance_address"
    __table_args__ = (Index("ix_instance_address_instance_current", "instance_id", "current"),)

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    instance_id: str = Field(foreign_key="instance.id", index=True, max_length=36)
    kind: str = Field(max_length=10)  # source | interface
    interface: str = Field(default="", max_length=50)
    address: str = Field(max_length=64)
    first_seen: datetime = Field(default_factory=datetime.utcnow)
    last_seen: datetime = Field(default_factory=datetime.utcnow)
    current: bool = Field(default=True)


class AgentCertificate(SQLModel, table=True):
    """Client certificates issued to instances. A connection is accepted only
    if the fingerprint of the presented certificate is here and not revoked."""
    __tablename__ = "agent_certificate"

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    instance_id: str = Field(foreign_key="instance.id", index=True, max_length=36)
    fingerprint: str = Field(unique=True, index=True, max_length=64)  # sha256 hex of DER
    serial: str = Field(max_length=64)
    not_before: datetime
    not_after: datetime
    revoked: bool = Field(default=False)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EnrollmentToken(SQLModel, table=True):
    __tablename__ = "enrollment_token"

    id: str = Field(primary_key=True, max_length=32)          # token_id (public part)
    secret_hash: str = Field(max_length=64)                    # sha256 hex of the secret
    description: str = Field(default="", max_length=200)
    created_by: str = Field(default="", max_length=100)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: datetime
    max_uses: Optional[int] = Field(default=1)                 # None = unlimited
    uses: int = Field(default=0)
    revoked: bool = Field(default=False)
    group_id: Optional[str] = Field(default=None, foreign_key="instance_group.id", max_length=36)
    # Re-enroll token: the instance keeps this id (reinstall / upgrade)
    reenroll_instance_id: Optional[str] = Field(default=None, foreign_key="instance.id", max_length=36)
    last_used_at: Optional[datetime] = Field(default=None)

    # Applied to the instance at enrollment (all optional)
    name: str = Field(default="", max_length=100)
    labels_json: str = Field(default="{}")
    external_ref: Optional[str] = Field(default=None, max_length=100)
    # Usable only from this source IP
    bind_ip: Optional[str] = Field(default=None, max_length=45)


class EnrollmentRequest(SQLModel, table=True):
    """
    Registration without a token: the instance sends its CSR and waits; an
    operator approves it (giving the fields a token would carry) or rejects
    it. The instance polls with request_secret, known only to it.
    """
    __tablename__ = "enrollment_request"

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    secret_hash: str = Field(max_length=64)
    csr: str
    key_fingerprint: str = Field(max_length=64, index=True)  # sha256 of the public key (SPKI DER)
    facts_json: str = Field(default="{}")
    protocol: int = Field(default=0)
    source_ip: str = Field(max_length=45)
    ca_pinned: bool = Field(default=False)  # the instance checked the CA fingerprint
    status: str = Field(default="pending", max_length=10, index=True)  # pending | approved | rejected | expired
    created_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: datetime
    decided_by: str = Field(default="", max_length=100)
    decided_at: Optional[datetime] = Field(default=None)
    instance_id: Optional[str] = Field(default=None, foreign_key="instance.id", max_length=36)
    cert_pem: Optional[str] = Field(default=None)  # until the instance picks it up
    delivered_at: Optional[datetime] = Field(default=None)


class ApiKey(SQLModel, table=True):
    """
    Machine access for the provisioning system: /api/provisioning/* only,
    limited to its scopes. Never installed on an instance (an instance with
    a key could mint tokens). Only sha256(secret) is stored.
    """
    __tablename__ = "api_key"

    id: str = Field(primary_key=True, max_length=16)
    name: str = Field(unique=True, max_length=100)
    secret_hash: str = Field(max_length=64)
    scopes_json: str = Field(default="[]")
    allowed_cidrs: str = Field(default="", max_length=1000)  # comma-separated; empty = any
    created_by: str = Field(default="", max_length=100)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: Optional[datetime] = Field(default=None)
    last_used_at: Optional[datetime] = Field(default=None)
    last_used_ip: Optional[str] = Field(default=None, max_length=45)
    revoked: bool = Field(default=False)


class Command(SQLModel, table=True):
    """A command for an instance. queued -> sent -> done | failed, or expired
    when not answered before exp. Re-sent after every reconnect until it has
    a result: the agent deduplicates by id."""
    __tablename__ = "command"
    __table_args__ = (Index("ix_command_instance_status", "instance_id", "status"),)

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    instance_id: str = Field(foreign_key="instance.id", index=True, max_length=36)
    name: str = Field(max_length=50)
    args_json: str = Field(default="{}")
    operator: str = Field(default="", max_length=100)
    status: str = Field(default="queued", max_length=10)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    sent_at: Optional[datetime] = Field(default=None)
    finished_at: Optional[datetime] = Field(default=None)
    expires_at: datetime
    result_json: Optional[str] = Field(default=None)
    error: Optional[str] = Field(default=None, max_length=1000)


class Backup(SQLModel, table=True):
    __tablename__ = "backup"

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    instance_id: str = Field(foreign_key="instance.id", index=True, max_length=36)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    size: int = Field(default=0)
    sha256: str = Field(max_length=64)
    archive_name: str = Field(default="", max_length=200)
    madmin_version: str = Field(default="", max_length=30)
    trigger: str = Field(default="manual", max_length=20)  # manual | scheduled
    created_by: str = Field(default="", max_length=100)
    command_id: Optional[str] = Field(default=None, max_length=36)


class License(SQLModel, table=True):
    __tablename__ = "license"

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)  # lid
    instance_id: str = Field(foreign_key="instance.id", index=True, max_length=36)
    feature: str = Field(max_length=50, index=True)
    active: bool = Field(default=True)
    valid_until: Optional[datetime] = Field(default=None)  # end of the entitlement; None = until revoked
    token: str = Field(default="")                          # current signed token
    token_expires_at: Optional[datetime] = Field(default=None)
    notes: str = Field(default="", max_length=500)
    created_by: str = Field(default="", max_length=100)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    revoked_at: Optional[datetime] = Field(default=None)


class SupportSession(SQLModel, table=True):
    __tablename__ = "support_session"

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    instance_id: str = Field(foreign_key="instance.id", index=True, max_length=36)
    kind: str = Field(max_length=5)                 # ui | ssh
    operator: str = Field(max_length=100)
    reason: str = Field(default="", max_length=500)
    status: str = Field(default="open", max_length=10, index=True)  # open | closed | expired | replaced
    port: int
    allowed_ip: str = Field(max_length=45)
    username: str = Field(default="", max_length=60)    # ui: account on the instance
    principal: str = Field(default="", max_length=100)  # ssh: certificate principal
    created_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: datetime
    closed_at: Optional[datetime] = Field(default=None)
    closed_by: str = Field(default="", max_length=100)
