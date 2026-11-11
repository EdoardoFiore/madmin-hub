"""
MADMIN Manager Audit Log Middleware

Starlette middleware that intercepts API requests and logs:
- Who (username from JWT)
- What (method + path)
- Result (status code + duration)
- Where from (client IP)
- Request payload (sanitized, with privacy-sensitive fields masked)
- Response error detail (for 4xx/5xx)

Non-excluded paths are persisted to the audit_log database table.
Journal logging is kept to DEBUG level to avoid polluting journalctl.
"""
import re
import time
import json
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
import jwt

from config import get_settings
from core.http import get_client_ip

logger = logging.getLogger("madmin.audit")

# JWT algorithm (same as core.auth.service)
ALGORITHM = "HS256"

# --- Privacy Sanitization ---
# Fields whose values should be masked in audit logs.
# Uses substring matching on key names (case-insensitive).
SENSITIVE_KEY_PATTERNS = [
    "password",
    "secret",
    "token",
    "key",           # catches private_key, preshared_key, api_key, etc.
    "psk",
    "passphrase",
    "credential",
    "ta_key",
    "tls_auth",
    "cert_data",
    "ticket",
    "csr",
]

# Matched on the whole key: as substrings they would mask unrelated fields
# (country_code, status_code). TOTP and backup codes travel under these.
SENSITIVE_EXACT_KEYS = {"code", "otp", "totp", "backup_code", "backup_codes"}

MASK_VALUE = "***"

# The token in a public config-download link is the credential itself
# (it hands out a VPN profile with its private key): never store it.
_DOWNLOAD_TOKEN_RE = re.compile(r'^(/api/modules/[^/]+/download/)[^/]+')

# Unauthenticated requests are recorded without their payload (only the
# login form, masked, is kept: failed logins are worth auditing)
_ANONYMOUS_BODY_PATHS = ("/api/auth/token",)


def redact_path(path: str) -> str:
    """The request path as stored in the audit log."""
    return _DOWNLOAD_TOKEN_RE.sub(r'\1***', path)


def _sanitize_value(key: str, value) -> object:
    """
    Mask the value if the key matches any sensitive pattern.
    Recurse into dicts and lists.
    """
    if isinstance(value, dict):
        return _sanitize_dict(value)
    if isinstance(value, list):
        return [_sanitize_value(key, item) for item in value]
    if isinstance(key, str):
        key_lower = key.lower()
        if key_lower in SENSITIVE_EXACT_KEYS:
            return MASK_VALUE
        for pattern in SENSITIVE_KEY_PATTERNS:
            if pattern in key_lower:
                return MASK_VALUE
    return value


def _sanitize_dict(d: dict) -> dict:
    """Recursively sanitize all sensitive fields in a dictionary."""
    return {k: _sanitize_value(k, v) for k, v in d.items()}


def _extract_username(request: Request) -> str:
    """
    Extract username from JWT Bearer token without hitting the database.

    Returns 'anonymous' if no token or token is invalid.
    """
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        return "anonymous"

    token = auth_header[7:]  # Strip "Bearer "
    # Provisioning API key (manager.apikeys): the id, never the secret
    if token.startswith("mhk_"):
        return f"api:{token[4:].split('_', 1)[0][:16]}"

    try:
        settings = get_settings()
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        return payload.get("sub", "anonymous")
    except jwt.PyJWTError:
        return "anonymous"


def _get_client_ip(request: Request) -> str:
    """Get the real client IP from proxy headers (see core.http.get_client_ip)."""
    return get_client_ip(request)


def _is_empty_body(text: str | None) -> bool:
    """Check if a body string is empty or contains only an empty JSON object/array."""
    if not text:
        return True
    stripped = text.strip()
    return stripped in ("", "{}", "[]", "null")


