"""LDAP users: where a user's password is checked, and the LDAP settings."""
from sqlalchemy import text

SETTINGS = (
    "ldap_enabled BOOLEAN NOT NULL DEFAULT false",
    "ldap_url VARCHAR(255) NOT NULL DEFAULT ''",
    "ldap_bind_dn VARCHAR(500) NOT NULL DEFAULT ''",
    "ldap_bind_password VARCHAR(1000)",
    "ldap_base_dn VARCHAR(500) NOT NULL DEFAULT ''",
    "ldap_user_filter VARCHAR(500) NOT NULL DEFAULT '(|(uid={username})(sAMAccountName={username}))'",
    "ldap_ca_pem VARCHAR(20000) NOT NULL DEFAULT ''",
    "ldap_mappings VARCHAR(20000) NOT NULL DEFAULT '[]'",
)


async def upgrade(conn):
    await conn.execute(text('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS auth_source VARCHAR(10) NOT NULL DEFAULT \'local\''))
    for column in SETTINGS:
        await conn.execute(text(f"ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS {column}"))
