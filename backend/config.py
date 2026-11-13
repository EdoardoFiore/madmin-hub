"""
MADMIN Manager configuration (environment / .env, Pydantic Settings).
"""
from functools import lru_cache
from typing import List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings

MANAGER_VERSION = "1.1.1"


class Settings(BaseSettings):
    database_url: str = Field(default="postgresql+asyncpg://madmin_manager:madmin_manager@localhost:5432/madmin_manager")

    # Signs the UI JWTs and, through HKDF, encrypts the secrets at rest
    # (TOTP, the CA and license private keys, the backup passphrases).
    # Rotating it makes all of them unreadable.
    secret_key: str = Field(description="python -c 'import secrets; print(secrets.token_hex(32))'")

    @field_validator("secret_key")
    @classmethod
    def validate_secret_key(cls, v: str) -> str:
        weak = {"CHANGE_THIS_IN_PRODUCTION", "", "secret", "changeme", "password"}
        if v in weak or len(v) < 32 or "change" in v.lower():
            raise ValueError("SECRET_KEY non sicuro o troppo corto")
        return v

    access_token_expire_minutes: int = Field(default=720)
    debug: bool = Field(default=False)
    allowed_origins: str = Field(default="*")

    data_dir: str = Field(default="/opt/madmin-manager/data")

    # Addresses the support listeners bind to (one port per open session)
    support_bind: str = Field(default="0.0.0.0")

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