def _extract_path_context(path: str, method: str) -> str | None:
    """
    For requests without a body (especially DELETE), extract meaningful
    context from path parameters.

    Example: /api/auth/users/admin → {"_path_context": "admin", "_resource": "users"}
    """
    if method not in ("DELETE", "POST", "PUT", "PATCH"):
        return None

    # Split path into segments, removing empty strings
    segments = [s for s in path.split("/") if s and s != "api"]
    if len(segments) < 2:
        return None

    # The last segment is typically the resource ID/name
    resource_id = segments[-1]
    resource_type = segments[-2] if len(segments) >= 2 else None

    # Don't extract if the last segment looks like an action verb
    action_keywords = {"activate", "deactivate", "restart", "start", "stop",
                       "enable", "disable", "apply", "test", "export", "import",
                       "run", "setup", "cleanup", "renew", "download", "status",
                       "config", "widgets", "traffic"}
    if resource_id.lower() in action_keywords:
        return None

    context = {"_path_context": resource_id}
    if resource_type:
        context["_resource"] = resource_type

    return json.dumps(context)


def _extract_query_params(request: Request) -> str | None:
    """
    Extract query parameters as JSON for GET requests.
    Filters out common pagination params to reduce noise.
    """
    params = dict(request.query_params)
    if not params:
        return None

    # Remove pagination/noise params
    noise_keys = {"page", "per_page", "limit", "offset", "_"}
    filtered = {k: v for k, v in params.items() if k not in noise_keys}
    if not filtered:
        return None

    return json.dumps({"_query_params": filtered})


