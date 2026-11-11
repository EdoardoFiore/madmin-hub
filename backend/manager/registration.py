"""
Fields a registration may carry (from the token, or given at approval), all
optional: name, group, labels, external reference. Applied to the instance
when it enrolls.
"""
import json
import re
from typing import Dict, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import select

from manager.models import Instance, InstanceGroup

_LABEL_KEY = re.compile(r"^[a-z0-9_.-]{1,40}$")
MAX_LABELS = 20


def check_labels(labels: Optional[Dict[str, str]]) -> Dict[str, str]:
    labels = labels or {}
    if not isinstance(labels, dict) or len(labels) > MAX_LABELS:
        raise ValueError(f"Al massimo {MAX_LABELS} etichette")
    out = {}
    for k, v in labels.items():
        k = str(k).strip().lower()
        if not _LABEL_KEY.match(k):
            raise ValueError(f"Chiave etichetta non valida: {k!r} (minuscole, cifre, . _ -)")
        v = str(v).strip()
        if len(v) > 200 or any(ord(c) < 32 for c in v):
            raise ValueError(f"Valore etichetta non valido per {k}")
        out[k] = v
    return out


def check_external_ref(v: Optional[str]) -> Optional[str]:
    v = (v or "").strip()
    if not v:
        return None
    if len(v) > 100 or any(ord(c) < 32 for c in v):
        raise ValueError("Riferimento esterno non valido")
    return v


class RegistrationFields(BaseModel):
    """What a token (or an approval) can set on the instance."""
    name: Optional[str] = Field(default=None, max_length=100)
    group_id: Optional[str] = Field(default=None, max_length=36)
    labels: Dict[str, str] = Field(default_factory=dict)
    external_ref: Optional[str] = None

    @field_validator("labels")
    @classmethod
    def _labels(cls, v):
        return check_labels(v)

    @field_validator("external_ref")
    @classmethod
    def _ref(cls, v):
        return check_external_ref(v)

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        v = (v or "").strip()
        return v or None


async def check_group(session, group_id: Optional[str]) -> None:
    if group_id and await session.get(InstanceGroup, group_id) is None:
        raise HTTPException(400, "Gruppo inesistente")


async def instance_by_ref(session, external_ref: str) -> Optional[Instance]:
    """The live instance with this reference (a revoked one does not count)."""
    return (await session.execute(select(Instance).where(
        Instance.external_ref == external_ref, Instance.status != "revoked",
    ))).scalars().first()


async def apply(session, instance: Instance, fields: RegistrationFields) -> None:
    """Set the given fields; those left empty keep the instance's value."""
    if fields.name:
        instance.name = fields.name
    if fields.group_id:
        instance.group_id = fields.group_id
    if fields.labels:
        current = json.loads(instance.labels_json or "{}")
        current.update(fields.labels)
        instance.labels_json = json.dumps(current)
    if fields.external_ref and fields.external_ref != instance.external_ref:
        other = await instance_by_ref(session, fields.external_ref)
        if other is not None and other.id != instance.id:
            raise HTTPException(409, f"Riferimento esterno già usato dall'istanza {other.name}")
        instance.external_ref = fields.external_ref
