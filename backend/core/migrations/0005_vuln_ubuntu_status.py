"""Vulnerabilities: withdrawn advisories, Ubuntu tracker status of a finding.

The cached advisories are dropped: they were stored without the withdrawn
flag, and the next scan (a minute after the start) fetches them again.
"""
from sqlalchemy import text


async def upgrade(conn):
    await conn.execute(text("ALTER TABLE advisory ADD COLUMN IF NOT EXISTS withdrawn BOOLEAN NOT NULL DEFAULT false"))
    await conn.execute(text("ALTER TABLE finding ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT ''"))
    await conn.execute(text("ALTER TABLE finding ADD COLUMN IF NOT EXISTS status_version VARCHAR(200) NOT NULL DEFAULT ''"))
    await conn.execute(text("ALTER TABLE finding ADD COLUMN IF NOT EXISTS kernel_fix VARCHAR(250) NOT NULL DEFAULT ''"))
    await conn.execute(text("DELETE FROM advisory"))
