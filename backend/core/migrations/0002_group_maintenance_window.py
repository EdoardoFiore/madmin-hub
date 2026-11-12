"""Groups get a maintenance window for rollouts."""
from sqlalchemy import text


async def upgrade(conn):
    await conn.execute(text(
        "ALTER TABLE instance_group ADD COLUMN IF NOT EXISTS maintenance_json VARCHAR NOT NULL DEFAULT '{}'"))
