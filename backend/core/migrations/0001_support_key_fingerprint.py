"""Support SSH sessions record the fingerprint of the operator's key."""
from sqlalchemy import text


async def upgrade(conn):
    await conn.execute(text(
        "ALTER TABLE support_session ADD COLUMN IF NOT EXISTS key_fingerprint VARCHAR(100) NOT NULL DEFAULT ''"))