class AuditLogMiddleware(BaseHTTPMiddleware):
    """
    Middleware that logs API calls with user identity and payload.

    - Persists non-excluded paths to the audit_log DB table
    - Captures, sanitizes and logs the JSON request body for write operations
    - Captures query params for GET requests
    - Extracts path context for DELETE requests without body
    - Captures response error details for 4xx/5xx
    - Masks privacy-sensitive fields (passwords, keys, PSKs, etc.)
    - Journal logging kept to DEBUG to avoid noise
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        # Only intercept /api/ routes
        path = request.url.path
        if not path.startswith("/api/"):
            return await call_next(request)

        method = request.method
        username = _extract_username(request)
        client_ip = _get_client_ip(request)

        # --- Body Extraction (only for writes) ---
        body_text = None
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            content_type = request.headers.get("content-type", "")

            # Skip forms/file uploads to save memory and avoid logging binary data
            if "multipart/form-data" not in content_type:
                try:
                    # Read the body
                    body_bytes = await request.body()

                    # No need to put the body back: BaseHTTPMiddleware caches
                    # what body() read and hands it to the route itself, then
                    # passes on only http.disconnect. Replacing receive() with
                    # one returning the body made every streaming response
                    # fail ("Unexpected message received: http.request") when
                    # it listened for the client leaving.

                    if body_bytes:
                        # Truncate if too large (> 50KB) to prevent blowing up DB
                        if len(body_bytes) > 50000:
                            body_text = "<Payload troppo grande per il log>"
                        else:
                            text = body_bytes.decode("utf-8")
                            # Parse and sanitize JSON
                            if "application/json" in content_type:
                                try:
                                    data = json.loads(text)
                                    if isinstance(data, dict):
                                        data = _sanitize_dict(data)
                                        body_text = json.dumps(data)
                                    elif isinstance(data, list):
                                        body_text = json.dumps([
                                            _sanitize_dict(item) if isinstance(item, dict) else item
                                            for item in data
                                        ])
                                    else:
                                        body_text = json.dumps(data)
                                except json.JSONDecodeError:
                                    # Unparsed text cannot be masked: its size only
                                    body_text = f"<JSON non valido, {len(body_bytes)} byte>"
                            elif "application/x-www-form-urlencoded" in content_type:
                                # Parse form data (e.g. OAuth2 login: username=x&password=y)
                                from urllib.parse import parse_qs
                                try:
                                    form_data = parse_qs(text, keep_blank_values=True)
                                    # parse_qs returns lists, flatten single values
                                    flat = {k: v[0] if len(v) == 1 else v for k, v in form_data.items()}
                                    flat = _sanitize_dict(flat)
                                    body_text = json.dumps(flat)
                                except Exception:
                                    body_text = "<Form data non parsabile>"
                            else:
                                body_text = f"<payload {content_type or 'senza content-type'}, {len(body_bytes)} byte>"
                except Exception as e:
                    logger.warning(f"Failed to read/sanitize request body: {e}")
                    body_text = "<Errore lettura payload>"

        # Filter out empty/meaningless bodies
        if _is_empty_body(body_text):
            body_text = None

        # For requests without body, try to extract context from path
        if body_text is None and method in ("DELETE", "POST", "PUT", "PATCH"):
            body_text = _extract_path_context(path, method)

        # For GET requests, capture meaningful query params
        if method == "GET":
            body_text = _extract_query_params(request)

        # Anyone can send requests: an anonymous payload is not stored (it
        # filled the table with up to 50 KB per request, unauthenticated)
        if username == "anonymous" and not path.startswith(_ANONYMOUS_BODY_PATHS):
            body_text = None

        # Time the request
        start_time = time.time()
        response = await call_next(request)
        duration_ms = int((time.time() - start_time) * 1000)

        status_code = response.status_code

        from .service import is_excluded

        # Anonymous requests to routes that do not exist are scanner noise
        excluded = is_excluded(path, method) or (username == "anonymous" and status_code in (404, 405))

        # Only persist to DB if not excluded
        if not excluded:
            # Capture response error detail for 4xx/5xx
            response_summary = None
            if status_code >= 400:
                try:
                    # Read response body to capture error detail
                    response_body_parts = []
                    async for chunk in response.body_iterator:
                        if isinstance(chunk, bytes):
                            response_body_parts.append(chunk)
                        else:
                            response_body_parts.append(chunk.encode("utf-8"))
                    
                    response_bytes = b"".join(response_body_parts)
                    
                    # Rebuild the response iterator so the client still receives the data
                    async def response_body_gen():
                        yield response_bytes
                    response.body_iterator = response_body_gen()
                    
                    # Parse error detail
                    try:
                        error_data = json.loads(response_bytes.decode("utf-8"))
                        detail = error_data.get("detail", "")
                        if isinstance(detail, str):
                            response_summary = detail[:500]
                        elif isinstance(detail, list):
                            # Validation errors come as list
                            response_summary = json.dumps(detail)[:500]
                        else:
                            response_summary = str(detail)[:500]
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        response_summary = response_bytes.decode("utf-8", errors="replace")[:500]
                except Exception as e:
                    logger.debug(f"Failed to capture response error detail: {e}")

            # DEBUG log only — no more AUDIT noise in journal
            logger.debug(
                f"AUDIT | user={username} | {method} {redact_path(path)} | {status_code} | {duration_ms}ms | ip={client_ip}"
            )

            try:
                from .models import AuditLog
                from .writer import audit_writer

                category = "read" if method == "GET" else "write"

                # Strip query params and download tokens from the stored path
                clean_path = redact_path(path.split("?")[0])

                # Clipped to the column sizes: anyone can send a 2 KB path to an
                # existing route (401, logged), and one value too long fails
                # the insert of the whole batch it is written with
                clean_path = clean_path[:500]
                audit_entry = AuditLog(
                    username=str(username)[:100],
                    method=method[:10],
                    path=clean_path,
                    status_code=status_code,
                    duration_ms=duration_ms,
                    client_ip=client_ip[:45],
                    category=category,
                    request_body=body_text,
                    response_summary=response_summary,
                )

                # Written in batches by a background task (see writer.py)
                audit_writer.submit(audit_entry)

            except Exception as e:
                # Never let audit logging break the actual request
                logger.error(f"Failed to queue audit log: {e}")

        return response