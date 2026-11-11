"""
MADMIN <-> MADMIN Manager wire protocol.

This file is kept IDENTICAL in both repositories (madmin: backend/core/manager/
protocol.py, madmin-manager: backend/manager/agents/protocol.py); the specification
is madmin-manager/docs/PROTOCOL.md. Any change is copied to the other side in
the same change.

Frames are JSON text messages on the control WebSocket:

    {"v": 1, "id": "<uuid>", "type": "<frame type>", "ts": <unix>, "payload": {...}}

Compatibility rules (normative, see docs/PROTOCOL.md):

- `v` is the major version of the envelope. It is never bumped; a different
  major is refused (close 4400).
- Both sides speak a range of revisions (PROTOCOL_REVISION_MIN..PROTOCOL_REVISION);
  hello carries the agent's range, hello_ack the revision chosen.
- An unknown frame type, payload field, event or hello_ack/config key is
  ignored. An unknown close code means "reconnect with backoff".
- Commands are versioned one by one: hello.capabilities maps every command
  the agent implements to its version, and the manager never sends an
  argument the agent's version does not know. Arguments stay strict on the
  agent (unknown fields are rejected).
- What is not a command is announced as a feature (hello.features,
  hello_ack.features): a side uses a feature only if the other announced it.
"""
import json
import time
import uuid
from typing import Any, Dict, Optional, Tuple

# Major version of the envelope (`v` of every frame): never bumped
PROTOCOL_VERSION = 1
# Revisions of the frames this side speaks (additive changes in semantics)
PROTOCOL_REVISION_MIN = 1
PROTOCOL_REVISION = 1

# Largest frame either side accepts (bytes). Bulk data (backups) never travels
# on the control channel: it uses the HTTPS endpoints.
MAX_FRAME = 1024 * 1024

# --- Frame types (unknown ones are ignored, never an error) ---
HELLO = "hello"            # agent -> manager, first frame: facts + capabilities
HELLO_ACK = "hello_ack"    # manager -> agent: accepted (revision, features, config)
HEARTBEAT = "heartbeat"    # agent -> manager: periodic stats (+ facts when changed)
CMD = "cmd"                # manager -> agent: {name, args, operator, exp, timeout?}
CMD_PROGRESS = "cmd_progress"  # agent -> manager: {state, step?, percent?, message?}, same id
CMD_RESULT = "cmd_result"  # agent -> manager: {ok, data | error}, same id as the cmd
EVENT = "event"            # agent -> manager: unsolicited notice {name, data}

FRAME_TYPES = {HELLO, HELLO_ACK, HEARTBEAT, CMD, CMD_PROGRESS, CMD_RESULT, EVENT}

# cmd.exp: the agent does not start a command after it (delivery deadline).
# cmd.timeout: seconds the execution may take, lowered (never raised) to the
# agent's own limit for that command. A command that has started reports
# cmd_progress {"state": "running"} and is no longer subject to exp.

# --- Close codes (WebSocket application range; unknown ones: reconnect) ---
CLOSE_PROTOCOL = 4400     # malformed frame / unsupported protocol version
CLOSE_REVOKED = 4401      # certificate unknown or instance revoked: do not retry
CLOSE_SUSPENDED = 4403    # instance suspended by the manager: keep everything, retry slowly
CLOSE_SUPERSEDED = 4409   # a newer connection of the same instance replaced this one
CLOSE_TRY_LATER = 4429    # manager busy: the close reason is the seconds to wait

SUSPENDED_RETRY = 900               # seconds between attempts while suspended
TRY_LATER_RANGE = (5, 3600)         # accepted wait of a 4429, seconds

# --- Commands (manager -> agent) ---
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

# Symbolic tunnel targets: the agent maps them to local endpoints, the manager can
# never name a host or port
TUNNEL_TARGETS = ("ui", "ssh")

# Support sessions (UI and SSH) last at most one day
SUPPORT_MINUTES_MIN = 5
SUPPORT_MINUTES_MAX = 1440

# --- Events (agent -> manager) ---
EVENT_SUPPORT_EXPIRED = "support.expired"

# --- Errors: cmd_result {"ok": false, "error": {"code", "message"}} ---
# The manager acts on the code only; the message is for the operator.
ERR_UNSUPPORTED = "unsupported"     # command not implemented by this agent
ERR_INVALID_ARGS = "invalid_args"   # arguments refused by the command's model
ERR_EXPIRED = "expired"             # received after its exp
ERR_BUSY = "busy"                   # a limit is reached: retry later
ERR_TIMEOUT = "timeout"             # the execution took longer than allowed
ERR_PRECONDITION = "precondition"   # the instance is not in a state where it makes sense
ERR_FAILED = "failed"               # attempted, did not succeed (see the message)
ERR_INTERNAL = "internal"           # unexpected error on the agent

# --- Settings the manager pushes in hello_ack.config: (min, max, default) ---
# The agent clamps every value to its range and ignores unknown keys.
CONFIG_LIMITS = {
    "heartbeat_interval": (30, 600, 60),     # seconds between heartbeats
    "facts_interval": (60, 3600, 300),       # seconds between facts checks
    "backoff_max": (30, 900, 60),            # longest wait between reconnects
}


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
    """A received frame, checked for shape (not for a known type: callers
    ignore the types they do not handle). Raises ProtocolError."""
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
    if not isinstance(msg.get("type"), str) or not 1 <= len(msg["type"]) <= 32:
        raise ProtocolError("missing frame type")
    if not isinstance(msg.get("id"), str) or not 1 <= len(msg["id"]) <= 64:
        raise ProtocolError("missing frame id")
    if not isinstance(msg.get("payload"), dict):
        raise ProtocolError("payload is not an object")
    return msg


def negotiate_revision(peer_min, peer_max) -> Optional[int]:
    """The highest revision both sides speak, None if the ranges do not meet."""
    try:
        peer_min, peer_max = int(peer_min), int(peer_max)
    except (TypeError, ValueError):
        return None
    best = min(PROTOCOL_REVISION, peer_max)
    return best if best >= max(PROTOCOL_REVISION_MIN, peer_min) else None


def error_result(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


def error_parts(result: Dict[str, Any]) -> Tuple[str, str]:
    """(code, message) of a failed cmd_result."""
    err = result.get("error")
    if isinstance(err, dict):
        return str(err.get("code") or ERR_FAILED)[:30], str(err.get("message") or "")
    return ERR_FAILED, str(err or "")


def clamp_config(config: Any) -> Dict[str, int]:
    """The known keys of hello_ack.config, each clamped to its range."""
    out = {}
    if not isinstance(config, dict):
        return out
    for key, (lo, hi, _) in CONFIG_LIMITS.items():
        value = config.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = int(min(hi, max(lo, value)))
    return out


def try_later_delay(reason) -> int:
    """Seconds to wait after a 4429 (its reason), clamped; 60 if unreadable."""
    try:
        seconds = int(str(reason).strip())
    except (TypeError, ValueError):
        return 60
    return min(TRY_LATER_RANGE[1], max(TRY_LATER_RANGE[0], seconds))
