"""
Live agent connections (in memory: the hub runs as one process).

One connection per instance, and the newest wins: a reconnecting agent whose
previous socket is still half-open on our side replaces it at once (the old
one is closed with 4409) instead of being refused until a ping times out.
Nothing about connections is persisted: "online" is only what is here.
"""
import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Optional, Set

from fastapi import WebSocket

from . import protocol

logger = logging.getLogger(__name__)


@dataclass(eq=False)
class AgentConnection:
    instance_id: str
    ws: WebSocket
    source_ip: str
    capabilities: Set[str] = field(default_factory=set)
    protocol: int = protocol.PROTOCOL_VERSION
    connected_at: datetime = field(default_factory=datetime.utcnow)
    outbox: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=1000))

    def send(self, text: str) -> bool:
        try:
            self.outbox.put_nowait(text)
            return True
        except asyncio.QueueFull:
            logger.warning("Outbox of %s full: frame dropped", self.instance_id)
            return False

    async def close(self, code: int, reason: str = "") -> None:
        try:
            await self.ws.close(code=code, reason=reason[:100])
        except Exception:
            pass


class Registry:
    def __init__(self) -> None:
        self._conns: Dict[str, AgentConnection] = {}
        # cmd id -> future resolved with the cmd_result payload
        self._waiters: Dict[str, asyncio.Future] = {}

    def get(self, instance_id: str) -> Optional[AgentConnection]:
        return self._conns.get(instance_id)

    def is_online(self, instance_id: str) -> bool:
        return instance_id in self._conns

    def online_ids(self) -> Set[str]:
        return set(self._conns)

    async def register(self, conn: AgentConnection) -> None:
        old = self._conns.get(conn.instance_id)
        self._conns[conn.instance_id] = conn
        if old is not None:
            logger.info("Instance %s reconnected: previous connection replaced", conn.instance_id)
            await old.close(protocol.CLOSE_SUPERSEDED, "superseded")

    def unregister(self, conn: AgentConnection) -> None:
        if self._conns.get(conn.instance_id) is conn:
            del self._conns[conn.instance_id]

    async def disconnect(self, instance_id: str, code: int, reason: str = "") -> None:
        conn = self._conns.pop(instance_id, None)
        if conn is not None:
            await conn.close(code, reason)

    # --- Waiting for results ---

    def waiter(self, cmd_id: str) -> asyncio.Future:
        fut = self._waiters.get(cmd_id)
        if fut is None or fut.done():
            fut = asyncio.get_running_loop().create_future()
            self._waiters[cmd_id] = fut
        return fut

    def resolve(self, cmd_id: str, payload: dict) -> None:
        fut = self._waiters.pop(cmd_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    def drop_waiter(self, cmd_id: str) -> None:
        self._waiters.pop(cmd_id, None)


registry = Registry()
