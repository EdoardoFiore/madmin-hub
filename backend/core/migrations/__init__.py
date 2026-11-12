"""
Schema migrations of the manager database: create_all only adds tables, so a
change to an existing table or column ships as a numbered step.

    backend/core/migrations/NNNN_<name>.py

Each step defines `async def upgrade(conn)` (an AsyncConnection inside its
own transaction) and runs once, in order, after create_all (so new tables
exist when a step fills them); the last one
applied is recorded in schema_version (component "manager"). Forward only:
a manager update that fails is undone by restoring the backup taken before it
(scripts/manager-backup.sh).

- A fresh database (no table yet): create_all builds the current schema, the
  latest step is recorded, nothing runs.
- A database from before this mechanism: version 0, every step runs. Steps
  are therefore written to be idempotent (ADD COLUMN IF NOT EXISTS, ...).

A step that fails stops the startup (the service does not come up).
"""
import importlib.util
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

from sqlalchemy import text

logger = logging.getLogger(__name__)

COMPONENT = "manager"
STEPS_DIR = Path(__file__).parent
_STEP_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.py$")


def steps(directory: Path = STEPS_DIR) -> List[Tuple[int, Path]]:
    found = sorted((int(m.group(1)), p) for p in directory.iterdir() if (m := _STEP_RE.match(p.name)))
    numbers = [n for n, _ in found]
    if numbers != list(range(1, len(numbers) + 1)):
        raise RuntimeError(f"migration steps in {directory} are not numbered 1..N: {numbers}")
    return found


async def _ensure_table(conn) -> None:
    await conn.execute(text(
        "CREATE TABLE IF NOT EXISTS schema_version ("
        " component VARCHAR(64) PRIMARY KEY, version INTEGER NOT NULL, applied_at TIMESTAMP NOT NULL)"
    ))


async def _get(conn) -> Optional[int]:
    row = (await conn.execute(text("SELECT version FROM schema_version WHERE component = :c"),
                              {"c": COMPONENT})).first()
    return None if row is None else int(row[0])


async def _set(conn, version: int) -> None:
    await conn.execute(text(
        "INSERT INTO schema_version (component, version, applied_at) VALUES (:c, :v, :t) "
        "ON CONFLICT (component) DO UPDATE SET version = :v, applied_at = :t"
    ), {"c": COMPONENT, "v": version, "t": datetime.utcnow()})


async def is_fresh(engine) -> bool:
    """Before create_all: no user table yet means a new installation."""
    async with engine.connect() as conn:
        row = (await conn.execute(text("SELECT to_regclass('public.\"user\"')"))).first()
    return row is None or row[0] is None


async def current_version(engine) -> Optional[int]:
    async with engine.begin() as conn:
        await _ensure_table(conn)
        return await _get(conn)


async def run(engine, fresh: bool) -> None:
    available = steps()
    current = await current_version(engine)
    if current is None and fresh:
        async with engine.begin() as conn:
            await _set(conn, len(available))
        return
    current = current or 0
    if current > len(available):
        raise RuntimeError(f"database schema ({current}) is newer than this manager ({len(available)})")
    for number, path in available[current:]:
        spec = importlib.util.spec_from_file_location(f"manager_migration_{number}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        logger.info("Schema: step %04d (%s)", number, path.stem)
        async with engine.begin() as conn:
            await module.upgrade(conn)
            await _set(conn, number)
