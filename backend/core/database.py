"""
MADMIN Hub Database Module

Provides async PostgreSQL connection using SQLAlchemy 2.0 with asyncpg driver.
Handles session management and database initialization.
"""
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy import text
from sqlalchemy.orm import DeclarativeBase
from sqlmodel import SQLModel
from typing import AsyncGenerator
import logging

from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Create async engine
engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
    # Connections are not kept forever (server restarts, idle timeouts)
    pool_recycle=1800,
    # A statement stuck on a lock fails instead of holding the request (and
    # its pooled connection) indefinitely
    connect_args={"command_timeout": 120},
)

# Async session factory
async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """
    Dependency that provides an async database session.
    Automatically handles commit/rollback and session cleanup.
    """
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
    """
    Initialize database tables.
    Creates all tables defined in SQLModel metadata.
    """
    async with engine.begin() as conn:
        # Import all models to ensure they're registered
        from core.auth.models import User, Permission, UserPermission, LoginAttempt  # noqa: F401
        from core.settings.models import SystemSettings  # noqa: F401
        from core.audit.models import AuditLog  # noqa: F401
        import hub.models  # noqa: F401
        
        await conn.run_sync(SQLModel.metadata.create_all)
        logger.info("Database tables created successfully")


async def check_db_connection() -> bool:
    """
    Check if database connection is healthy.
    Returns True if connection successful, False otherwise.
    """
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            return True
    except Exception as e:
        logger.error(f"Database connection failed: {e}")
        return False
