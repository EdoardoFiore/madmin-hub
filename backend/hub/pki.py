"""
Hub key material, in DATA_DIR/pki/ (0700, files 0600):

    ca.pem / ca.key.enc            X.509 CA of the agents (ECDSA P-256, 10 years).
                                   Signs the client certificates (CN = instance_id)
                                   and the server certificate of the agent endpoint.
    server.pem / server.key        certificate of the agent endpoint (nginx :8443),
                                   chain included. The key is in clear: nginx reads it.
    ssh_ca.pub / ssh_ca.key.enc    OpenSSH user CA (Ed25519) for support SSH.
    license.pub / license.key.enc  Ed25519 key that signs module licenses.

Private keys other than the server's are encrypted with the data key derived
from SECRET_KEY (core.secrets). The sha256 of ca.pem goes into every
enrollment token: instances pin it on first contact.

    python -m hub.pki init --host hub.example.com [--ip 10.0.0.5] [--force]
    python -m hub.pki server-cert --host ... [--ip ...]   (re-issue, same CA)
    python -m hub.pki fingerprint
"""
import base64
import hashlib
import ipaddress
import json
import os
import secrets as pysecrets
import tempfile
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import List, Optional, Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from config import get_settings
from core import secrets as data_secrets

AGENT_CERT_DAYS = 90
SERVER_CERT_DAYS = 825
CA_DAYS = 3650


class PKIError(Exception):
    pass


def pki_dir() -> str:
    return os.path.join(get_settings().data_dir, "pki")


def _path(name: str) -> str:
    return os.path.join(pki_dir(), name)


def _write(name: str, data: bytes) -> None:
    os.makedirs(pki_dir(), mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=pki_dir(), prefix=f".{name}.")
    with os.fdopen(fd, "wb") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(data)
    os.replace(tmp, _path(name))


def _read(name: str) -> bytes:
    try:
        with open(_path(name), "rb") as f:
            return f.read()
    except FileNotFoundError:
        raise PKIError(f"{name} assente: eseguire 'python -m hub.pki init'")


def _write_secret(name: str, pem: bytes) -> None:
    _write(name, data_secrets.encrypt(pem.decode()).encode())


def _read_secret(name: str) -> bytes:
    try:
        return data_secrets.decrypt(_read(name).decode()).encode()
    except ValueError:
        raise PKIError(f"{name} non decifrabile con lo SECRET_KEY attuale")


def _pem_key(key) -> bytes:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


def _serial() -> int:
    return x509.random_serial_number()


# --- Loading (cached: the files change only through this module) ---

@lru_cache()
def _ca() -> Tuple[x509.Certificate, ec.EllipticCurvePrivateKey]:
    cert = x509.load_pem_x509_certificate(_read("ca.pem"))
    key = serialization.load_pem_private_key(_read_secret("ca.key.enc"), password=None)
    return cert, key


@lru_cache()
def _ssh_ca() -> ed25519.Ed25519PrivateKey:
    return serialization.load_pem_private_key(_read_secret("ssh_ca.key.enc"), password=None)


@lru_cache()
def _license_key() -> ed25519.Ed25519PrivateKey:
    return serialization.load_pem_private_key(_read_secret("license.key.enc"), password=None)


def _clear_cache() -> None:
    _ca.cache_clear()
    _ssh_ca.cache_clear()
    _license_key.cache_clear()


def ca_pem() -> bytes:
    return _read("ca.pem")


def ca_fingerprint() -> str:
    cert = x509.load_pem_x509_certificate(ca_pem())
    return hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()


def ssh_ca_public() -> str:
    return _read("ssh_ca.pub").decode().strip()


def license_public() -> str:
    return _read("license.pub").decode().strip()


def is_initialized() -> bool:
    return all(os.path.exists(_path(n)) for n in ("ca.pem", "ca.key.enc", "server.pem", "ssh_ca.key.enc", "license.key.enc"))


# --- Initialization ---

def init(hosts: List[str], ips: List[str], force: bool = False) -> None:
    if is_initialized() and not force:
        raise PKIError("PKI già inizializzata (--force per rigenerarla: invalida TUTTE le istanze)")
    now = datetime.now(timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "MADMIN Hub"),
        x509.NameAttribute(NameOID.COMMON_NAME, f"MADMIN Hub Agent CA {pysecrets.token_hex(4)}"),
    ])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(ca_key.public_key())
        .serial_number(_serial())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False,
            key_encipherment=False, data_encipherment=False, key_agreement=False,
            encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    _write("ca.pem", ca_cert.public_bytes(serialization.Encoding.PEM))
    _write_secret("ca.key.enc", _pem_key(ca_key))

    ssh_key = ed25519.Ed25519PrivateKey.generate()
    _write_secret("ssh_ca.key.enc", _pem_key(ssh_key))
    _write("ssh_ca.pub", ssh_key.public_key().public_bytes(
        serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH) + b" madmin-hub-support-ca\n")

    lic_key = ed25519.Ed25519PrivateKey.generate()
    _write_secret("license.key.enc", _pem_key(lic_key))
    _write("license.pub", base64.b64encode(lic_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)) + b"\n")

    _clear_cache()
    issue_server_cert(hosts, ips)


