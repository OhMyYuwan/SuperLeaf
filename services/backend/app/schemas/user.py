"""用户、登录与注册邀请 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str
    is_admin: bool
    is_disabled: bool
    created_at: datetime
    last_login_at: datetime | None

    class Config:
        from_attributes = True


class UserRegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(default="", max_length=128)
    bootstrap_token: str = Field(default="", max_length=512)
    invite_token: str = Field(default="", max_length=512)


class UserLoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=128)


class UserUpdateIn(BaseModel):
    is_disabled: bool | None = None
    is_admin: bool | None = None
    display_name: str | None = Field(default=None, max_length=128)


class RegistrationInviteCreateIn(BaseModel):
    email: str = Field(default="", max_length=255)
    expires_in_days: int = Field(default=7, ge=1, le=365)
    note: str = Field(default="", max_length=1000)
    send_email: bool = False


class RegistrationInviteOut(BaseModel):
    id: str
    email: str
    token_hint: str
    created_by_user_id: str
    created_at: datetime
    expires_at: datetime | None
    used_at: datetime | None
    used_by_user_id: str | None
    revoked_at: datetime | None
    send_status: str
    send_error: str
    last_sent_at: datetime | None
    note: str

    class Config:
        from_attributes = True


class RegistrationInviteCreateOut(RegistrationInviteOut):
    token: str
    invite_url: str
    smtp_configured: bool


class RegistrationInviteEmailStatusOut(BaseModel):
    smtp_configured: bool
    from_email: str
