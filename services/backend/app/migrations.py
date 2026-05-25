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

from .services.skill_content_crypto import encrypt_skill_content


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


def _table_exists(conn, table: str) -> bool:
    row = conn.execute(
        text("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :name"),
        {"name": table},
    ).first()
    return row is not None


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
        _add_project_archive_github_columns(conn)
        _rebuild_native_agents_table(conn)
        _add_native_agent_workspace_columns(conn)
        _add_native_agent_skill_install_columns(conn)
        _rebuild_native_mcp_servers_table(conn)
        _encrypt_plaintext_skill_content(conn)


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


def _add_project_archive_github_columns(conn) -> None:
    if not _column_exists(conn, "project_archive_bindings", "github_account_id"):
        conn.execute(
            text("ALTER TABLE project_archive_bindings ADD COLUMN github_account_id VARCHAR(32) DEFAULT ''")
        )
    if not _column_exists(conn, "project_archive_bindings", "github_repo_url"):
        conn.execute(
            text("ALTER TABLE project_archive_bindings ADD COLUMN github_repo_url VARCHAR(512) DEFAULT ''")
        )


def _rebuild_native_agents_table(conn) -> None:
    """Normalize `native_agents` to the SQLAlchemy model-managed schema.

    REQ-0071 first created a credential-based table with `created_by_user_id`
    and `credential_id`. Later native Providers made the model project-scoped
    through `owner_user_id` and `provider_id`. SQLite cannot drop NOT NULL
    columns in-place, so rebuild once when the legacy columns are present.
    """
    if not _table_exists(conn, "native_agents"):
        return

    columns = {
        row[1]
        for row in conn.execute(text("PRAGMA table_info(native_agents)")).all()
    }
    needs_rebuild = "created_by_user_id" in columns or "credential_id" in columns
    if not needs_rebuild:
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_native_agents_project_id ON native_agents(project_id)")
        )
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_native_agents_owner_user_id ON native_agents(owner_user_id)")
        )
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_native_agents_provider_id ON native_agents(provider_id)")
        )
        return

    owner_expr = (
        "COALESCE(NULLIF(owner_user_id, ''), NULLIF(created_by_user_id, ''), '')"
        if "owner_user_id" in columns and "created_by_user_id" in columns
        else "COALESCE(NULLIF(owner_user_id, ''), '')"
        if "owner_user_id" in columns
        else "COALESCE(NULLIF(created_by_user_id, ''), '')"
    )
    provider_expr = (
        "COALESCE(NULLIF(provider_id, ''), '')" if "provider_id" in columns else "''"
    )

    conn.execute(text("DROP TABLE IF EXISTS native_agents__new"))
    conn.execute(
        text(
            """
            CREATE TABLE native_agents__new (
                id VARCHAR(32) NOT NULL,
                project_id VARCHAR(32) NOT NULL,
                owner_user_id VARCHAR(32) NOT NULL,
                provider_id VARCHAR(32) NOT NULL,
                name VARCHAR(128) NOT NULL,
                description TEXT NOT NULL,
                model VARCHAR(128) NOT NULL,
                instructions TEXT NOT NULL,
                skill_ids JSON NOT NULL,
                output_contract VARCHAR(32) NOT NULL,
                runtime_config JSON NOT NULL,
                is_enabled BOOLEAN NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                FOREIGN KEY(project_id) REFERENCES projects (id),
                FOREIGN KEY(owner_user_id) REFERENCES users (id),
                FOREIGN KEY(provider_id) REFERENCES providers (id)
            )
            """
        )
    )
    conn.execute(
        text(
            f"""
            INSERT INTO native_agents__new (
                id,
                project_id,
                owner_user_id,
                provider_id,
                name,
                description,
                model,
                instructions,
                skill_ids,
                output_contract,
                runtime_config,
                is_enabled,
                created_at,
                updated_at
            )
            SELECT
                id,
                COALESCE(NULLIF(project_id, ''), ''),
                {owner_expr},
                {provider_expr},
                name,
                COALESCE(description, ''),
                COALESCE(model, ''),
                COALESCE(instructions, ''),
                COALESCE(skill_ids, '[]'),
                COALESCE(NULLIF(output_contract, ''), 'annotation'),
                COALESCE(runtime_config, '{{}}'),
                COALESCE(is_enabled, 1),
                created_at,
                updated_at
            FROM native_agents
            """
        )
    )
    conn.execute(text("DROP TABLE native_agents"))
    conn.execute(text("ALTER TABLE native_agents__new RENAME TO native_agents"))
    conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_native_agents_project_id ON native_agents(project_id)")
    )
    conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_native_agents_owner_user_id ON native_agents(owner_user_id)")
    )
    conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_native_agents_provider_id ON native_agents(provider_id)")
    )


