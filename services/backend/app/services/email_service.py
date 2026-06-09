"""Optional SMTP email delivery for registration invitations."""

from __future__ import annotations

import smtplib
import ssl
from datetime import datetime
from email.message import EmailMessage

from ..settings import settings


class EmailNotConfiguredError(RuntimeError):
    """Raised when SMTP delivery is requested without SMTP settings."""


class EmailService:
    def is_configured(self) -> bool:
        return bool(settings.smtp_host.strip() and settings.smtp_from.strip())

    def from_email(self) -> str:
        return settings.smtp_from.strip()

    def send_registration_invite(
        self,
        *,
        to_email: str,
        invite_url: str,
        expires_at: datetime | None,
    ) -> None:
        if not self.is_configured():
            raise EmailNotConfiguredError("SMTP is not configured")
        to_email = to_email.strip()
        if not to_email:
            raise ValueError("Invite email is required")

        msg = EmailMessage()
        msg["Subject"] = "SuperLeaf 注册邀请"
        msg["From"] = settings.smtp_from.strip()
        msg["To"] = to_email
        expiry_text = expires_at.strftime("%Y-%m-%d %H:%M UTC") if expires_at else "未设置过期时间"
        msg.set_content(
            "\n".join(
                [
                    "你好，",
                    "",
                    "管理员邀请你注册 SuperLeaf。请打开下面的链接完成注册：",
                    invite_url,
                    "",
                    f"邀请码有效期至：{expiry_text}",
                    "该链接只能使用一次。",
                    "",
                    "如果你没有预期收到这封邮件，可以忽略它。",
                ]
            )
        )

        host = settings.smtp_host.strip()
        port = int(settings.smtp_port)
        if settings.smtp_tls:
            context = ssl.create_default_context()
            with smtplib.SMTP(host, port, timeout=15) as smtp:
                smtp.starttls(context=context)
                self._login_if_needed(smtp)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as smtp:
                self._login_if_needed(smtp)
                smtp.send_message(msg)

    @staticmethod
    def _login_if_needed(smtp: smtplib.SMTP) -> None:
        username = settings.smtp_username.strip()
        if username:
            smtp.login(username, settings.smtp_password)
