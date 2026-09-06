"""Optional SMTP delivery; inbox notifications remain the reliable channel."""

from __future__ import annotations

import asyncio
import smtplib
from email.message import EmailMessage
from urllib.parse import parse_qs, unquote, urlparse

from .core.settings import Settings


async def send_mail(settings: Settings, recipient: str, subject: str, body: str) -> bool:
    if not settings.smtp_url or not settings.mail_from:
        return False
    parsed = urlparse(settings.smtp_url)
    if parsed.scheme not in {"smtp", "smtps"} or not parsed.hostname:
        return False

    def deliver() -> None:
        message = EmailMessage()
        message["From"] = settings.mail_from
        message["To"] = recipient
        message["Subject"] = subject
        message.set_content(body)
        client_type = smtplib.SMTP_SSL if parsed.scheme == "smtps" else smtplib.SMTP
        with client_type(parsed.hostname, parsed.port or (465 if parsed.scheme == "smtps" else 587), timeout=10) as smtp:
            options = parse_qs(parsed.query)
            if parsed.scheme == "smtp" and options.get("starttls", ["1"])[0] != "0":
                smtp.starttls()
            if parsed.username:
                smtp.login(unquote(parsed.username), unquote(parsed.password or ""))
            smtp.send_message(message)

    try:
        await asyncio.to_thread(deliver)
        return True
    except (OSError, smtplib.SMTPException):
        return False
