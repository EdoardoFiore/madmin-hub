"""
TOTP utilities for 2FA: secret generation, provisioning URI, server-side QR PNG,
backup code generation/hashing/verification.

Backup codes are bcrypt-hashed before storage. TOTP secrets are encrypted by
service.encrypt_secret/decrypt_secret with purpose="totp".
"""
import base64
import io
import json
import secrets
from typing import List, Tuple

import pyotp
import qrcode


def generate_totp_secret() -> str:
    return pyotp.random_base32()


def generate_provisioning_uri(secret: str, username: str, issuer: str = "MADMIN Hub") -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=issuer)


def generate_qr_base64(uri: str) -> str:
    """Return a base64-encoded PNG of a QR code (no data URI prefix)."""
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def generate_backup_codes(count: int = 8) -> List[str]:
    """8 codes of 12 uppercase hex chars (48 bits entropy each), plaintext."""
    return [secrets.token_hex(6).upper() for _ in range(count)]


def hash_backup_codes(codes: List[str]) -> str:
    """Hash plaintext codes with bcrypt and return JSON string for DB storage."""
    from .service import pwd_context
    payload = [{"hash": pwd_context.hash(c.upper()), "used": False} for c in codes]
    return json.dumps(payload)


def count_unused_backup_codes(codes_json: str | None) -> int:
    if not codes_json:
        return 0
    try:
        codes = json.loads(codes_json)
        return sum(1 for c in codes if not c.get("used", False))
    except (json.JSONDecodeError, TypeError):
        return 0


def verify_totp(secret: str, code: str) -> bool:
    """valid_window=0 forbids reuse of adjacent windows."""
    return pyotp.TOTP(secret).verify(code, valid_window=0)


def verify_backup_code(codes_json: str | None, code: str) -> Tuple[bool, str | None]:
    """
    Match `code` against stored bcrypt hashes; on hit, mark used and return updated JSON.
    Returns (matched, updated_json_or_original).
    """
    from .service import pwd_context

    if not codes_json:
        return False, codes_json
    try:
        codes = json.loads(codes_json)
    except json.JSONDecodeError:
        return False, codes_json

    cleaned = code.upper().replace("-", "").replace(" ", "")
    for i, entry in enumerate(codes):
        if entry.get("used", False):
            continue
        if pwd_context.verify(cleaned, entry["hash"]):
            codes[i] = {**entry, "used": True}
            return True, json.dumps(codes)
    return False, codes_json
