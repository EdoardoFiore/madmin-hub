"""
SMTP notification dispatch (M1: stub for future M2 alerts).
"""
import logging
from typing import Optional

import aiosmtplib
from email.message import EmailMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.settings.models import SMTPSettings
from core.settings.router import get_smtp_password_plain

logger = logging.getLogger(__name__)


async def send_email(
    session: AsyncSession,
    to: str,
    subject: str,
    body: str,
    html: Optional[str] = None,
) -> bool:
    result = await session.execute(select(SMTPSettings).where(SMTPSettings.id == 1))
    s = result.scalar_one_or_none()
    if not s or not s.enabled or not s.host or not s.from_address:
        logger.warning("SMTP not configured, email skipped")
        return False

    msg = EmailMessage()
    msg["From"] = f"{s.from_name} <{s.from_address}>"
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")

    use_ssl = s.port == 465
    try:
        await aiosmtplib.send(
            msg,
            hostname=s.host,
            port=s.port,
            username=s.username or None,
            password=get_smtp_password_plain(s),
            use_tls=use_ssl,
            start_tls=s.use_tls and not use_ssl,
        )
        return True
    except Exception as e:
        logger.error("SMTP send failed (host=%s port=%s tls=%s ssl=%s): %s", s.host, s.port, s.use_tls, use_ssl, e)
        return False
