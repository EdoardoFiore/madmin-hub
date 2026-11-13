"""Time of the automatic updates (settings, groups); rollouts with a start time
and created by schedules (the rollout_schedule table comes from create_all)."""
from sqlalchemy import text

STEPS = (
    "ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS autoupdate_time VARCHAR(5) NOT NULL DEFAULT '03:00'",
    "ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS autoupdate_tz VARCHAR(60) NOT NULL DEFAULT 'Europe/Rome'",
    "ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS autoupdate_randomize INTEGER NOT NULL DEFAULT 30",
    "ALTER TABLE instance_group ADD COLUMN IF NOT EXISTS autoupdate_time VARCHAR(5) NOT NULL DEFAULT ''",
    "ALTER TABLE rollout ADD COLUMN IF NOT EXISTS start_at TIMESTAMP",
    "ALTER TABLE rollout ADD COLUMN IF NOT EXISTS schedule_id VARCHAR(36) NOT NULL DEFAULT ''",
)


async def upgrade(conn):
    for step in STEPS:
        await conn.execute(text(step))
