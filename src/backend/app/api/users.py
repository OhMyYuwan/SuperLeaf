"""/api/users — admin-only user management.

Mounts under `Depends(require_admin)` for every route. Endpoints:
  GET    /api/users           list all users
  PATCH  /api/users/{id}      flip is_disabled / is_admin / display_name
  DELETE /api/users/{id}      cascade-delete (refuses last admin)
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import User
from ..schemas import UserOut, UserUpdateIn
from ..services.user_service import LastAdminError, UserService
from .deps import require_admin

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=list[UserOut])
def list_users(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> list[UserOut]:
    return [UserOut.model_validate(u) for u in UserService(db).list()]


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    body: UserUpdateIn,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> UserOut:
    try:
        u = UserService(db).update(
            user_id,
            is_disabled=body.is_disabled,
            is_admin=body.is_admin,
            display_name=body.display_name,
        )
    except LastAdminError as e:
        raise HTTPException(409, str(e)) from e
    if u is None:
        raise HTTPException(404, "User not found")
    return UserOut.model_validate(u)


@router.delete("/{user_id}", status_code=204)
def delete_user(
    user_id: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> None:
    try:
        ok = UserService(db).delete(user_id)
    except LastAdminError as e:
        raise HTTPException(409, str(e)) from e
    if not ok:
        raise HTTPException(404, "User not found")
