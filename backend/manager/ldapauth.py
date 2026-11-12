"""
LDAP / Active Directory users (ROADMAP 10.3).

A login with a username that is not a local user is checked against the
directory: the service account finds the user's entry (ldap_user_filter
under ldap_base_dn), a bind as that entry checks the password, the user's
groups (memberOf, or the groupOfNames / groupOfUniqueNames that list it)
pick the first matching mapping, which gives role, access and manager
group. The user is created (auth_source "ldap") at the first login and
updated at every login; without a matching mapping the login is refused.

- The connection is always encrypted: ldaps://, or ldap:// with StartTLS;
  the directory's certificate is verified (ldap_ca_pem, or the system CAs).
- An empty password is refused before any bind (an empty bind is anonymous).
- A local username is never looked up in LDAP: an LDAP account with the name
  of a local superuser cannot take it over, and local superusers always work.
- TOTP is enforced by the manager for LDAP users too (totp_enforced).
- sync_task re-reads every LDAP user every SYNC_INTERVAL: removed from the
  directory or from every mapped group, the user is disabled and its
  sessions revoked; a changed mapping updates role/access/group, revokes the
  sessions and sends the SSH keys back to approval.
"""
import asyncio
import json
import logging
import secrets
import ssl
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlmodel import select

logger = logging.getLogger("madmin_manager.ldap")

SYNC_INTERVAL = 900
ROLES = ("superuser", "partner", "customer")


class LdapError(Exception):
    pass


def parse_mappings(raw: str) -> List[dict]:
    try:
        items = json.loads(raw or "[]")
    except ValueError:
        raise ValueError("Mappature LDAP: JSON non valido")
    if not isinstance(items, list):
        raise ValueError("Mappature LDAP: una lista di oggetti")
    out = []
    for m in items:
        if not isinstance(m, dict) or not str(m.get("group", "")).strip():
            raise ValueError("Mappatura LDAP senza 'group' (DN del gruppo)")
        if m.get("role") not in ROLES or m.get("access") not in ("rw", "ro"):
            raise ValueError(f"Mappatura {m.get('group')}: role {ROLES}, access rw|ro")
        if m["role"] != "superuser" and not m.get("group_id"):
            raise ValueError(f"Mappatura {m.get('group')}: group_id obbligatorio per {m['role']}")
        out.append({"group": str(m["group"]).strip().lower(), "role": m["role"], "access": m["access"],
                    "group_id": m.get("group_id") if m["role"] != "superuser" else None})
    return out


def _server(settings):
    from ldap3 import Server, Tls
    tls = Tls(validate=ssl.CERT_REQUIRED, version=ssl.PROTOCOL_TLS_CLIENT,
              ca_certs_data=settings.ldap_ca_pem or None)
    return Server(settings.ldap_url, use_ssl=settings.ldap_url.startswith("ldaps://"), tls=tls,
                  connect_timeout=10, get_info=None)


def _connect(settings, user: str, password: str):
    """An authenticated, encrypted connection, or LdapError."""
    from ldap3 import Connection
    from ldap3.core.exceptions import LDAPException
    if not password:
        raise LdapError("password vuota")
    try:
        conn = Connection(_server(settings), user=user, password=password, receive_timeout=15, raise_exceptions=False)
        conn.open()
        if not settings.ldap_url.startswith("ldaps://"):
            if not conn.start_tls():
                raise LdapError(f"StartTLS non riuscito: {conn.result.get('description')}")
        if not conn.bind():
            raise LdapError(f"bind rifiutato ({conn.result.get('description')})")
        return conn
    except LDAPException as e:
        raise LdapError(str(e)[:300])


def _service(settings):
    from core.secrets import decrypt_setting
    password = decrypt_setting(settings.ldap_bind_password) if settings.ldap_bind_password else ""
    return _connect(settings, settings.ldap_bind_dn, password)


def _lookup(settings, conn, username: str) -> Optional[Tuple[str, dict, List[str]]]:
    """(dn, attributes, group DNs lower-case) of `username`, or None."""
    from ldap3 import SUBTREE
    from ldap3.utils.conv import escape_filter_chars
    flt = settings.ldap_user_filter.replace("{username}", escape_filter_chars(username))
    conn.search(settings.ldap_base_dn, flt, SUBTREE, attributes=["mail", "memberOf"], size_limit=2)
    entries = [e for e in conn.response if e.get("type") == "searchResEntry"]
    if len(entries) != 1:
        return None
    dn = entries[0]["dn"]
    attrs = entries[0].get("attributes") or {}
    groups = [str(g).lower() for g in (attrs.get("memberOf") or [])]
    # Directories without memberOf: the groups that list the user
    edn = escape_filter_chars(dn)
    conn.search(settings.ldap_base_dn, f"(|(&(objectClass=groupOfNames)(member={edn}))"
                                       f"(&(objectClass=groupOfUniqueNames)(uniqueMember={edn})))",
                SUBTREE, attributes=[])
    groups += [e["dn"].lower() for e in conn.response if e.get("type") == "searchResEntry"]
    mail = attrs.get("mail")
    return dn, {"mail": (mail[0] if isinstance(mail, list) and mail else mail) or None}, sorted(set(groups))


