"""
Registration requests: enrollment without a token.

The instance sends its CSR and facts (POST /agent/register) and gets a
request id and a secret; it polls with the secret. An operator approves it
from Enrollment, giving the fields a token would have carried (name, group,
labels, external reference, or an existing instance to re-enroll), or
rejects it. The key fingerprint is printed by the instance's setup and shown
here, so the two can be compared before approving.

Limits: registration can be disabled or restricted to source networks
(settings), pending requests are capped and expire.
"""
import hashlib
import hmac
import json
import logging
import secrets
from datetime import datetime, timedelta
from typing import Optional

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from fastapi import HTTPException
from sqlalchemy import func, update
from sqlmodel import select

from core import secrets as data_secrets
from core.settings.router import get_system_settings

from manager import pki
from manager.models import EnrollmentRequest, Instance
from manager.netutil import ip_allowed
from manager.registration import RegistrationFields
from . import service

logger = logging.getLogger("madmin_manager.enrollment")

POLL_INTERVAL = 60
# The approved identity stays downloadable this long (an instance that
# crashed before saving it can fetch it again)
DELIVERY_WINDOW = timedelta(days=1)


def key_fingerprint(csr_pem: str) -> str:
    try:
        csr = x509.load_pem_x509_csr(csr_pem.encode())
    except ValueError:
        raise HTTPException(400, "CSR non valida")
    spki = csr.public_key().public_bytes(serialization.Encoding.DER,
                                         serialization.PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(spki).hexdigest()


async def create_request(session, csr: str, facts: dict, proto: int, source_ip: str,
                         ca_pinned: bool) -> dict:
    settings = await get_system_settings(session)
    if not settings.registration_enabled:
        raise HTTPException(403, "Registrazione senza token disattivata su questo manager")
    if not ip_allowed(source_ip, settings.registration_allowed_cidrs):
        raise HTTPException(403, "Registrazione non ammessa da questo indirizzo")
    pending = (await session.execute(select(func.count()).select_from(EnrollmentRequest)
                                     .where(EnrollmentRequest.status == "pending"))).scalar_one()
    if pending >= settings.registration_max_pending:
        raise HTTPException(503, "Troppe richieste in attesa: riprovare più tardi")
    fp = key_fingerprint(csr)
    # Checked now (proof the sender holds the key), signed at approval
    if not x509.load_pem_x509_csr(csr.encode()).is_signature_valid:
        raise HTTPException(400, "Firma della CSR non valida")
    facts_raw = json.dumps(facts)
    if len(facts_raw) > 64 * 1024:
        raise HTTPException(413, "Dati dell'istanza troppo grandi")

    # The same key asking again (setup re-run): the old request is replaced
    await session.execute(update(EnrollmentRequest).where(
        EnrollmentRequest.key_fingerprint == fp, EnrollmentRequest.status == "pending"
    ).values(status="expired"))
    secret = secrets.token_urlsafe(32)
    req = EnrollmentRequest(
        secret_hash=hashlib.sha256(secret.encode()).hexdigest(), csr=csr, key_fingerprint=fp,
        facts_json=facts_raw, protocol=proto, source_ip=source_ip[:45], ca_pinned=ca_pinned,
        expires_at=datetime.utcnow() + timedelta(days=settings.registration_ttl_days),
    )
    session.add(req)
    await session.commit()
    logger.info("Registration request %s from %s (%s), key %s",
                req.id, source_ip, facts.get("hostname"), fp[:16])
    from manager.notify import notify
    notify("registration", req.id, f"Richiesta di registrazione da {facts.get('hostname') or source_ip}",
           f"L'istanza {facts.get('hostname') or '?'} ({source_ip}) chiede di registrarsi.\n"
           f"Impronta della chiave: {fp}\nApprovarla o rifiutarla in Enrollment > In attesa, dopo aver "
           "verificato l'impronta sull'istanza.")
    return {"request_id": req.id, "request_secret": secret, "key_fingerprint": fp,
            "poll_interval": POLL_INTERVAL, "expires_at": req.expires_at.isoformat()}


async def poll_request(session, request_id: str, secret: str) -> Optional[dict]:
    req = await session.get(EnrollmentRequest, request_id)
    if req is None or not secret or not hmac.compare_digest(
            hashlib.sha256(secret.encode()).hexdigest(), req.secret_hash):
        return None
    if req.status == "pending" and req.expires_at <= datetime.utcnow():
        req.status = "expired"
        session.add(req)
        await session.commit()
    if req.status != "approved":
        return {"status": req.status, "poll_interval": POLL_INTERVAL}
    delivery_over = req.delivered_at is not None and datetime.utcnow() - req.delivered_at > DELIVERY_WINDOW
    if delivery_over or not req.cert_pem:
        return {"status": "expired"}
    instance = await session.get(Instance, req.instance_id)
    if instance is None or instance.status != "active":
        return {"status": "rejected"}
    if req.delivered_at is None:
        req.delivered_at = datetime.utcnow()
        session.add(req)
        await session.commit()
    return {
        "status": "approved",
        "instance_id": instance.id,
        "cert_pem": req.cert_pem,
        "ssh_ca_pub": pki.ssh_ca_public(),
        "license_pub": pki.license_public(),
        "backup_passphrase": data_secrets.decrypt(instance.backup_passphrase_enc),
    }


async def _pending(session, request_id: str) -> EnrollmentRequest:
    req = await session.get(EnrollmentRequest, request_id)
    if req is None:
        raise HTTPException(404, "Richiesta non trovata")
    if req.status != "pending":
        raise HTTPException(409, "Richiesta non più in attesa")
    if req.expires_at <= datetime.utcnow():
        req.status = "expired"
        session.add(req)
        await session.commit()
        raise HTTPException(409, "Richiesta scaduta")
    return req


async def approve(session, request_id: str, fields: RegistrationFields,
                  reenroll_instance_id: Optional[str], operator: str) -> Instance:
    req = await _pending(session, request_id)
    facts = json.loads(req.facts_json or "{}")
    instance = await service.target_instance(session, facts, fields, reenroll_instance_id)
    result = await service.issue_identity(session, instance, req.csr, facts, fields,
                                          req.source_ip, req.protocol)
    req.status = "approved"
    req.instance_id = instance.id
    req.cert_pem = result["cert_pem"]
    req.decided_by = operator[:100]
    req.decided_at = datetime.utcnow()
    session.add(req)
    await session.commit()
    logger.info("Registration request %s approved by %s as %s (%s)",
                req.id, operator, instance.name, instance.id)
    return instance


async def reject(session, request_id: str, operator: str) -> None:
    req = await _pending(session, request_id)
    req.status = "rejected"
    req.decided_by = operator[:100]
    req.decided_at = datetime.utcnow()
    session.add(req)
    await session.commit()


async def expire_old(session) -> None:
    await session.execute(update(EnrollmentRequest).where(
        EnrollmentRequest.status == "pending", EnrollmentRequest.expires_at <= datetime.utcnow()
    ).values(status="expired"))
    # Issued certificates are not kept once the delivery window is over
    await session.execute(update(EnrollmentRequest).where(
        EnrollmentRequest.status == "approved",
        EnrollmentRequest.decided_at <= datetime.utcnow() - DELIVERY_WINDOW - timedelta(days=1),
    ).values(cert_pem=None))
    await session.commit()
