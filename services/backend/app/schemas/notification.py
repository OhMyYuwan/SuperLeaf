"""多人协作通知 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class NotificationOut(BaseModel):
    id: str
    user_id: str
    kind: str
    title: str
    body: str
    target_id: str
    target_type: str
    is_read: bool
    created_at: datetime

    class Config:
        from_attributes = True
