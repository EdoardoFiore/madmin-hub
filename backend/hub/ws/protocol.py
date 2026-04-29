"""
WebSocket frame protocol (JSON, shared with agent side).

All frames have: {"type": "<type>", "payload": {...}}
Commands carry correlation_id for request/response matching.
"""
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field
import uuid


# ── Frame types ─────────────────────────────────────────────────────────────

# agent → hub
FRAME_HEARTBEAT = "heartbeat"
FRAME_EVENT = "event"
FRAME_COMMAND_RESULT = "command_result"
FRAME_PONG = "pong"

# hub → agent
FRAME_COMMAND = "command"
FRAME_CONFIG_UPDATE = "config_update"
FRAME_PING = "ping"

# Commands (action field inside FRAME_COMMAND)
ACTION_INFO = "info"
ACTION_SERVICE_RESTART = "service.restart"
ACTION_BACKUP_RUN = "backup.run"
ACTION_SSH_PUSH = "ssh.push"
ACTION_SSH_REVOKE = "ssh.revoke"
ACTION_FIREWALL_APPLY = "firewall.apply"


class Frame(BaseModel):
    type: str
    payload: dict = Field(default_factory=dict)


class CommandFrame(BaseModel):
    """Hub → agent command."""
    correlation_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    action: str
    params: dict = Field(default_factory=dict)
    timeout_seconds: int = 30


class CommandResultFrame(BaseModel):
    """Agent → hub command result."""
    correlation_id: str
    success: bool
    result: Optional[dict] = None
    error: Optional[str] = None


class HeartbeatPayload(BaseModel):
    """Expected shape of heartbeat payload (flexible — extra keys OK)."""
    cpu: dict = Field(default_factory=dict)
    memory: dict = Field(default_factory=dict)
    disk: dict = Field(default_factory=dict)
    network: dict = Field(default_factory=dict)
    services: dict = Field(default_factory=dict)
    modules: list = Field(default_factory=list)
    version: Optional[str] = None


class EventPayload(BaseModel):
    event_type: str  # e.g. module.disabled, service.down, agent.shutting_down
    severity: str = "info"  # info/warn/error/critical
    message: str
    data: dict = Field(default_factory=dict)


class ConfigUpdatePayload(BaseModel):
    heartbeat_interval_seconds: Optional[int] = None
    # future: new token rotation, etc.
