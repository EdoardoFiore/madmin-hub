"""
MADMIN Manager database models.

init_db creates missing tables; a change to an existing table (a new column,
a type) also needs a numbered step in core/migrations (see its docstring).

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
    # active | suspended | revoked | decommissioned
    status: str = Field(default="active", max_length=20, index=True)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    enrolled_at: datetime = Field(default_factory=datetime.utcnow)
    last_seen_at: Optional[datetime] = Field(default=None)
    last_ip: Optional[str] = Field(default=None, max_length=45)

    # Facts (from hello / heartbeat)
    hostname: str = Field(default="", max_length=255)
    machine_id: str = Field(default="", max_length=64, index=True)
    madmin_version: str = Field(default="", max_length=30)
    build: str = Field(default="", max_length=40, index=True)   # git commit of the release
    layout: int = Field(default=0)   # on-disk layout (0 = flat install, no updater)
    os: str = Field(default="", max_length=100)
    protocol: int = Field(default=0)              # major (frame `v`)
    protocol_revision: int = Field(default=0)     # negotiated in the last hello
    facts_json: str = Field(default="{}")
    capabilities_json: str = Field(default="{}")  # {command: version} from the last hello
    features_json: str = Field(default="[]")      # agent features from the last hello
    trusted_ca_json: str = Field(default="[]")    # CA fingerprints the agent trusts (hello.state.ca)
    update_json: str = Field(default="{}")        # updater journal (hello.state.update, update.status)
    # Rescue (madmin-rescue, when MADMIN is down): last report and the one
    # action a superuser queued for it {id, action, release_id?, sha256?, by, at, status}
    rescue_json: str = Field(default="{}")
    rescue_at: Optional[datetime] = Field(default=None)
    rescue_action_json: str = Field(default="{}")
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
    """A command for an instance. queued -> sent -> [running ->] done | failed,
    or expired when not started before exp (expires_at). A long command
    reports running when it starts and then has `timeout` seconds to finish.
    Re-sent after every reconnect until it has a result: the agent
    deduplicates by id."""
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
    started_at: Optional[datetime] = Field(default=None)   # first cmd_progress
    finished_at: Optional[datetime] = Field(default=None)
    expires_at: datetime
    timeout: Optional[int] = Field(default=None)   # execution limit sent to the agent (s)
    progress_json: Optional[str] = Field(default=None)   # last cmd_progress
    result_json: Optional[str] = Field(default=None)
    error_code: Optional[str] = Field(default=None, max_length=30)   # protocol.ERR_*
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
    key_fingerprint: str = Field(default="", max_length=100)  # ssh: the operator's key signed
    created_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: datetime
    closed_at: Optional[datetime] = Field(default=None)
    closed_by: str = Field(default="", max_length=100)


class Release(SQLModel, table=True):
    """A signed MADMIN release (madmin-<release_id>.release in DATA_DIR/releases/).
    The manager only stores and distributes it: the instances check the
    signature with their own keys. candidate on upload; stable once promoted
    (rollouts beyond a single instance take stable releases only)."""
    __tablename__ = "release"

    id: str = Field(primary_key=True, max_length=80)   # <version>+<build>
    version: str = Field(max_length=30, index=True)
    build: str = Field(max_length=40)
    channel: str = Field(default="candidate", max_length=10)   # candidate | stable
    size: int = Field(default=0)
    sha256: str = Field(max_length=64)          # of the .release file
    manifest_json: str = Field(default="{}")
    signed_by: str = Field(default="", max_length=100)   # key that verified it here ("" = no key configured)
    notes: str = Field(default="", max_length=1000)
    uploaded_by: str = Field(default="", max_length=100)
    uploaded_at: datetime = Field(default_factory=datetime.utcnow)



class UserSshKey(SQLModel, table=True):
    """A public key a user may get support SSH certificates for. Added (or
    re-approved after a change of role, access or group) as pending; only
    another superuser rw, or the root CLI (python -m manager.keys), approves
    it. Only the public half is ever stored."""
    __tablename__ = "user_ssh_key"
    __table_args__ = (Index("ix_user_ssh_key_user_fp", "user_id", "fingerprint", unique=True),)

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    user_id: uuid.UUID = Field(foreign_key="user.id", index=True)
    name: str = Field(max_length=100)
    public_key: str = Field(max_length=16384)
    fingerprint: str = Field(max_length=100)        # SHA256:... as ssh-keygen -lf prints it
    status: str = Field(default="pending", max_length=10, index=True)   # pending | approved
    created_at: datetime = Field(default_factory=datetime.utcnow)
    approved_by: str = Field(default="", max_length=100)
    approved_at: Optional[datetime] = Field(default=None)
    last_used_at: Optional[datetime] = Field(default=None)


# --- Inventory and vulnerabilities (ROADMAP 8) ---

class InstanceInventory(SQLModel, table=True):
    """A heavy section of an instance's facts (packages, python), fetched with
    inventory.get when the digest in its facts changes."""
    __tablename__ = "instance_inventory"

    instance_id: str = Field(foreign_key="instance.id", primary_key=True, max_length=36)
    section: str = Field(primary_key=True, max_length=20)
    digest: str = Field(default="", max_length=64)
    items_json: str = Field(default="[]")
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    # Digest announced in the facts and not fetched yet ("" = up to date)
    wanted_digest: str = Field(default="", max_length=64)


class InventoryChange(SQLModel, table=True):
    """What changed in a section between two fetches (the history)."""
    __tablename__ = "inventory_change"
    __table_args__ = (Index("ix_inventory_change_instance_at", "instance_id", "at"),)

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    instance_id: str = Field(foreign_key="instance.id", max_length=36)
    section: str = Field(max_length=20)
    at: datetime = Field(default_factory=datetime.utcnow)
    # [{"name", "from", "to"}]: from "" = installed, to "" = removed
    changes_json: str = Field(default="[]")


class Advisory(SQLModel, table=True):
    """A vulnerability record from OSV (Ubuntu security data, PyPI advisories)."""
    __tablename__ = "advisory"

    id: str = Field(primary_key=True, max_length=100)        # UBUNTU-CVE-..., GHSA-..., PYSEC-...
    summary: str = Field(default="", max_length=500)
    aliases_json: str = Field(default="[]")                  # CVE ids
    severity: str = Field(default="unknown", max_length=10, index=True)  # critical|high|medium|low|negligible|unknown
    published: Optional[datetime] = Field(default=None)
    modified: Optional[datetime] = Field(default=None)
    # {"<ecosystem>|<package>": "<fixed version>" or ""}
    fixed_json: str = Field(default="{}")
    url: str = Field(default="", max_length=300)
    fetched_at: datetime = Field(default_factory=datetime.utcnow)


class OsvQuery(SQLModel, table=True):
    """Cache of OSV answers: which advisories affect one package version."""
    __tablename__ = "osv_query"

    key: str = Field(primary_key=True, max_length=300)       # <ecosystem>|<name>|<version>
    vulns_json: str = Field(default="[]")                    # [[id, modified]]
    queried_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class Finding(SQLModel, table=True):
    """An advisory that affects an instance now. Recomputed after every scan;
    first_seen survives the recomputation."""
    __tablename__ = "finding"
    __table_args__ = (Index("ix_finding_unique", "instance_id", "advisory_id", "package", unique=True),)

    id: str = Field(default_factory=_uuid, primary_key=True, max_length=36)
    instance_id: str = Field(foreign_key="instance.id", index=True, max_length=36)
    advisory_id: str = Field(max_length=100, index=True)
    kind: str = Field(max_length=10)                         # os | python
    package: str = Field(max_length=200)                     # source package (os) or distribution (python)
    installed_version: str = Field(default="", max_length=200)
    fixed_version: str = Field(default="", max_length=200)   # "" = no fix published yet
    severity: str = Field(default="unknown", max_length=10, index=True)
    first_seen: datetime = Field(default_factory=datetime.utcnow)
