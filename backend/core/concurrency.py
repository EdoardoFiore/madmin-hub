"""
Background tasks and named locks shared by core and modules.

spawn_background: asyncio keeps only a weak reference to a task, so a bare
create_task() can be garbage-collected mid-run, and its exception is reported
(if ever) only when the task object is collected. Here the task is held until
it finishes and a failure is logged with its traceback.

resource_lock: one asyncio.Lock per name, for read-modify-write sequences
that span an await (an iptables rebuild, a config file shared by several
requests).
"""
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Awaitable, Dict, Set

logger = logging.getLogger(__name__)

_tasks: Set[asyncio.Task] = set()
_locks: Dict[str, asyncio.Lock] = {}


def _task_done(task: asyncio.Task) -> None:
    _tasks.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error(f"Background task '{task.get_name()}' failed", exc_info=exc)


def spawn_background(coro: Awaitable, name: str) -> asyncio.Task:
    task = asyncio.ensure_future(coro)
    task.set_name(name)
    _tasks.add(task)
    task.add_done_callback(_task_done)
    return task


@asynccontextmanager
async def resource_lock(name: str):
    lock = _locks.get(name)
    if lock is None:
        lock = _locks[name] = asyncio.Lock()
    async with lock:
        yield
