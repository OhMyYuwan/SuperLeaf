"""SQLAlchemy engine + session factory."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .settings import settings


class Base(DeclarativeBase):
    pass


engine = create_engine(
    settings.resolved_database_url(),
    future=True,
    connect_args={"check_same_thread": False} if settings.resolved_database_url().startswith("sqlite") else {},
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    with SessionLocal() as db:
        yield db


def init_db() -> None:
    # Import models so Base.metadata knows about them.
    from . import models  # noqa: F401
    from .migrations import run_migrations

    Base.metadata.create_all(engine)
    run_migrations(engine)

    # Seed built-in workflow templates
    from .services.workflow_template_service import seed_builtin_templates
    with SessionLocal() as db:
        seed_builtin_templates(db)
