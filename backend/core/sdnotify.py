"""
Minimal systemd notify protocol (no dependency): READY=1 and watchdog pings.

The unit sets WatchdogSec; systemd restarts the service when pings stop.
Pings come from a task on the event loop, so they stop exactly when the loop
is blocked (a hung subprocess, a sync call that never returns) — the failure
mode in which the process is alive but no request is ever answered.
Outside systemd (no NOTIFY_SOCKET) everything here is a no-op.

init() takes the variables out of the environment: every subprocess would
otherwise inherit NOTIFY_SOCKET, and systemd logs a rejected message for
each child that uses it (systemctl does).
"""
import asyncio
import logging
import os
import socket

logger = logging.getLogger(__name__)

_socket_address = None
_watchdog_usec = None
_watchdog_pid = None


def init() -> None:
    global _socket_address, _watchdog_usec, _watchdog_pid
    _socket_address = os.environ.pop("NOTIFY_SOCKET", None)
    _watchdog_usec = os.environ.pop("WATCHDOG_USEC", None)
    _watchdog_pid = os.environ.pop("WATCHDOG_PID", None)


def notify(message: str) -> bool:
    address = _socket_address
    if not address or not hasattr(socket, "AF_UNIX"):
        return False
    if address.startswith("@"):
        address = "\0" + address[1:]  # abstract namespace
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(address)
            sock.sendall(message.encode())
        return True
    except OSError as e:
        logger.warning(f"sd_notify failed: {e}")
        return False


def watchdog_interval() -> float:
    """Half of WatchdogSec (systemd's recommendation), or 0 when not enabled."""
    if not _watchdog_usec or (_watchdog_pid and _watchdog_pid != str(os.getpid())):
        return 0.0
    try:
        return int(_watchdog_usec) / 1_000_000 / 2
    except ValueError:
        return 0.0


async def watchdog_loop() -> None:
    interval = watchdog_interval()
    if not interval:
        return
    logger.info(f"systemd watchdog enabled (ping every {interval:.0f}s)")
    while True:
        notify("WATCHDOG=1")
        await asyncio.sleep(interval)
