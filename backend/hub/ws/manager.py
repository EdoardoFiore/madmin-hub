"""
WebSocket connection registry.

Maps instance_id → active WebSocket connection.
Thread-safe (asyncio-only, so no threading.Lock needed — single event loop).
"""
import logging
import uuid
from typing import Dict, Optional

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        # instance_id → WebSocket
        self._connections: Dict[uuid.UUID, WebSocket] = {}

    def is_connected(self, instance_id: uuid.UUID) -> bool:
        return instance_id in self._connections

    def get(self, instance_id: uuid.UUID) -> Optional[WebSocket]:
        return self._connections.get(instance_id)

    def register(self, instance_id: uuid.UUID, ws: WebSocket) -> None:
        self._connections[instance_id] = ws
        logger.info(f"WS registered: {instance_id} (total: {len(self._connections)})")

    def unregister(self, instance_id: uuid.UUID) -> None:
        self._connections.pop(instance_id, None)
        logger.info(f"WS unregistered: {instance_id} (total: {len(self._connections)})")

    def connected_ids(self) -> list:
        return list(self._connections.keys())

    async def send(self, instance_id: uuid.UUID, data: dict) -> bool:
        """Send JSON frame to one instance. Returns False if not connected."""
        ws = self._connections.get(instance_id)
        if not ws:
            return False
        try:
            await ws.send_json(data)
            return True
        except Exception as e:
            logger.warning(f"WS send error to {instance_id}: {e}")
            self.unregister(instance_id)
            return False

    async def broadcast(self, data: dict) -> int:
        """Send to all connected instances. Returns count sent."""
        sent = 0
        for iid in list(self._connections):
            if await self.send(iid, data):
                sent += 1
        return sent


# Singleton shared across the app
ws_manager = ConnectionManager()
