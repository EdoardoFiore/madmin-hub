"""
Support tunnels, manager side.

Each open support session has a TCP listener on one port of the support
range, accepting only the operator's IP. For every accepted connection:

    1. tunnel.open {conn_id, target} goes to the instance (control channel);
    2. the agent dials the local endpoint, then opens WSS /agent/tunnel/<conn_id>
       with its certificate;
    3. the two are joined and bytes are copied until either side closes.

conn_id is random, single-use, valid 20 s, and bound to the instance whose
certificate must present it. The manager never terminates the inner protocol:
the browser speaks TLS to the instance's own nginx, ssh speaks to its sshd.
"""
import asyncio
import ipaddress
import logging
import secrets
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from manager.agents import protocol
from manager.agents.dispatcher import send_ephemeral

logger = logging.getLogger("madmin_manager.tunnels")

ATTACH_TIMEOUT = 20
MAX_CONNECTIONS_PER_SESSION = 32
_CHUNK = 64 * 1024


@dataclass(eq=False)
class _Pending:
    instance_id: str
    attached: asyncio.Future            # resolves with the agent WebSocket
    finished: asyncio.Event = field(default_factory=asyncio.Event)


_pending: Dict[str, _Pending] = {}


@dataclass(eq=False)
class Listener:
    session_id: str
    instance_id: str
    target: str
    port: int
    allowed_ip: str
    operator: str
    server: Optional[asyncio.AbstractServer] = None
    # Open operator connections: closed with the session, which otherwise
    # would only stop accepting new ones
    writers: set = field(default_factory=set)


_listeners: Dict[str, Listener] = {}


def _same_ip(a: str, b: str) -> bool:
    try:
        ia, ib = ipaddress.ip_address(a), ipaddress.ip_address(b)
    except ValueError:
        return False
    if getattr(ia, "ipv4_mapped", None):
        ia = ia.ipv4_mapped
    if getattr(ib, "ipv4_mapped", None):
        ib = ib.ipv4_mapped
    return ia == ib


async def _pump(ws: WebSocket, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    async def tcp_to_ws():
        while data := await reader.read(_CHUNK):
            await ws.send_bytes(data)

    async def ws_to_tcp():
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            data = msg.get("bytes")
            if data is None:
                return
            writer.write(data)
            await writer.drain()

    tasks = [asyncio.create_task(tcp_to_ws()), asyncio.create_task(ws_to_tcp())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _serve_connection(listener: Listener, reader: asyncio.StreamReader,
                            writer: asyncio.StreamWriter) -> None:
    peer = (writer.get_extra_info("peername") or ("",))[0]
    refused = None
    if _listeners.get(listener.session_id) is not listener:
        refused = "session closed"
    elif not _same_ip(peer, listener.allowed_ip):
        refused = f"source {peer} is not the allowed IP {listener.allowed_ip}"
    elif len(listener.writers) >= MAX_CONNECTIONS_PER_SESSION:
        refused = "too many connections"
    if refused:
        logger.warning("Support port %d (%s, instance %s): connection refused, %s",
                       listener.port, listener.target, listener.instance_id, refused)
        writer.close()
        return
    listener.writers.add(writer)
    conn_id = secrets.token_urlsafe(24)
    pending = _Pending(listener.instance_id, asyncio.get_running_loop().create_future())
    _pending[conn_id] = pending
    ws = None
    where = f"Tunnel {listener.target} on port {listener.port} (instance {listener.instance_id})"
    try:
        try:
            fut = await send_ephemeral(listener.instance_id, protocol.CMD_TUNNEL_OPEN,
                                       {"conn_id": conn_id, "target": listener.target},
                                       operator=listener.operator, ttl=ATTACH_TIMEOUT)
        except ConnectionError as e:
            # Instance offline, or connected without the tunnel capability
            logger.warning("%s not opened: %s", where, e)
            return
        try:
            result = await asyncio.wait_for(fut, ATTACH_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("%s: no answer to tunnel.open within %ds", where, ATTACH_TIMEOUT)
            return
        if not result.get("ok"):
            logger.warning("%s refused by the instance: %s", where, protocol.error_parts(result)[1])
            return
        try:
            ws = await asyncio.wait_for(pending.attached, ATTACH_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("%s: the instance did not open /agent/tunnel within %ds", where, ATTACH_TIMEOUT)
            return
        await _pump(ws, reader, writer)
    except (ConnectionError, asyncio.TimeoutError, WebSocketDisconnect, OSError) as e:
        logger.debug("%s ended: %s", where, e)
    finally:
        _pending.pop(conn_id, None)
        pending.finished.set()
        listener.writers.discard(writer)
        writer.close()


async def attach_agent(ws: WebSocket, conn_id: str, instance_id: str) -> None:
    """The agent side of a tunnel (WSS /agent/tunnel/<conn_id>)."""
    pending = _pending.get(conn_id)
    if pending is None or pending.instance_id != instance_id or pending.attached.done():
        logger.warning("Tunnel attach from instance %s refused: unknown, expired or used conn_id", instance_id)
        await ws.close(code=protocol.CLOSE_PROTOCOL)
        return
    await ws.accept()
    pending.attached.set_result(ws)
    # The endpoint must stay alive while the connection handler pumps
    await pending.finished.wait()
    try:
        await ws.close()
    except Exception:
        pass


async def start_listener(listener: Listener, bind: str) -> None:
    async def handler(reader, writer):
        await _serve_connection(listener, reader, writer)
    listener.server = await asyncio.start_server(handler, host=bind, port=listener.port, reuse_address=True)
    _listeners[listener.session_id] = listener


def stop_listener(session_id: str) -> None:
    listener = _listeners.pop(session_id, None)
    if listener is None:
        return
    if listener.server:
        listener.server.close()
    # Closing the socket ends the pump: the agent side closes in turn
    for writer in list(listener.writers):
        writer.close()


def ports_in_use() -> set:
    return {l.port for l in _listeners.values()}


def stop_all() -> None:
    for session_id in list(_listeners):
        stop_listener(session_id)
