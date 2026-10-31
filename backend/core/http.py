"""
MADMIN HTTP Helpers

Shared request-level utilities. Kept out of any one subsystem so that audit
logging and rate limiting agree on who the caller is.
"""
from starlette.requests import Request


def get_client_ip(request: Request) -> str:
    """
    Real client IP behind the Nginx reverse proxy.

    Nginx sets X-Real-IP (and X-Forwarded-For) on every proxied request, while
    uvicorn listens on 127.0.0.1 only — so request.client.host is the proxy, not
    the caller. Reading it directly makes every request look like it came from
    127.0.0.1, which turns per-IP rate limiting into a single shared bucket that
    any unauthenticated caller can fill to lock out the whole instance.

    The headers cannot be spoofed from outside: Nginx overwrites X-Real-IP, and
    nothing else can reach the backend socket.

    Falls back to request.client.host for direct connections (development).
    """
    return (
        request.headers.get("x-real-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "unknown")
    )