def match(settings, groups: List[str]) -> Optional[dict]:
    for m in parse_mappings(settings.ldap_mappings):
        if m["group"] in groups:
            return m
    return None


def check(settings, username: str, password: str) -> dict:
    """Blocking: the directory's answer for a login (no database change)."""
    if not settings.ldap_enabled or not settings.ldap_url:
        raise LdapError("LDAP non attivo")
    svc = _service(settings)
    try:
        found = _lookup(settings, svc, username)
    finally:
        svc.unbind()
    if found is None:
        raise LdapError("utente non trovato (o più utenti con lo stesso nome)")
    dn, attrs, groups = found
    user_conn = _connect(settings, dn, password)
    user_conn.unbind()
    return {"dn": dn, "mail": attrs["mail"], "groups": groups, "mapping": match(settings, groups)}


async def _apply(session, user, mapping: dict, mail: Optional[str]) -> bool:
    """Role, access, group (and e-mail) from the mapping; True when they changed."""
    from core.auth import service as auth_service
    from manager.keys import reset_approvals
    changed = (user.role, user.access, user.group_id) != (mapping["role"], mapping["access"], mapping["group_id"])
    user.role, user.access, user.group_id = mapping["role"], mapping["access"], mapping["group_id"]
    if mail:
        user.email = mail[:255]
    if changed:
        auth_service.revoke_sessions(user)
        await reset_approvals(session, user.id)
    session.add(user)
    return changed


async def login(session, username: str, password: str):
    """The LDAP user (created or updated), or None. Called only for usernames
    that are not local users."""
    from core.auth.models import User
    from core.auth.service import get_password_hash
    from core.settings.router import get_system_settings
    from manager.models import InstanceGroup
    settings = await get_system_settings(session)
    if not settings.ldap_enabled:
        return None
    try:
        res = await asyncio.to_thread(check, settings, username, password)
    except LdapError as e:
        logger.info("LDAP login of %s refused: %s", username, e)
        return None
    mapping = res["mapping"]
    if mapping is None:
        logger.warning("LDAP login of %s: no mapped group (%s)", username, ", ".join(res["groups"])[:300])
        return None
    if mapping["group_id"]:
        group = await session.get(InstanceGroup, mapping["group_id"])
        expected = "partner" if mapping["role"] == "partner" else "customer"
        if group is None or group.kind != expected:
            logger.error("LDAP mapping %s: manager group %s missing or not a %s", mapping["group"],
                         mapping["group_id"], expected)
            return None
    user = (await session.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if user is None:
        user = User(username=username, auth_source="ldap", totp_enforced=True,
                    hashed_password=await asyncio.to_thread(get_password_hash, secrets.token_urlsafe(32)))
        session.add(user)
        await session.flush()
        logger.info("LDAP user %s created (%s %s)", username, mapping["role"], mapping["access"])
    elif user.auth_source != "ldap":
        return None
    if not user.is_active:
        return None
    user.totp_enforced = True
    await _apply(session, user, mapping, res["mail"])
    # Now: the request's own commit runs after the response is sent
    await session.commit()
    return user


async def sync_once() -> int:
    """Every LDAP user against the directory; returns how many changed."""
    from core.auth import service as auth_service
    from core.auth.models import User
    from core.database import async_session_maker
    from core.settings.router import get_system_settings
    async with async_session_maker() as session:
        settings = await get_system_settings(session)
        if not settings.ldap_enabled:
            return 0
        users = (await session.execute(select(User).where(User.auth_source == "ldap", User.is_active == True)))\
            .scalars().all()  # noqa: E712
        if not users:
            return 0

        def lookups():
            svc = _service(settings)
            try:
                return {u.username: _lookup(settings, svc, u.username) for u in users}
            finally:
                svc.unbind()
        found = await asyncio.to_thread(lookups)
        changed = 0
        for u in users:
            entry = found.get(u.username)
            mapping = match(settings, entry[2]) if entry else None
            if mapping is None:
                u.is_active = False
                auth_service.revoke_sessions(u)
                session.add(u)
                changed += 1
                logger.warning("LDAP user %s disabled: %s", u.username,
                               "not in the directory" if entry is None else "in no mapped group")
            elif await _apply(session, u, mapping, entry[1]["mail"]):
                changed += 1
                logger.info("LDAP user %s: now %s %s", u.username, mapping["role"], mapping["access"])
        await session.commit()
        return changed


async def sync_task() -> None:
    while True:
        await asyncio.sleep(SYNC_INTERVAL)
        try:
            await sync_once()
        except asyncio.CancelledError:
            raise
        except LdapError as e:
            logger.warning("LDAP sync failed: %s", e)
        except Exception:
            logger.exception("LDAP sync error")


def require_local(user) -> None:
    if getattr(user, "auth_source", "local") == "ldap":
        raise HTTPException(400, "Utente LDAP: la password si cambia nella directory")
