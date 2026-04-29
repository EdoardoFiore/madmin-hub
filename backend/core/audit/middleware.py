"""
AuditLogMiddleware: persist API calls with user identity, sanitized payload, response error.
"""
import json
import logging
import time

from jose import JWTError, jwt
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from config import get_settings

logger = logging.getLogger("madmin_hub.audit")
ALGORITHM = "HS256"

SENSITIVE_KEY_PATTERNS = [
    "password",
    "secret",
    "token",
    "key",
    "psk",
    "passphrase",
    "credential",
]
MASK = "***"


def _sanitize_value(key: str, value):
    if isinstance(value, dict):
        return _sanitize_dict(value)
    if isinstance(value, list):
        return [_sanitize_value(key, v) for v in value]
    if isinstance(key, str):
        kl = key.lower()
        for p in SENSITIVE_KEY_PATTERNS:
            if p in kl:
                return MASK
    return value


def _sanitize_dict(d: dict) -> dict:
    return {k: _sanitize_value(k, v) for k, v in d.items()}


def _extract_username(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return "anonymous"
    try:
        payload = jwt.decode(auth[7:], get_settings().secret_key, algorithms=[ALGORITHM])
        return payload.get("sub", "anonymous")
    except JWTError:
        return "anonymous"


def _get_client_ip(request: Request) -> str:
    return (
        request.headers.get("x-real-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "unknown")
    )


def _is_empty_body(text):
    if not text:
        return True
    s = text.strip()
    return s in ("", "{}", "[]", "null")


class AuditLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if not path.startswith("/api/"):
            return await call_next(request)

        method = request.method
        username = _extract_username(request)
        client_ip = _get_client_ip(request)

        body_text = None
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            ct = request.headers.get("content-type", "")
            if "multipart/form-data" not in ct:
                try:
                    body_bytes = await request.body()

                    async def receive():
                        return {"type": "http.request", "body": body_bytes}

                    request._receive = receive

                    if body_bytes:
                        if len(body_bytes) > 50_000:
                            body_text = "<payload too large>"
                        else:
                            text = body_bytes.decode("utf-8")
                            if "application/json" in ct:
                                try:
                                    data = json.loads(text)
                                    if isinstance(data, dict):
                                        body_text = json.dumps(_sanitize_dict(data))
                                    elif isinstance(data, list):
                                        body_text = json.dumps(
                                            [
                                                _sanitize_dict(i) if isinstance(i, dict) else i
                                                for i in data
                                            ]
                                        )
                                    else:
                                        body_text = text
                                except json.JSONDecodeError:
                                    body_text = text
                            elif "application/x-www-form-urlencoded" in ct:
                                from urllib.parse import parse_qs

                                try:
                                    parsed = parse_qs(text, keep_blank_values=True)
                                    flat = {k: (v[0] if len(v) == 1 else v) for k, v in parsed.items()}
                                    body_text = json.dumps(_sanitize_dict(flat))
                                except Exception:
                                    body_text = "<form parse error>"
                            else:
                                body_text = text
                except Exception as e:
                    logger.warning(f"Audit body read failed: {e}")
                    body_text = "<read error>"

        if _is_empty_body(body_text):
            body_text = None

        start = time.time()
        response = await call_next(request)
        duration_ms = int((time.time() - start) * 1000)
        status_code = response.status_code

        from .service import is_excluded

        if is_excluded(path, method):
            return response

        # Capture error detail for 4xx/5xx
        response_summary = None
        if status_code >= 400:
            try:
                parts = []
                async for chunk in response.body_iterator:
                    parts.append(chunk if isinstance(chunk, bytes) else chunk.encode("utf-8"))
                body_bytes = b"".join(parts)

                async def gen():
                    yield body_bytes

                response.body_iterator = gen()

                try:
                    err = json.loads(body_bytes.decode("utf-8"))
                    detail = err.get("detail", "")
                    if isinstance(detail, (str, bytes)):
                        response_summary = str(detail)[:500]
                    else:
                        response_summary = json.dumps(detail)[:500]
                except (json.JSONDecodeError, UnicodeDecodeError):
                    response_summary = body_bytes.decode("utf-8", errors="replace")[:500]
            except Exception as e:
                logger.debug(f"Audit response capture failed: {e}")

        try:
            from core.database import async_session_maker

            from .models import AuditLog

            category = "read" if method == "GET" else "write"
            entry = AuditLog(
                username=username,
                method=method,
                path=path.split("?")[0],
                status_code=status_code,
                duration_ms=duration_ms,
                client_ip=client_ip,
                category=category,
                request_body=body_text,
                response_summary=response_summary,
            )
            async with async_session_maker() as session:
                session.add(entry)
                await session.commit()
        except Exception as e:
            logger.error(f"Audit persist failed: {e}")

        return response
