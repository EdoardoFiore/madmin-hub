"""
MADMIN data encryption at rest.

Secrets kept in the database (TOTP secrets, SMTP and remote-backup passwords,
the backup passphrase) are encrypted with a key derived from SECRET_KEY by
HKDF with its own label, so the key that signs JWTs is not also the one that
encrypts data.

Values written before this existed were encrypted with sha256(SECRET_KEY)
(TOTP secrets, and the *_enc fields of config archives): MultiFernet keeps
decrypting them, and new values use the derived key.

Rotating SECRET_KEY makes every value here unreadable.
"""
import base64
import hashlib
import logging
from functools import lru_cache
from typing import Optional

from cryptography.fernet import Fernet, MultiFernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from config import get_settings

logger = logging.getLogger(__name__)

_DATA_KEY_INFO = b"madmin data encryption v1"
# Every Fernet token starts with the version byte 0x80, base64 "gAAAAA"
_TOKEN_PREFIX = "gAAAAA"


@lru_cache()
def _fernet() -> MultiFernet:
    secret = get_settings().secret_key.encode()
    data_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_DATA_KEY_INFO).derive(secret)
    legacy_key = hashlib.sha256(secret).digest()
    return MultiFernet([
        Fernet(base64.urlsafe_b64encode(data_key)),
        Fernet(base64.urlsafe_b64encode(legacy_key)),  # decrypt only: older values
    ])


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token: str) -> str:
    """Raises ValueError when the token was not made with this SECRET_KEY."""
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        raise ValueError("Encrypted value cannot be read with the current SECRET_KEY")


def encrypt_setting(value: Optional[str]) -> Optional[str]:
    """A password-like setting as stored in the database (empty stays empty)."""
    if not value:
        return value
    if value.startswith(_TOKEN_PREFIX):
        try:
            decrypt(value)
            return value  # already encrypted
        except ValueError:
            pass
    return encrypt(value)


def decrypt_setting(stored: Optional[str]) -> Optional[str]:
    """
    The setting in clear. A value that is not a Fernet token is returned as is
    (a row written in clear, e.g. by older code); one that is a token but
    cannot be decrypted is logged and returned empty, so a changed SECRET_KEY
    makes the setting look unset instead of sending the token as a password.
    """
    if not stored or not stored.startswith(_TOKEN_PREFIX):
        return stored
    try:
        return decrypt(stored)
    except ValueError:
        logger.error("A stored secret cannot be decrypted with the current SECRET_KEY: set it again")
        return ""
