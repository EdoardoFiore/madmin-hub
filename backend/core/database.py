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
        )
        from hub.telemetry.models import InstanceTelemetry, InstanceCommand  # noqa
        from hub.ssh.models import SSHKey, SSHKeyAssignment  # noqa

        await conn.run_sync(SQLModel.metadata.create_all)
        logger.info("Database tables created")


async def check_db_connection() -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            return True
    except Exception as e:
        logger.error(f"Database connection failed: {e}")
        return False
