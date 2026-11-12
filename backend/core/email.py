"""
MADMIN Email Service

Provides email sending functionality using aiosmtplib.
"""
import asyncio
import logging
import ssl
from typing import Optional
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from aiosmtplib import SMTP, SMTPException

logger = logging.getLogger(__name__)


async def send_email(
    smtp_host: str,
    smtp_port: int,
    smtp_encryption: str,  # "none", "tls", "ssl"
    smtp_username: Optional[str],
    smtp_password: Optional[str],
    sender_email: str,
    sender_name: str,
    recipient_email: str,
    subject: str,
    body_html: str,
    body_text: Optional[str] = None
) -> dict:
    """
    Send an email using the provided SMTP configuration.
    
    Args:
        smtp_host: SMTP server hostname
        smtp_port: SMTP server port
        smtp_encryption: "none", "tls" (STARTTLS), or "ssl"
        smtp_username: SMTP auth username (optional)
        smtp_password: SMTP auth password (optional)
        sender_email: From email address
        sender_name: From display name
        recipient_email: To email address
        subject: Email subject
        body_html: HTML body content
        body_text: Plain text body (optional, derived from HTML if not provided)
    
    Returns:
        dict with success status and message
    """
    try:
        # Create message
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{sender_name} <{sender_email}>"
        msg["To"] = recipient_email
        
        # Add text part
        text_content = body_text or body_html.replace("<br>", "\n").replace("</p>", "\n")
        msg.attach(MIMEText(text_content, "plain", "utf-8"))
        
        # Add HTML part
        msg.attach(MIMEText(body_html, "html", "utf-8"))
        
        # Configure SMTP client based on encryption type
        # - ssl: Connect with TLS from the start (port 465 typically)
        # - tls: Plain connect then upgrade via STARTTLS (port 587 typically)
        # - none: Plain connection without encryption (port 25 typically)
        
        use_tls = (smtp_encryption == "ssl")
        start_tls = (smtp_encryption == "tls")
        
        logger.info(f"Connecting to SMTP {smtp_host}:{smtp_port} (encryption={smtp_encryption})")
        
        smtp = SMTP(
            hostname=smtp_host,
            port=smtp_port,
            use_tls=use_tls,
            start_tls=start_tls,
            timeout=30
        )
        
        async with smtp:
            # Authenticate if credentials provided
            if smtp_username and smtp_password:
                await smtp.login(smtp_username, smtp_password)
            
            # Send email
            await smtp.send_message(msg)
        
        logger.info(f"Email sent successfully to {recipient_email}")
        return {"success": True, "message": "Email inviata con successo"}
        
    except SMTPException as e:
        logger.error(f"SMTP error sending email: {e}")
        return {"success": False, "message": f"Errore SMTP: {str(e)}"}
    except asyncio.TimeoutError:
        logger.error("SMTP connection timed out")
        return {"success": False, "message": "Timeout connessione SMTP - verifica host e porta"}
    except Exception as e:
        logger.error(f"Error sending email: {e}")
        return {"success": False, "message": f"Errore: {str(e)}"}


async def send_test_email(
    smtp_host: str,
    smtp_port: int,
    smtp_encryption: str,
    smtp_username: Optional[str],
    smtp_password: Optional[str],
    sender_email: str,
    sender_name: str,
    recipient_email: str
) -> dict:
    """Send a test email to verify SMTP configuration."""
    subject = "MADMIN - Test Email"
    body_html = """
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h2 style="color: #206bc4;">✅ Configurazione SMTP Corretta</h2>
        <p>Questo è un messaggio di test inviato da <strong>MADMIN</strong>.</p>
        <p>Se stai leggendo questa email, la configurazione SMTP è corretta!</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">
            Inviato da MADMIN - Modular Admin System
        </p>
    </body>
    </html>
    """
    
    return await send_email(
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        smtp_encryption=smtp_encryption,
        smtp_username=smtp_username,
        smtp_password=smtp_password,
        sender_email=sender_email,
        sender_name=sender_name,
        recipient_email=recipient_email,
        subject=subject,
        body_html=body_html
    )
