"""
Agent authentication: the client certificate, verified by nginx.

nginx (agent server, :8443) verifies the certificate against the agent CA
(`ssl_verify_client optional`) and passes X-SSL-Client-Verify and the
certificate (X-SSL-Client-Cert, URL-escaped PEM). The UI server blanks both
headers and does not proxy /agent/, and the backend listens on 127.0.0.1
only, so the headers cannot be forged from outside.

The certificate must also be one we issued and did not revoke: one indexed
lookup by sha256 fingerprint (revocation is immediate, no CRL).
"""
from typing import Optional, Tuple
from urllib.parse import unquote

from sqlmodel import select
from starlette.requests import HTTPConnection

from manager import pki
from manager.models import AgentCertificate, Instance


async def authenticate(session, conn: HTTPConnection) -> Optional[Tuple[Instance, AgentCertificate]]:
    if conn.headers.get("x-ssl-client-verify") != "SUCCESS":
        return None
    raw = conn.headers.get("x-ssl-client-cert", "")
    if not raw:
        return None
    fp = pki.fingerprint_of(unquote(raw))
    if fp is None:
        return None
    row = (await session.execute(
        select(AgentCertificate, Instance)
        .join(Instance, Instance.id == AgentCertificate.instance_id)
        .where(AgentCertificate.fingerprint == fp)
    )).first()
    if row is None:
        return None
    cert, instance = row
    if cert.revoked or instance.status != "active":
        return None
    return instance, cert
