"""
MADMIN <-> MADMIN Hub wire protocol.

This file is kept IDENTICAL in both repositories (madmin: backend/core/hub/
protocol.py, madmin-hub: backend/hub/agents/protocol.py); the specification
is madmin-hub/docs/PROTOCOL.md. Any change is copied to the other side in
the same change. PROTOCOL_VERSION is bumped only for incompatible changes
(frame shape, existing commands): every frame carries it and a mismatch drops
the connection. A new command is additive and needs no bump, since only agents
that advertise it in hello.capabilities are ever sent it.

Frames are JSON text messages on the control WebSocket:

    {"v": 1, "id": "<uuid>", "type": "<frame type>", "ts": <unix>, "payload": {...}}

Drift between the two sides is made visible, not silent: the agent lists the
commands it implements in `hello.capabilities`, and the hub offers only those.
"""
import json
import time
import uuid
from typing import Any, Dict, Optional

PROTOCOL_VERSION = 1

# Largest frame either side accepts (bytes). Bulk data (backups) never travels
# on the control channel: it uses the HTTPS endpoints.
MAX_FRAME = 1024 * 1024

# --- Frame types ---
HELLO = "hello"            # agent -> hub, first frame: facts + capabilities
HELLO_ACK = "hello_ack"    # hub -> agent: accepted (instance_id, server time)
HEARTBEAT = "heartbeat"    # agent -> hub: periodic stats (+ facts when changed)
CMD = "cmd"                # hub -> agent: {name, args, operator, exp}
CMD_RESULT = "cmd_result"  # agent -> hub: {ok, data | error}, same id as the cmd
EVENT = "event"            # agent -> hub: unsolicited notice {name, data}

FRAME_TYPES = {HELLO, HELLO_ACK, HEARTBEAT, CMD, CMD_RESULT, EVENT}

# --- Close codes (WebSocket application range) ---
CLOSE_PROTOCOL = 4400     # malformed frame / unsupported protocol version
CLOSE_REVOKED = 4401      # certificate unknown or instance revoked: do not retry
CLOSE_SUPERSEDED = 4409   # a newer connection of the same instance replaced this one

# --- Commands (hub -> agent) ---
CMD_PING = "agent.ping"
CMD_INVENTORY = "inventory.refresh"
CMD_BACKUP_RUN = "backup.run"
CMD_BACKUP_RESTORE = "backup.restore"
CMD_SUPPORT_UI_OPEN = "support.ui.open"
CMD_SUPPORT_UI_CLOSE = "support.ui.close"
CMD_SUPPORT_SSH_GRANT = "support.ssh.grant"
CMD_SUPPORT_SSH_REVOKE = "support.ssh.revoke"
CMD_TUNNEL_OPEN = "tunnel.open"
CMD_LICENSE_INSTALL = "license.install"
CMD_LICENSE_REVOKE = "license.revoke"
CMD_STATS_HISTORY = "stats.history"   # read only: resource and traffic history

# Symbolic tunnel targets: the agent maps them to local endpoints, the hub can
# never name a host or port
TUNNEL_TARGETS = ("ui", "ssh")

# --- Events (agent -> hub) ---
EVENT_SUPPORT_EXPIRED = "support.expired"


class ProtocolError(ValueError):
    pass


def frame(type_: str, payload: Optional[Dict[str, Any]] = None, id_: Optional[str] = None) -> str:
    return json.dumps({
        "v": PROTOCOL_VERSION,
        "id": id_ or str(uuid.uuid4()),
        "type": type_,
        "ts": int(time.time()),
        "payload": payload or {},
    }, separators=(",", ":"))


def parse(raw) -> Dict[str, Any]:
    """A received frame, checked for shape. Raises ProtocolError."""
    if isinstance(raw, bytes):
        raise ProtocolError("binary frame on the control channel")
    if len(raw) > MAX_FRAME:
        raise ProtocolError("frame too large")
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        raise ProtocolError("frame is not JSON")
    if not isinstance(msg, dict):
        raise ProtocolError("frame is not an object")
    if msg.get("v") != PROTOCOL_VERSION:
        raise ProtocolError(f"unsupported protocol version {msg.get('v')!r}")
    if msg.get("type") not in FRAME_TYPES:
        raise ProtocolError(f"unknown frame type {msg.get('type')!r}")
    if not isinstance(msg.get("id"), str) or not 1 <= len(msg["id"]) <= 64:
        raise ProtocolError("missing frame id")
    if not isinstance(msg.get("payload"), dict):
        raise ProtocolError("payload is not an object")
    return msg
