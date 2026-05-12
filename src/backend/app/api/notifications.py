"""Notification API routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Notification, User
from ..schemas import NotificationOut
from .deps import get_current_user

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationOut])
def list_notifications(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[NotificationOut]:
    stmt = (
        select(Notification)
        .where(Notification.user_id == user.id)
        .order_by(Notification.created_at.desc())
        .limit(50)
    )
    rows = db.scalars(stmt).all()
    return [NotificationOut.model_validate(r) for r in rows]


@router.get("/unread-count")
def unread_count(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    stmt = select(Notification).where(
        Notification.user_id == user.id,
        Notification.is_read == False,
    )
    count = len(db.scalars(stmt).all())
    return {"count": count}


@router.post("/{notification_id}/read", status_code=204)
def mark_read(
    notification_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> None:
    n = db.get(Notification, notification_id)
    if n is None or n.user_id != user.id:
        raise HTTPException(404, "Notification not found")
    n.is_read = True
    db.commit()


@router.post("/read-all", status_code=204)
def mark_all_read(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> None:
    db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.is_read == False)
        .values(is_read=True)
    )
    db.commit()
