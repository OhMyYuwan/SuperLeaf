"""Shared FastAPI dependencies.

`get_current_project` is the single point that turns the trusted `X-Project-Id`
header into a real `Project` row. Every route that should be project-scoped
must declare `project: Project = Depends(get_current_project)`.

There is no auth layer here — the header is taken at face value. When the
backend grows auth, this is the choke point to add ownership checks.
"""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Project


def get_current_project(
    x_project_id: str | None = Header(default=None, alias="X-Project-Id"),
    db: Session = Depends(get_session),
) -> Project:
    if not x_project_id:
        raise HTTPException(400, "Missing X-Project-Id header")
    project = db.get(Project, x_project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    return project