def _encrypt_plaintext_skill_content(conn) -> None:
    """Encrypt legacy plaintext Skill content in place."""
    if not _table_exists(conn, "skills") or not _column_exists(conn, "skills", "content"):
        return
    rows = conn.execute(
        text("SELECT id, content FROM skills WHERE content != '' AND content NOT LIKE 'fernet:%'")
    ).all()
    for row in rows:
        conn.execute(
            text("UPDATE skills SET content = :content WHERE id = :id"),
            {"id": row[0], "content": encrypt_skill_content(row[1] or "")},
        )


def _add_native_agent_workspace_columns(conn) -> None:
    if not _table_exists(conn, "native_agents"):
        return
    additions = {
        "agent_md": "TEXT DEFAULT ''",
        "workspace_path": "VARCHAR(1024) DEFAULT ''",
        "setup_status": "VARCHAR(32) DEFAULT 'ready'",
        "setup_log": "TEXT DEFAULT ''",
    }
    for column, ddl in additions.items():
        if not _column_exists(conn, "native_agents", column):
            conn.execute(text(f"ALTER TABLE native_agents ADD COLUMN {column} {ddl}"))


def _add_native_agent_skill_install_columns(conn) -> None:
    if not _table_exists(conn, "native_agent_skill_installs"):
        return
    if not _column_exists(conn, "native_agent_skill_installs", "skill_id"):
        conn.execute(
            text("ALTER TABLE native_agent_skill_installs ADD COLUMN skill_id VARCHAR(32) DEFAULT ''")
        )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_native_agent_skill_installs_skill_id "
            "ON native_agent_skill_installs(skill_id)"
        )
    )


def _rebuild_native_mcp_servers_table(conn) -> None:
    """Drop the early preset unique constraint so custom MCPs can be many."""
    if not _table_exists(conn, "native_mcp_servers"):
        return
    unique_preset_index = False
    for row in conn.execute(text("PRAGMA index_list(native_mcp_servers)")).all():
        # SQLite PRAGMA index_list: seq, name, unique, origin, partial.
        if not row[2]:
            continue
        columns = [
            info[2]
            for info in conn.execute(text(f"PRAGMA index_info({row[1]})")).all()
        ]
        if columns == ["user_id", "preset_id"]:
            unique_preset_index = True
            break
    if not unique_preset_index:
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_native_mcp_servers_user_id ON native_mcp_servers(user_id)")
        )
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_native_mcp_servers_preset_id ON native_mcp_servers(preset_id)")
        )
        return

    conn.execute(text("DROP TABLE IF EXISTS native_mcp_servers__new"))
    conn.execute(
        text(
            """
            CREATE TABLE native_mcp_servers__new (
                id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                preset_id VARCHAR(128) NOT NULL,
                source VARCHAR(32) NOT NULL,
                name VARCHAR(128) NOT NULL,
                description TEXT NOT NULL,
                transport VARCHAR(32) NOT NULL,
                command VARCHAR(256) NOT NULL,
                args JSON NOT NULL,
                env_enc TEXT NOT NULL,
                allowed_tools JSON NOT NULL,
                is_enabled BOOLEAN NOT NULL,
                status VARCHAR(16) NOT NULL,
                status_detail TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    conn.execute(
        text(
            """
            INSERT INTO native_mcp_servers__new (
                id, user_id, preset_id, source, name, description, transport,
                command, args, env_enc, allowed_tools, is_enabled, status,
                status_detail, created_at, updated_at
            )
            SELECT
                id,
                COALESCE(user_id, ''),
                COALESCE(preset_id, ''),
                COALESCE(NULLIF(source, ''), 'custom'),
                COALESCE(name, ''),
                COALESCE(description, ''),
                COALESCE(NULLIF(transport, ''), 'stdio'),
                COALESCE(command, ''),
                COALESCE(args, '[]'),
                COALESCE(env_enc, ''),
                COALESCE(allowed_tools, '[]'),
                COALESCE(is_enabled, 1),
                COALESCE(NULLIF(status, ''), 'unknown'),
                COALESCE(status_detail, ''),
                created_at,
                updated_at
            FROM native_mcp_servers
            """
        )
    )
    conn.execute(text("DROP TABLE native_mcp_servers"))
    conn.execute(text("ALTER TABLE native_mcp_servers__new RENAME TO native_mcp_servers"))
    conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_native_mcp_servers_user_id ON native_mcp_servers(user_id)")
    )
    conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_native_mcp_servers_preset_id ON native_mcp_servers(preset_id)")
    )
