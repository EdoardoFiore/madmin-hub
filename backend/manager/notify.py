"""
Notifications (ROADMAP 10.2): e-mail to the superusers (or to the addresses
in Settings) for what needs a person: a registration request to approve, an
SSH key to approve, a rollout halted, an update or a kernel trial that
failed, an instance reporting through the rescue, a new critical
vulnerability. Sent in the background; the same event (kind + key) at most
once per THROTTLE. Without an SMTP host nothing is sent; the menu badges
(/api/ui/badges) show the same things anyway.
"""
import html
import logging
import time
from typing import List

from sqlmodel import select

from core.concurrency import spawn_background

logger = logging.getLogger("madmin_manager.notify")

THROTTLE = 3600
_last: dict = {}


async def recipients(session, settings) -> List[str]:
    if settings.notify_to.strip():
        return [a.strip() for a in settings.notify_to.split(",") if a.strip()]
    from core.auth.models import User
    rows = (await session.execute(select(User.email).where(
        User.role == "superuser", User.is_active == True, User.email != None))).all()  # noqa: E711,E712
    return sorted({e for (e,) in rows if e})


async def send(settings, subject: str, text: str, to: List[str]) -> List[str]:
    """Errors, one per recipient that failed."""
    from core.email import send_email
    from core.secrets import decrypt_setting
    password = decrypt_setting(settings.smtp_password) if settings.smtp_password else None
    errors = []
    for addr in to:
        res = await send_email(
            smtp_host=settings.smtp_host, smtp_port=settings.smtp_port, smtp_encryption=settings.smtp_encryption,
            smtp_username=settings.smtp_username or None, smtp_password=password,
            sender_email=settings.smtp_from or settings.smtp_username or f"madmin-manager@{settings.smtp_host}",
            sender_name=settings.company_name or "MADMIN Manager", recipient_email=addr,
            subject=f"[{settings.company_name or 'MADMIN Manager'}] {subject}",
            body_html="<p>" + html.escape(text).replace("\n", "<br>") + "</p>", body_text=text,
        )
        if not res.get("success"):
            errors.append(f"{addr}: {res.get('message')}")
    return errors


async def _deliver(subject: str, text: str) -> None:
    from core.database import async_session_maker
    from core.settings.router import get_system_settings
    try:
        async with async_session_maker() as session:
            settings = await get_system_settings(session)
            if not settings.smtp_host:
                return
            to = await recipients(session, settings)
        if not to:
            return
        errors = await send(settings, subject, text, to)
        for e in errors:
            logger.warning("Notification not sent: %s", e)
    except Exception:
        logger.exception("Notification failed")


def notify(kind: str, key: str, subject: str, text: str) -> None:
    """Queue one notification (never blocks, never raises)."""
    now = time.monotonic()
    if now - _last.get((kind, key), -THROTTLE) < THROTTLE:
        return
    _last[(kind, key)] = now
    if len(_last) > 10000:
        _last.clear()
    spawn_background(_deliver(subject, text), f"notify-{kind}")
