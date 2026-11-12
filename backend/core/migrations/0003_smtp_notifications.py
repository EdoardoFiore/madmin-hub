"""SMTP settings and recipients of the e-mail notifications."""
from sqlalchemy import text

COLUMNS = (
    "smtp_host VARCHAR(255) NOT NULL DEFAULT ''",
    "smtp_port INTEGER NOT NULL DEFAULT 587",
    "smtp_encryption VARCHAR(4) NOT NULL DEFAULT 'tls'",
    "smtp_username VARCHAR(255) NOT NULL DEFAULT ''",
    "smtp_password VARCHAR(1000)",
    "smtp_from VARCHAR(255) NOT NULL DEFAULT ''",
    "notify_to VARCHAR(1000) NOT NULL DEFAULT ''",
)


async def upgrade(conn):
    for column in COLUMNS:
        await conn.execute(text(f"ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS {column}"))
