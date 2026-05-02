"""
Database setup: async engine, session factory, init helpers.
"""
import logging
from typing import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)

async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db() -> None:
    async with engine.begin() as conn:
        # Import all models so SQLModel.metadata is fully populated
        from core.auth.models import User, Permission, UserPermission, RevokedToken  # noqa
        from core.audit.models import AuditLog  # noqa
        from core.settings.models import SystemSettings, SMTPSettings  # noqa
        from hub.instances.models import (  # noqa
            ManagedInstance,
            InstanceGroup,
            EnrollmentToken,
            Tag,
            InstanceTag,
        )
        from hub.telemetry.models import InstanceTelemetry, InstanceCommand  # noqa
        from hub.ssh.models import SSHKey, SSHKeyAssignment  # noqa

        await conn.run_sync(SQLModel.metadata.create_all)
        logger.info("Database tables created")

    # Safe incremental migrations for new columns on existing tables
    async with engine.begin() as conn:
        await conn.execute(text(
            "ALTER TABLE managed_instance ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45)"
        ))
        await conn.execute(text(
            "ALTER TABLE ssh_key_assignment ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP"
        ))

    await _migrate_json_tags()


async def _migrate_json_tags() -> None:
    """One-time migration: populate Tag+InstanceTag from ManagedInstance.tags JSON column."""
    import json
    from sqlalchemy import select
    from hub.instances.models import ManagedInstance, Tag, InstanceTag

    try:
        async with async_session_maker() as session:
            res = await session.execute(select(ManagedInstance).where(ManagedInstance.tags != "[]"))
            instances = res.scalars().all()
            if not instances:
                return

            tag_cache: dict = {}
            for inst in instances:
                raw_tags = json.loads(inst.tags or "[]")
                if not raw_tags:
                    continue
                # Check if this instance already has InstanceTag rows
                existing = await session.execute(
                    select(InstanceTag).where(InstanceTag.instance_id == inst.id).limit(1)
                )
                if existing.scalar_one_or_none():
                    continue  # already migrated

                for tag_name in raw_tags:
                    tag_name = str(tag_name).strip()
                    if not tag_name:
                        continue
                    if tag_name not in tag_cache:
                        res2 = await session.execute(select(Tag).where(Tag.name == tag_name))
                        tag = res2.scalar_one_or_none()
                        if not tag:
                            tag = Tag(name=tag_name)
                            session.add(tag)
                            await session.flush()
                        tag_cache[tag_name] = tag.id
                    session.add(InstanceTag(instance_id=inst.id, tag_id=tag_cache[tag_name]))
            await session.commit()
            logger.info("JSON tags migration complete")
    except Exception as e:
        logger.warning(f"JSON tags migration skipped: {e}")


async def check_db_connection() -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            return True
    except Exception as e:
        logger.error(f"Database connection failed: {e}")
        return False
