"""
Enrollment: tokens, and the issuing of an instance identity shared by the
two ways in (token, or approved registration request).
"""
import base64
import hashlib
import json
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import HTTPException

from core import secrets as data_secrets
from core.settings.router import get_system_settings

from hub import pki
from hub.agents import protocol
from hub.agents.registry import registry
from hub.instances.service import apply_facts, record_addresses, revoke_certificates
from hub.models import AgentCertificate, EnrollmentToken, Instance
from hub.registration import RegistrationFields, apply, instance_by_ref

TOKEN_PREFIX = "MHUB1-"


def encode_token(agent_url: str, token_id: str, secret: str) -> str:
    body = json.dumps({"u": agent_url, "f": pki.ca_fingerprint(), "i": token_id, "s": secret},
                      separators=(",", ":"))
    return TOKEN_PREFIX + base64.urlsafe_b64encode(body.encode()).rstrip(b"=").decode()


async def create_token(session, created_by: str, description: str, hours: int,
                       max_uses: Optional[int], fields: Optional[RegistrationFields] = None,
                       reenroll_instance_id: Optional[str] = None,
                       bind_ip: Optional[str] = None) -> dict:
    agent_url = (await get_system_settings(session)).agent_url
    if not agent_url:
        raise HTTPException(400, "Configurare prima l'URL agent nelle impostazioni della hub")
    fields = fields or RegistrationFields()
    token_id = secrets.token_hex(8)
    secret = secrets.token_urlsafe(32)
    row = EnrollmentToken(
        id=token_id, secret_hash=hashlib.sha256(secret.encode()).hexdigest(),
        description=description, created_by=created_by[:100],
        expires_at=datetime.utcnow() + timedelta(hours=hours), max_uses=max_uses,
        group_id=fields.group_id, reenroll_instance_id=reenroll_instance_id,
        name=fields.name or "", labels_json=json.dumps(fields.labels),
        external_ref=fields.external_ref, bind_ip=bind_ip,
    )
    session.add(row)
    await session.commit()
    return {
        "token": encode_token(agent_url, token_id, secret),
        "token_id": token_id,
        "expires_at": row.expires_at.isoformat(),
        "ca_fingerprint": pki.ca_fingerprint(),
        "reenroll_instance_id": reenroll_instance_id,
    }


def token_fields(token: EnrollmentToken) -> RegistrationFields:
    return RegistrationFields(
        name=token.name or None, group_id=token.group_id,
        labels=json.loads(token.labels_json or "{}"), external_ref=token.external_ref,
    )


def _new_passphrase() -> str:
    return secrets.token_urlsafe(32)


async def target_instance(session, facts: dict, fields: RegistrationFields,
                          reenroll_instance_id: Optional[str]) -> Instance:
    """The instance an enrollment is for: an existing one (re-enroll, or the
    same external reference), else a new one."""
    instance = None
    if reenroll_instance_id:
        instance = await session.get(Instance, reenroll_instance_id)
        if instance is None or instance.status == "revoked":
            raise HTTPException(409, "Istanza da registrare di nuovo non trovata o revocata")
    elif fields.external_ref:
        instance = await instance_by_ref(session, fields.external_ref)
    if instance is not None:
        # Same identity, new certificate: the old ones stop working now
        await revoke_certificates(session, instance.id)
        await registry.disconnect(instance.id, protocol.CLOSE_SUPERSEDED, "re-enrolled")
        instance.status = "active"
        instance.enrolled_at = datetime.utcnow()
        return instance
    instance = Instance(
        name=str(facts.get("hostname") or "madmin")[:100],
        backup_passphrase_enc=data_secrets.encrypt(_new_passphrase()),
    )
    session.add(instance)
    await session.flush()
    return instance


async def issue_identity(session, instance: Instance, csr_pem: str, facts: dict,
                         fields: RegistrationFields, source_ip: str, proto: int) -> dict:
    """Certificate + what the instance needs; the caller commits."""
    try:
        cert_pem, fp, serial, nb, na = pki.sign_agent_csr(csr_pem, instance.id)
    except pki.PKIError as e:
        raise HTTPException(400, str(e))
    session.add(AgentCertificate(instance_id=instance.id, fingerprint=fp, serial=serial,
                                 not_before=nb.replace(tzinfo=None), not_after=na.replace(tzinfo=None)))
    if not instance.backup_passphrase_enc:
        instance.backup_passphrase_enc = data_secrets.encrypt(_new_passphrase())
    apply_facts(instance, facts)
    await apply(session, instance, fields)
    instance.protocol = proto
    await record_addresses(session, instance, source_ip, facts)
    session.add(instance)
    return {
        "instance_id": instance.id,
        "cert_pem": cert_pem.decode(),
        "ssh_ca_pub": pki.ssh_ca_public(),
        "license_pub": pki.license_public(),
        "backup_passphrase": data_secrets.decrypt(instance.backup_passphrase_enc),
    }
