"""Idempotent SQLite migrations applied at startup after `create_all`.

This file exists because the project does not use Alembic; instead we run a
small set of guarded `ALTER TABLE` + backfill statements every boot. Each step
is safe to re-run — schema mutations are gated on `PRAGMA table_info` and
backfills only touch NULL/empty values.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.engine import Engine


_PROJECT_SCOPED_TABLES = ("conversations", "workflow_definitions", "workflow_runs")
_USER_SCOPED_TABLES = ("projects", "providers", "cached_workflows")
_PRIVATE_ASSET_TABLES = (
    "workflow_definitions",
    "workflow_runs",
    "conversations",
    "annotations",
    "annotation_evaluations",
    "annotation_review_states",
)


def _column_exists(conn, table: str, column: str) -> bool:
    rows = conn.execute(text(f"PRAGMA table_info({table})")).all()
    return any(r[1] == column for r in rows)


def run_migrations(engine: Engine) -> None:
    """Run all pending migrations. Safe to call on every startup."""
    # Only SQLite needs the manual PRAGMA gating; other dialects should adopt
    # Alembic before we grow more migrations.
    if not engine.url.get_backend_name().startswith("sqlite"):
        return

    with engine.begin() as conn:
        bootstrap_pid = _ensure_bootstrap_project(conn)
        _add_project_id_columns(conn, bootstrap_pid)
        _add_user_id_columns(conn)
        _add_user_id_to_private_assets(conn)
        _add_is_global_to_annotations(conn)


def _ensure_bootstrap_project(conn) -> str:
    """Guarantee at least one Project row; rename a lone placeholder to 我的项目."""
    row = conn.execute(
        text("SELECT id, name FROM projects ORDER BY created_at ASC LIMIT 1")
    ).first()

    if row is None:
        pid = uuid4().hex
        now = datetime.utcnow()
        # `user_id` column may or may not exist yet (added by a later migration
        # step in this same transaction). The bootstrap project is left with
        # an empty `user_id`; the first registered user picks it up.
        if _column_exists(conn, "projects", "user_id"):
            conn.execute(
                text(
                    "INSERT INTO projects (id, user_id, name, main_doc_id, compiler, created_at, updated_at) "
                    "VALUES (:id, '', :name, '', '', :now, :now)"
                ),
                {"id": pid, "name": "我的项目", "now": now},
            )
        else:
            conn.execute(
                text(
                    "INSERT INTO projects (id, name, main_doc_id, compiler, created_at, updated_at) "
                    "VALUES (:id, :name, '', '', :now, :now)"
                ),
                {"id": pid, "name": "我的项目", "now": now},
            )
        return pid

    pid = row[0]
    count = conn.execute(text("SELECT COUNT(*) FROM projects")).scalar() or 0
    if count == 1 and row[1] in ("Untitled Project", ""):
        conn.execute(
            text("UPDATE projects SET name = :name WHERE id = :id"),
            {"name": "我的项目", "id": pid},
        )
    return pid


def _add_project_id_columns(conn, fallback_pid: str) -> None:
    backfill_sql = {
        "conversations": (
            "UPDATE conversations SET project_id = COALESCE("
            "  (SELECT d.project_id FROM docs d WHERE d.id = conversations.document_id),"
            "  :fallback"
            ") WHERE project_id IS NULL OR project_id = ''"
        ),
        "workflow_definitions": (
            "UPDATE workflow_definitions SET project_id = :fallback "
            "WHERE project_id IS NULL OR project_id = ''"
        ),
        "workflow_runs": (
            "UPDATE workflow_runs SET project_id = COALESCE("
            "  (SELECT d.project_id FROM docs d WHERE d.id = workflow_runs.document_id),"
            "  :fallback"
            ") WHERE project_id IS NULL OR project_id = ''"
        ),
    }

    for tbl in _PROJECT_SCOPED_TABLES:
        if not _column_exists(conn, tbl, "project_id"):
            conn.execute(
                text(f"ALTER TABLE {tbl} ADD COLUMN project_id VARCHAR(32) DEFAULT ''")
            )
        conn.execute(text(backfill_sql[tbl]), {"fallback": fallback_pid})
        conn.execute(
            text(f"CREATE INDEX IF NOT EXISTS ix_{tbl}_project_id ON {tbl}(project_id)")
        )


def _add_user_id_columns(conn) -> None:
    """Add `user_id` to projects/providers/cached_workflows.

    Rows are left with `user_id = ''`; the first user to register will pick
    them up via `AuthService._backfill_existing_resources`. We do not backfill
    here because there are no users at migration time.
    """
    for tbl in _USER_SCOPED_TABLES:
        if not _column_exists(conn, tbl, "user_id"):
            conn.execute(
                text(f"ALTER TABLE {tbl} ADD COLUMN user_id VARCHAR(32) DEFAULT ''")
            )
        conn.execute(
            text(f"CREATE INDEX IF NOT EXISTS ix_{tbl}_user_id ON {tbl}(user_id)")
        )


def _add_user_id_to_private_assets(conn) -> None:
    """Add `user_id` to Agent-private tables and backfill from project owner.

    Agent/workflow data is personal — each collaborator only sees their own.
    Existing rows (created before multi-user) are assigned to the project owner.
    """
    _TABLES_WITH_PROJECT_ID = (
        "workflow_definitions",
        "workflow_runs",
        "conversations",
        "annotations",
    )
    _TABLES_WITH_DOC_ID_ONLY = (
        "annotation_evaluations",
        "annotation_review_states",
    )

    for tbl in _PRIVATE_ASSET_TABLES:
        if not _column_exists(conn, tbl, "user_id"):
            conn.execute(
                text(f"ALTER TABLE {tbl} ADD COLUMN user_id VARCHAR(32) DEFAULT ''")
            )
        conn.execute(
            text(f"CREATE INDEX IF NOT EXISTS ix_{tbl}_user_id ON {tbl}(user_id)")
        )

    for tbl in _TABLES_WITH_PROJECT_ID:
        conn.execute(
            text(
                f"UPDATE {tbl} SET user_id = ("
                f"  SELECT p.user_id FROM projects p WHERE p.id = {tbl}.project_id"
                f") WHERE user_id = '' AND project_id != ''"
            )
        )

    for tbl in _TABLES_WITH_DOC_ID_ONLY:
        conn.execute(
            text(
                f"UPDATE {tbl} SET user_id = ("
                f"  SELECT p.user_id FROM projects p"
                f"  JOIN docs d ON d.project_id = p.id"
                f"  WHERE d.id = {tbl}.doc_id"
                f") WHERE user_id = ''"
            )
        )


def _add_is_global_to_annotations(conn) -> None:
    """Add `is_global` boolean to annotations table.

    Existing annotations without an agent (workflow_id='') are global;
    those with an agent are private.
    """
    if not _column_exists(conn, "annotations", "is_global"):
        conn.execute(text("ALTER TABLE annotations ADD COLUMN is_global BOOLEAN DEFAULT 0"))
    # Backfill: annotations without workflow_id are global
    conn.execute(
        text("UPDATE annotations SET is_global = 1 WHERE workflow_id = '' AND agent_name = ''")
    )
