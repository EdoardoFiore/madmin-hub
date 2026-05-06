"""
MADMIN Hub Configuration

Loaded from environment variables (.env supported) via Pydantic Settings.
"""
from functools import lru_cache
from typing import List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings

HUB_VERSION = "1.0.0"


class Settings(BaseSettings):
    # Database
    database_url: str = Field(
        default="postgresql+asyncpg://madmin_hub:madmin_hub@localhost:5432/madmin_hub",
        description="PostgreSQL connection URL",
    )

    # Security
    secret_key: str = Field(
        description='JWT signing key. Generate with: python -c "import secrets; print(secrets.token_hex(32))"'
    )

    @field_validator("secret_key")
    @classmethod
    def _validate_secret(cls, v: str) -> str:
        weak = {"CHANGE_THIS_IN_PRODUCTION", "", "secret", "changeme", "password"}
        if v in weak or len(v) < 32:
            raise ValueError(
                "SECRET_KEY non sicuro o troppo corto. "
                'Genera con: python -c "import secrets; print(secrets.token_hex(32))"'
            )
        return v

    access_token_expire_minutes: int = Field(default=720)

    # Server
    debug: bool = Field(default=False)
    allowed_origins: str = Field(default="*")

    # Hub-specific
    hub_public_url: str = Field(default="https://hub.example.com")
    telemetry_retention_days: int = Field(default=30, ge=1, le=365)
    heartbeat_interval_seconds: int = Field(default=60, ge=10, le=600)
    enrollment_token_ttl_minutes: int = Field(default=15, ge=5, le=60)
    command_timeout_seconds: int = Field(default=30, ge=5, le=300)
    ws_max_frame_bytes: int = Field(default=1_048_576, ge=1024)
    backup_storage_path: str = Field(default="/var/lib/madmin-hub/backups")

    @property
    def cors_origins(self) -> List[str]:
        if self.allowed_origins == "*":
            return ["*"]
        return [o.strip() for o in self.allowed_origins.split(",")]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    return Settings()
