"""
Agent compatibility check: plays a manager NEWER than the agent and checks
that the agent follows the compatibility rules of docs/PROTOCOL.md.

It stands in for the backend behind nginx (127.0.0.1:8000), so stop
madmin-manager first and start it again afterwards:

    systemctl stop madmin-manager
    cd /opt/madmin-manager/backend && ../venv/bin/python <path>/scripts/agent-compat-check.py
    systemctl start madmin-manager

(or any path to this file). It waits for an agent to connect (nginx checks
its certificate), then, on that connection:

1. hello_ack with unknown fields, an unknown config key and a known one
2. a frame of an unknown type (the agent must ignore it)
3. a cmd for an unknown command (answer: error code "unsupported")
4. a cmd with an unknown field in the payload (agent.ping still answers)
5. a cmd with an unknown argument (answer: "invalid_args")
6. close with an unknown code (4999): the agent must come back

Exit status 0 when every check passed. Uses only the manager's venv
(starlette, uvicorn) and backend/manager/agents/protocol.py.
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.getcwd())   # run from the manager's backend/
from manager.agents import protocol  # noqa: E402

import uvicorn  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.routing import WebSocketRoute  # noqa: E402
from starlette.websockets import WebSocket  # noqa: E402

TIMEOUT = 30
results = []
connections = []
done = asyncio.Event()


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append(ok)
    print(f"{'OK  ' if ok else 'FAIL'} {name}{f': {detail}' if detail and not ok else ''}", flush=True)


async def recv(ws: WebSocket, until_type: str, frame_id: str = None) -> dict:
    """Next frame of that type (and id), skipping heartbeats and the rest."""
    while True:
        msg = protocol.parse(await asyncio.wait_for(ws.receive_text(), TIMEOUT))
        if msg["type"] == until_type and (frame_id is None or msg["id"] == frame_id):
            return msg


async def cmd(ws: WebSocket, payload: dict, cmd_id: str) -> dict:
    payload = {"operator": "compat-check", "exp": int(time.time()) + 60, **payload}
    await ws.send_text(protocol.frame(protocol.CMD, payload, cmd_id))
    return (await recv(ws, protocol.CMD_RESULT, cmd_id))["payload"]


async def agent_ws(ws: WebSocket) -> None:
    if ws.headers.get("x-ssl-client-verify") != "SUCCESS":
        await ws.close(code=protocol.CLOSE_REVOKED)
        return
    await ws.accept()
    connections.append(time.monotonic())
    hello = protocol.parse(await asyncio.wait_for(ws.receive_text(), TIMEOUT))
    if len(connections) > 1:
        check("6. reconnects after an unknown close code", hello["type"] == protocol.HELLO)
        await ws.send_text(protocol.frame(protocol.HELLO_ACK, {
            "instance_id": hello["payload"].get("instance_id"), "server_time": int(time.time()),
            "revision": protocol.PROTOCOL_REVISION, "features": [], "config": {}}))
        await ws.close(code=1001)
        done.set()
        return
    p = hello["payload"]
    check("hello carries a capability map", isinstance(p.get("capabilities"), dict), str(p.get("capabilities"))[:80])
    print(f"     agent {p.get('facts', {}).get('release_id')} revisions {p.get('revision_min')}-{p.get('revision_max')}")

    await ws.send_text(protocol.frame(protocol.HELLO_ACK, {
        "instance_id": p.get("instance_id"), "server_time": int(time.time()),
        "revision": protocol.PROTOCOL_REVISION, "features": ["feature.from.the.future"],
        "config": {"heartbeat_interval": 30, "setting.from.the.future": 1},
        "manager_version": "99.0.0", "field_from_the_future": {"x": [1, 2]},
    }))
    await ws.send_text(protocol.frame("frame_from_the_future", {"anything": True}))

    # Answered on the same connection: the unknown frame did not close it
    r = await cmd(ws, {"name": "command.from.the.future", "args": {}}, "compat-1")
    check("1-2. unknown hello_ack fields and frame type ignored", True)
    check("3. unknown command -> unsupported", protocol.error_parts(r)[0] == protocol.ERR_UNSUPPORTED, json.dumps(r))

    r = await cmd(ws, {"name": protocol.CMD_PING, "args": {}, "field_from_the_future": 1}, "compat-2")
    check("4. unknown payload field ignored", r.get("ok") is True, json.dumps(r))

    r = await cmd(ws, {"name": protocol.CMD_PING, "args": {"argument_from_the_future": 1}}, "compat-3")
    check("5. unknown argument -> invalid_args", protocol.error_parts(r)[0] == protocol.ERR_INVALID_ARGS, json.dumps(r))

    await ws.close(code=4999, reason="close code from the future")


async def main() -> int:
    app = Starlette(routes=[WebSocketRoute("/agent/ws", agent_ws)])
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=8000, log_level="warning"))
    serve = asyncio.create_task(server.serve())
    print("Waiting for the agent (it reconnects within its backoff)...", flush=True)
    try:
        await asyncio.wait_for(done.wait(), 300)
    except asyncio.TimeoutError:
        check("agent came back within 5 minutes", False)
    server.should_exit = True
    await serve
    ok = bool(results) and all(results)
    print("PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