def issue_server_cert(hosts: List[str], ips: List[str]) -> None:
    if not hosts and not ips:
        raise PKIError("Serve almeno un hostname o un IP per il certificato del server")
    # An address passed as --host must still be an IP SAN: TLS clients match an
    # IP only against IP SANs, so a DNS SAN "10.0.0.5" fails verification.
    names, addrs = [], []
    for value in list(hosts) + list(ips):
        try:
            addr = ipaddress.ip_address(value)
        except ValueError:
            if value in ips:
                raise PKIError(f"IP non valido: {value}")
            names.append(value)
        else:
            if addr not in addrs:
                addrs.append(addr)
    ca_cert, ca_key = _ca()
    now = datetime.now(timezone.utc)
    key = ec.generate_private_key(ec.SECP256R1())
    sans = [x509.DNSName(h) for h in names] + [x509.IPAddress(a) for a in addrs]
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, (hosts or ips)[0])]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(_serial())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=SERVER_CERT_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    _write("server.key", _pem_key(key))
    _write("server.pem", cert.public_bytes(serialization.Encoding.PEM) + ca_cert.public_bytes(serialization.Encoding.PEM))
    _write("server.json", json.dumps({"hosts": hosts, "ips": ips}).encode())


# --- Agent certificates ---

def sign_agent_csr(csr_pem: str, instance_id: str) -> Tuple[bytes, str, str, datetime, datetime]:
    """(cert PEM, sha256 fingerprint, serial hex, not_before, not_after)."""
    try:
        csr = x509.load_pem_x509_csr(csr_pem.encode())
    except ValueError:
        raise PKIError("CSR non valida")
    if not csr.is_signature_valid:
        raise PKIError("Firma della CSR non valida")
    pub = csr.public_key()
    if not isinstance(pub, ec.EllipticCurvePublicKey) or pub.curve.name not in ("secp256r1", "secp384r1"):
        raise PKIError("Chiave della CSR non supportata (attesa ECDSA P-256/P-384)")
    ca_cert, ca_key = _ca()
    now = datetime.now(timezone.utc)
    serial = _serial()
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, instance_id)]))
        .issuer_name(ca_cert.subject)
        .public_key(pub)
        .serial_number(serial)
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=AGENT_CERT_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, key_cert_sign=False, crl_sign=False, content_commitment=False,
            key_encipherment=False, data_encipherment=False, key_agreement=False,
            encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    der = cert.public_bytes(serialization.Encoding.DER)
    return (cert.public_bytes(serialization.Encoding.PEM), hashlib.sha256(der).hexdigest(),
            format(serial, "x"), cert.not_valid_before_utc, cert.not_valid_after_utc)


def fingerprint_of(cert_pem: str) -> Optional[str]:
    try:
        cert = x509.load_pem_x509_certificate(cert_pem.encode())
    except ValueError:
        return None
    return hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()


# --- SSH user certificates ---

_SSH_KEY_TYPES = ("ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa")


def load_ssh_public_key(public_key_line: str):
    """The key of an OpenSSH public key line (one line, accepted types only)."""
    line = public_key_line.strip()
    if "\n" in line or "\r" in line or not line.startswith(_SSH_KEY_TYPES):
        raise PKIError("Chiave pubblica SSH non valida")
    try:
        pub = serialization.load_ssh_public_key(" ".join(line.split()[:2]).encode())
    except (ValueError, TypeError):
        raise PKIError("Chiave pubblica SSH non valida")
    from cryptography.hazmat.primitives.asymmetric import rsa
    if isinstance(pub, rsa.RSAPublicKey) and pub.key_size < 3072:
        raise PKIError("Chiave RSA troppo corta (minimo 3072 bit)")
    return pub


def sign_ssh_user_cert(public_key_line: str, principal: str, key_id: str,
                       valid_before: datetime) -> str:
    """OpenSSH user certificate for `principal`, usable only from 127.0.0.1
    (the tunnel end on the instance) and only until valid_before."""
    pub = load_ssh_public_key(public_key_line)
    now = datetime.now(timezone.utc)
    cert = (
        serialization.SSHCertificateBuilder()
        .public_key(pub)
        .serial(int.from_bytes(os.urandom(8), "big"))
        .type(serialization.SSHCertificateType.USER)
        .key_id(key_id.encode()[:200])
        .valid_principals([principal.encode()])
        .valid_after(int((now - timedelta(minutes=2)).timestamp()))
        .valid_before(int(valid_before.timestamp()))
        .add_critical_option(b"source-address", b"127.0.0.1")
        .add_extension(b"permit-pty", b"")
        .add_extension(b"permit-port-forwarding", b"")
        .sign(_ssh_ca())
    )
    return cert.public_bytes().decode()


# --- Licenses ---

def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign_license(payload: dict) -> str:
    """<base64url(payload)>.<base64url(ed25519 signature of the first part)>"""
    body = _b64u(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    return body + "." + _b64u(_license_key().sign(body.encode()))


def _main() -> None:
    import argparse
    import sys
    parser = argparse.ArgumentParser(prog="python -m hub.pki")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("init", "server-cert"):
        p = sub.add_parser(name)
        p.add_argument("--host", action="append", default=[])
        p.add_argument("--ip", action="append", default=[])
        if name == "init":
            p.add_argument("--force", action="store_true")
    sub.add_parser("fingerprint")
    args = parser.parse_args()
    try:
        if args.cmd == "init":
            init(args.host, args.ip, force=args.force)
            print(f"PKI inizializzata. Fingerprint CA: {ca_fingerprint()}")
        elif args.cmd == "server-cert":
            issue_server_cert(args.host, args.ip)
            print("Certificato server rigenerato: ricaricare nginx")
        else:
            print(ca_fingerprint())
    except PKIError as e:
        sys.exit(f"ERRORE: {e}")


if __name__ == "__main__":
    _main()
