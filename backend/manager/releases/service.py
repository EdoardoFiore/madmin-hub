"""
MADMIN releases kept by the manager (DATA_DIR/releases/<release_id>.release).

A .release is an uncompressed tar of exactly three files: manifest.json,
manifest.json.sig (Ed25519 over the manifest bytes) and payload.tar.gz,
whose sha256 is in the manifest. The manager checks the shape, the payload
hash and, when release keys are configured in the settings, the signature,
so that garbage is refused at upload. It never unpacks the payload and
never signs anything: the instances verify every release with their own
keys before installing it.
"""
import hashlib
import json
import os
import re
import tarfile
from typing import List, Optional, Tuple

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from config import get_settings

MEMBERS = {"manifest.json", "manifest.json.sig", "payload.tar.gz"}
MAX_SIZE = 1024 ** 3
RELEASE_ID_RE = re.compile(r"^[0-9A-Za-z.+_-]{1,80}$")


class ReleaseError(ValueError):
    pass


def releases_dir() -> str:
    path = os.path.join(get_settings().data_dir, "releases")
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def release_path(release_id: str) -> str:
    if not RELEASE_ID_RE.match(release_id):
        raise ReleaseError("id di release non valido")
    return os.path.join(releases_dir(), f"{release_id}.release")


def load_keys(pem_text: str) -> List[Tuple[str, Ed25519PublicKey]]:
    """(key id, key) for every PEM block; key id = first 16 hex of the
    sha256 of the DER key, as printed by release-key.sh and sign-release.sh."""
    keys = []
    for block in re.findall(r"-----BEGIN PUBLIC KEY-----.+?-----END PUBLIC KEY-----", pem_text or "", re.S):
        key = serialization.load_pem_public_key(block.encode())
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError("Chiave di firma non Ed25519")
        der = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        keys.append((hashlib.sha256(der).hexdigest()[:16], key))
    if pem_text and pem_text.strip() and not keys:
        raise ValueError("Nessuna chiave PEM valida")
    return keys


def inspect(path: str, keys_pem: str) -> Tuple[dict, str]:
    """(manifest, key id that verified it, "" when no key is configured).
    Raises ReleaseError."""
    try:
        tar = tarfile.open(path, "r:")
    except tarfile.TarError:
        raise ReleaseError("non è un file .release (tar)")
    with tar:
        members = {}
        for m in tar.getmembers():
            if m.name not in MEMBERS or not m.isfile() or m.name in members:
                raise ReleaseError(f"contenuto inatteso nel file: {m.name!r}")
            members[m.name] = m
        if set(members) != MEMBERS:
            raise ReleaseError("file incompleto: servono manifest.json, manifest.json.sig e payload.tar.gz "
                               "(una release non firmata non si carica)")
        if members["manifest.json"].size > 1 << 20 or members["manifest.json.sig"].size > 1024:
            raise ReleaseError("manifest o firma troppo grandi")
        raw = tar.extractfile(members["manifest.json"]).read()
        sig = tar.extractfile(members["manifest.json.sig"]).read()
        try:
            manifest = json.loads(raw)
        except ValueError:
            raise ReleaseError("manifest.json non leggibile")
        if not isinstance(manifest, dict) or manifest.get("format") != 1:
            raise ReleaseError("formato del manifest non supportato")
        for field in ("release_id", "version", "build", "payload_sha256", "os", "layout"):
            if field not in manifest:
                raise ReleaseError(f"manifest senza {field}")
        if not RELEASE_ID_RE.match(str(manifest["release_id"])):
            raise ReleaseError("release_id non valido nel manifest")
        h = hashlib.sha256()
        src = tar.extractfile(members["payload.tar.gz"])
        for chunk in iter(lambda: src.read(1 << 20), b""):
            h.update(chunk)
        if h.hexdigest() != manifest["payload_sha256"]:
            raise ReleaseError("il payload non corrisponde al manifest")
    signed_by = ""
    keys = load_keys(keys_pem)
    if keys:
        for key_id, key in keys:
            try:
                key.verify(sig, raw)
                signed_by = key_id
                break
            except InvalidSignature:
                continue
        else:
            raise ReleaseError("firma non valida per nessuna delle chiavi configurate")
    return manifest, signed_by


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest_summary(manifest_json: str) -> dict:
    try:
        m = json.loads(manifest_json or "{}")
    except ValueError:
        return {}
    return {k: m.get(k) for k in ("created", "min_from", "os", "layout", "schema", "modules", "apt")}


def remove_file(release_id: str) -> None:
    try:
        os.unlink(release_path(release_id))
    except (FileNotFoundError, ReleaseError):
        pass


def stored(release_id: str) -> Optional[str]:
    path = release_path(release_id)
    return path if os.path.exists(path) else None
