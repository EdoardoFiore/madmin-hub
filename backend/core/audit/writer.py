"""
MADMIN Audit Log Writer

The middleware hands entries to a bounded in-memory queue; one background task
writes them in batches. This keeps the database round-trip off every API
request, and it caps what a flood of requests can cost: when the queue is full
new entries are dropped (and counted) instead of piling up sessions and
writes.
"""
import asyncio
import logging
from typing import List, Optional

logger = logging.getLogger("madmin.audit")

QUEUE_SIZE = 2000
BATCH_SIZE = 200


class AuditWriter:
    def __init__(self):
        self._queue: Optional[asyncio.Queue] = None
        self._task: Optional[asyncio.Task] = None
        self.dropped = 0

    def _ensure_started(self) -> None:
        # Lazy: the queue and the task must belong to the running event loop
        if self._task is None or self._task.done():
            self._queue = asyncio.Queue(maxsize=QUEUE_SIZE)
            self._task = asyncio.create_task(self._run(), name="audit-writer")

    def submit(self, entry) -> None:
        """Queue an AuditLog entry. Never blocks, never raises."""
        try:
            self._ensure_started()
            self._queue.put_nowait(entry)
        except asyncio.QueueFull:
            self.dropped += 1
            if self.dropped % 100 == 1:
                logger.warning(f"Audit queue full: {self.dropped} entries dropped so far")
        except Exception as e:
            logger.error(f"Audit entry not queued: {e}")

    async def _run(self) -> None:
        while True:
            batch: List = [await self._queue.get()]
            while len(batch) < BATCH_SIZE and not self._queue.empty():
                batch.append(self._queue.get_nowait())
            await self._write(batch)
            for _ in batch:
                self._queue.task_done()

    @staticmethod
    async def _write(batch: List) -> None:
        from core.database import async_session_maker
        try:
            async with async_session_maker() as session:
                session.add_all(batch)
                await session.commit()
            return
        except Exception as e:
            # Never let audit logging take anything else down
            logger.error(f"Failed to persist {len(batch)} audit entries: {e}")
        if len(batch) == 1:
            return
        # One bad entry must not take the others with it: retry one by one,
        # so only the entry the database refuses is lost
        lost = 0
        for entry in batch:
            try:
                async with async_session_maker() as session:
                    session.add(entry)
                    await session.commit()
            except Exception as e:
                lost += 1
                logger.error(f"Audit entry not persisted ({entry.method} {entry.path[:100]}): {e}")
        if lost < len(batch):
            logger.info(f"Audit batch retried one by one: {len(batch) - lost} saved, {lost} lost")

    async def flush(self) -> None:
        """Wait until every queued entry is written (shutdown, tests)."""
        if self._queue is not None and self._task is not None and not self._task.done():
            await self._queue.join()

    async def stop(self) -> None:
        await self.flush()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None


audit_writer = AuditWriter()
