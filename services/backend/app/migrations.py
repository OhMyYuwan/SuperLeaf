"""Idempotent SQLite migrations applied at startup after `create_all`.

This file exists because the project does not use Alembic; instead we run a
small set of guarded `ALTER TABLE` + backfill statements every boot. Each step
is safe to re-run — schema mutations are gated on `PRAGMA table_info` and
backfills only touch NULL/empty values.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any
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
        _add_workflow_run_source_text(conn)
        _add_is_global_to_annotations(conn)
        _add_project_archive_github_columns(conn)
        _add_project_skill_columns(conn)
        _add_project_type_column(conn)
        _add_project_tags_column(conn)
        _create_dataset_tables(conn)
        _backfill_dataset_record_source_text(conn)
        _rebuild_native_agents_table(conn)
        _add_native_agent_workspace_columns(conn)
        _add_native_agent_skill_install_columns(conn)
        _add_skill_project_columns(conn)
        _create_skill_release_table(conn)
        _rebuild_native_mcp_servers_table(conn)
        _add_native_mcp_health_columns(conn)
        _encrypt_plaintext_skill_content(conn)
        _add_doc_collab_generation(conn)
        _add_conversation_user_renamed(conn)
        _add_archived_at_to_annotations(conn)
        _create_annotation_agent_suggestion_table(conn)
        _create_registration_invite_table(conn)
        _create_mcp_tokens_table(conn)
        _add_project_incremental_compile_column(conn)


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
        columns = ["id", "name", "main_doc_id", "compiler", "created_at", "updated_at"]
        values = [":id", ":name", "''", "''", ":now", ":now"]
        optional_defaults = (
            ("user_id", "''"),
            ("incremental_compile", "0"),
            ("project_type", "'paper'"),
            ("is_skill_project", "0"),
            ("tags", "'[]'"),
            ("project_skill_id", "''"),
            ("skill_cache_version", "0"),
        )
        for column, default_sql in optional_defaults:
            if _column_exists(conn, "projects", column):
                columns.append(column)
                values.append(default_sql)
        conn.execute(
            text(
                f"INSERT INTO projects ({', '.join(columns)}) "
                f"VALUES ({', '.join(values)})"
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


def _add_doc_collab_generation(conn) -> None:
    if not _table_exists(conn, "docs"):
        return
    if not _column_exists(conn, "docs", "collab_generation"):
        conn.execute(text("ALTER TABLE docs ADD COLUMN collab_generation INTEGER DEFAULT 1"))
    conn.execute(
        text(
            "UPDATE docs SET collab_generation = 1 "
            "WHERE collab_generation IS NULL OR collab_generation < 1"
        )
    )


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


def _add_workflow_run_source_text(conn) -> None:
    if not _table_exists(conn, "workflow_runs"):
        return
    if not _column_exists(conn, "workflow_runs", "source_text"):
        conn.execute(text("ALTER TABLE workflow_runs ADD COLUMN source_text TEXT DEFAULT ''"))

    rows = conn.execute(
        text("SELECT id, trace FROM workflow_runs WHERE source_text IS NULL OR source_text = ''")
    ).all()
    for row in rows:
        source_text = _source_text_from_workflow_trace_blob(row[1])
        if source_text:
            conn.execute(
                text("UPDATE workflow_runs SET source_text = :source_text WHERE id = :id"),
                {"source_text": source_text, "id": row[0]},
            )


def _source_text_from_workflow_trace_blob(blob: Any) -> str:
    if isinstance(blob, str):
        try:
            blob = json.loads(blob)
        except json.JSONDecodeError:
            return ""
    return _source_text_from_workflow_trace_value(blob)


def _source_text_from_workflow_trace_value(value: Any) -> str:
    if isinstance(value, list):
        for item in value:
            source_text = _source_text_from_workflow_trace_value(item)
            if source_text:
                return source_text
        return ""
    if not isinstance(value, dict):
        return ""

    for key in ("source_text", "target_text", "text", "selected_text", "selection_text"):
        item = value.get(key)
        if isinstance(item, str) and item.strip():
            return item

    for key in ("request", "inputs", "input"):
        source_text = _source_text_from_workflow_trace_value(value.get(key))
        if source_text:
            return source_text

    if value.get("node_type") == "input":
        source_text = _source_text_from_workflow_trace_value(value.get("output"))
        if source_text:
            return source_text
    return ""


def _backfill_dataset_record_source_text(conn) -> None:
    if not _table_exists(conn, "dataset_records") or not _table_exists(conn, "workflow_runs"):
        return
    if not _column_exists(conn, "workflow_runs", "source_text"):
        return

    rows = conn.execute(
        text(
            """
            SELECT dr.id, dr.fields, wr.source_text
            FROM dataset_records dr
            JOIN workflow_runs wr ON wr.id = dr.source_id
            WHERE dr.source_type = 'workflow_run'
              AND wr.source_text IS NOT NULL
              AND wr.source_text != ''
            """
        )
    ).all()
    now = datetime.utcnow()
    for row in rows:
        fields = _json_blob_to_value(row[1])
        if not isinstance(fields, dict):
            continue
        current = fields.get("source_text")
        if current and not _looks_like_dataset_source_pointer(current):
            continue
        fields["source_text"] = row[2]
        conn.execute(
            text("UPDATE dataset_records SET fields = :fields, updated_at = :updated_at WHERE id = :id"),
            {
                "fields": json.dumps(fields, ensure_ascii=False),
                "updated_at": now,
                "id": row[0],
            },
        )


def _json_blob_to_value(blob: Any) -> Any:
    if isinstance(blob, str):
        try:
            return json.loads(blob)
        except json.JSONDecodeError:
            return None
    return blob


def _looks_like_dataset_source_pointer(value: Any) -> bool:
    value = _json_blob_to_value(value)
    return isinstance(value, dict) and {"document_id", "range_start", "range_end"}.issubset(value.keys())


def _create_registration_invite_table(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS registration_invites (
                id VARCHAR(32) NOT NULL PRIMARY KEY,
                email VARCHAR(255) DEFAULT '',
                token_hash VARCHAR(64) NOT NULL,
                token_hint VARCHAR(16) DEFAULT '',
                created_by_user_id VARCHAR(32) NOT NULL,
                created_at DATETIME,
                expires_at DATETIME,
                used_at DATETIME,
                used_by_user_id VARCHAR(32),
                revoked_at DATETIME,
                send_status VARCHAR(32) DEFAULT 'not_requested',
                send_error TEXT DEFAULT '',
                last_sent_at DATETIME,
                note TEXT DEFAULT ''
            )
            """
        )
    )
    conn.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_registration_invites_token_hash "
            "ON registration_invites(token_hash)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_registration_invites_email "
            "ON registration_invites(email)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_registration_invites_created_by_user_id "
            "ON registration_invites(created_by_user_id)"
        )
    )


def _create_mcp_tokens_table(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS mcp_tokens (
                id VARCHAR(32) NOT NULL PRIMARY KEY,
                user_id VARCHAR(32) NOT NULL,
                name VARCHAR(128) DEFAULT '',
                token_hash VARCHAR(64) NOT NULL,
                token_hint VARCHAR(16) DEFAULT '',
                scope VARCHAR(16) DEFAULT 'read',
                created_at DATETIME,
                expires_at DATETIME,
                last_used_at DATETIME,
                last_used_ip VARCHAR(64) DEFAULT '',
                revoked_at DATETIME
            )
            """
        )
    )
    conn.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_mcp_tokens_token_hash "
            "ON mcp_tokens(token_hash)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_mcp_tokens_user_id "
            "ON mcp_tokens(user_id)"
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


def _add_project_skill_columns(conn) -> None:
    if not _table_exists(conn, "projects"):
        return
    additions = {
        "is_skill_project": "BOOLEAN DEFAULT 0",
        "project_skill_id": "VARCHAR(32) DEFAULT ''",
        "skill_cache_version": "INTEGER DEFAULT 0",
        "skill_cache_updated_at": "DATETIME",
    }
    for column, ddl in additions.items():
        if not _column_exists(conn, "projects", column):
            conn.execute(text(f"ALTER TABLE projects ADD COLUMN {column} {ddl}"))


def _add_project_type_column(conn) -> None:
    if not _table_exists(conn, "projects"):
        return
    if not _column_exists(conn, "projects", "project_type"):
        conn.execute(
            text("ALTER TABLE projects ADD COLUMN project_type VARCHAR(16) DEFAULT 'paper'")
        )
    conn.execute(
        text(
            "UPDATE projects SET project_type = 'paper' "
            "WHERE project_type IS NULL OR project_type = ''"
        )
    )
    if _column_exists(conn, "projects", "is_skill_project"):
        conn.execute(
            text(
                "UPDATE projects SET project_type = 'skill' "
                "WHERE is_skill_project = 1 AND (project_type = 'paper' OR project_type = '')"
            )
        )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_projects_project_type ON projects(project_type)"))


def _add_project_tags_column(conn) -> None:
    if not _table_exists(conn, "projects"):
        return
    if not _column_exists(conn, "projects", "tags"):
        conn.execute(text("ALTER TABLE projects ADD COLUMN tags JSON DEFAULT '[]'"))
    conn.execute(text("UPDATE projects SET tags = '[]' WHERE tags IS NULL OR tags = ''"))


def _create_dataset_tables(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS dataset_projects (
                id VARCHAR(32) NOT NULL,
                project_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL DEFAULT '',
                name VARCHAR(128) NOT NULL DEFAULT '',
                guidelines TEXT NOT NULL DEFAULT '',
                schema JSON NOT NULL,
                status VARCHAR(24) NOT NULL DEFAULT 'active',
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                CONSTRAINT uq_dataset_projects_project UNIQUE (project_id),
                FOREIGN KEY(project_id) REFERENCES projects (id),
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS dataset_source_rules (
                id VARCHAR(32) NOT NULL,
                dataset_project_id VARCHAR(32) NOT NULL,
                source_project_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL DEFAULT '',
                name VARCHAR(128) NOT NULL DEFAULT '',
                source_types JSON NOT NULL,
                filters JSON NOT NULL,
                last_cursor JSON NOT NULL,
                rule_version INTEGER NOT NULL DEFAULT 1,
                is_enabled BOOLEAN NOT NULL DEFAULT 1,
                last_synced_at DATETIME DEFAULT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                FOREIGN KEY(dataset_project_id) REFERENCES dataset_projects (id),
                FOREIGN KEY(source_project_id) REFERENCES projects (id),
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS dataset_batches (
                id VARCHAR(32) NOT NULL,
                dataset_project_id VARCHAR(32) NOT NULL,
                source_rule_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL DEFAULT '',
                cursor_from JSON NOT NULL,
                cursor_to JSON NOT NULL,
                counts JSON NOT NULL,
                created_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                FOREIGN KEY(dataset_project_id) REFERENCES dataset_projects (id),
                FOREIGN KEY(source_rule_id) REFERENCES dataset_source_rules (id),
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS dataset_records (
                id VARCHAR(32) NOT NULL,
                dataset_project_id VARCHAR(32) NOT NULL,
                batch_id VARCHAR(32) NOT NULL DEFAULT '',
                source_rule_id VARCHAR(32) NOT NULL DEFAULT '',
                user_id VARCHAR(32) NOT NULL DEFAULT '',
                source_type VARCHAR(32) NOT NULL DEFAULT '',
                source_id VARCHAR(64) NOT NULL DEFAULT '',
                source_created_at DATETIME DEFAULT NULL,
                fingerprint VARCHAR(64) NOT NULL,
                fields JSON NOT NULL,
                metadata JSON NOT NULL,
                provenance JSON NOT NULL,
                status VARCHAR(24) NOT NULL DEFAULT 'pending',
                split VARCHAR(24) NOT NULL DEFAULT 'unassigned',
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                CONSTRAINT uq_dataset_records_project_fingerprint UNIQUE (dataset_project_id, fingerprint),
                FOREIGN KEY(dataset_project_id) REFERENCES dataset_projects (id),
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS dataset_responses (
                id VARCHAR(32) NOT NULL,
                dataset_project_id VARCHAR(32) NOT NULL,
                record_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL DEFAULT '',
                status VARCHAR(24) NOT NULL DEFAULT 'draft',
                "values" JSON NOT NULL,
                lead_time_ms INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                CONSTRAINT uq_dataset_responses_record_user UNIQUE (record_id, user_id),
                FOREIGN KEY(dataset_project_id) REFERENCES dataset_projects (id),
                FOREIGN KEY(record_id) REFERENCES dataset_records (id),
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    indexes = (
        "CREATE INDEX IF NOT EXISTS ix_dataset_projects_project_id ON dataset_projects(project_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_projects_user_id ON dataset_projects(user_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_source_rules_dataset_project_id "
        "ON dataset_source_rules(dataset_project_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_source_rules_source_project_id "
        "ON dataset_source_rules(source_project_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_source_rules_user_id ON dataset_source_rules(user_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_batches_dataset_project_id "
        "ON dataset_batches(dataset_project_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_batches_source_rule_id ON dataset_batches(source_rule_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_batches_created_at ON dataset_batches(created_at)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_records_dataset_project_id "
        "ON dataset_records(dataset_project_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_records_source_rule_id ON dataset_records(source_rule_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_records_source_type ON dataset_records(source_type)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_records_source_id ON dataset_records(source_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_records_status ON dataset_records(status)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_records_split ON dataset_records(split)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_records_fingerprint ON dataset_records(fingerprint)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_records_created_at ON dataset_records(created_at)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_responses_dataset_project_id "
        "ON dataset_responses(dataset_project_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_responses_record_id ON dataset_responses(record_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_responses_user_id ON dataset_responses(user_id)",
        "CREATE INDEX IF NOT EXISTS ix_dataset_responses_status ON dataset_responses(status)",
    )
    for stmt in indexes:
        conn.execute(text(stmt))


def _add_skill_project_columns(conn) -> None:
    if not _table_exists(conn, "skills"):
        return
    additions = {
        "project_id": "VARCHAR(32) DEFAULT ''",
        "cache_path": "VARCHAR(1024) DEFAULT ''",
        "cache_version": "INTEGER DEFAULT 0",
        "cache_updated_at": "DATETIME",
    }
    for column, ddl in additions.items():
        if not _column_exists(conn, "skills", column):
            conn.execute(text(f"ALTER TABLE skills ADD COLUMN {column} {ddl}"))


def _create_skill_release_table(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS skill_releases (
                id VARCHAR(32) PRIMARY KEY,
                namespace VARCHAR(128) DEFAULT '',
                slug VARCHAR(160) DEFAULT '',
                display_name VARCHAR(256) DEFAULT '',
                description TEXT DEFAULT '',
                version VARCHAR(64) DEFAULT '',
                visibility VARCHAR(32) DEFAULT 'private',
                storage_scope VARCHAR(16) DEFAULT 'user',
                artifact_checksum VARCHAR(96) DEFAULT '',
                artifact_path VARCHAR(1024) DEFAULT '',
                source_type VARCHAR(32) DEFAULT '',
                source_skill_id VARCHAR(32) DEFAULT '',
                publisher_user_id VARCHAR(32) DEFAULT '',
                install_spec TEXT DEFAULT '',
                manifest JSON DEFAULT '{}',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_skill_release_name_version UNIQUE (namespace, slug, version)
            )
            """
        )
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_skill_releases_namespace "
            "ON skill_releases(namespace)"
        )
    )
    conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_skill_releases_slug ON skill_releases(slug)")
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_skill_releases_visibility "
            "ON skill_releases(visibility)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_skill_releases_storage_scope "
            "ON skill_releases(storage_scope)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_skill_releases_artifact_checksum "
            "ON skill_releases(artifact_checksum)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_skill_releases_source_skill_id "
            "ON skill_releases(source_skill_id)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_skill_releases_publisher_user_id "
            "ON skill_releases(publisher_user_id)"
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_skills_project_id ON skills(project_id)"))


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
            text(
                "CREATE INDEX IF NOT EXISTS ix_native_mcp_servers_preset_id "
                "ON native_mcp_servers(preset_id)"
            )
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


def _add_native_mcp_health_columns(conn) -> None:
    if not _table_exists(conn, "native_mcp_servers"):
        return
    additions = {
        "last_probe_at": "DATETIME DEFAULT NULL",
        "last_probe_status": "VARCHAR(32) DEFAULT ''",
        "last_probe_detail": "TEXT DEFAULT ''",
        "last_golden_at": "DATETIME DEFAULT NULL",
        "last_golden_status": "VARCHAR(32) DEFAULT ''",
        "last_golden_detail": "TEXT DEFAULT ''",
        "last_tool_count": "INTEGER DEFAULT 0",
    }
    for column, ddl in additions.items():
        if not _column_exists(conn, "native_mcp_servers", column):
            conn.execute(text(f"ALTER TABLE native_mcp_servers ADD COLUMN {column} {ddl}"))


def _add_conversation_user_renamed(conn) -> None:
    if not _table_exists(conn, "conversations"):
        return
    if not _column_exists(conn, "conversations", "user_renamed"):
        conn.execute(
            text("ALTER TABLE conversations ADD COLUMN user_renamed BOOLEAN DEFAULT 0")
        )
    if not _column_exists(conn, "conversations", "is_pinned"):
        conn.execute(
            text("ALTER TABLE conversations ADD COLUMN is_pinned BOOLEAN DEFAULT 0")
        )
    if not _column_exists(conn, "conversations", "sort_index"):
        conn.execute(
            text("ALTER TABLE conversations ADD COLUMN sort_index FLOAT DEFAULT NULL")
        )


def _add_archived_at_to_annotations(conn) -> None:
    """Add `archived_at` column to annotations for sorting archived cards."""
    if not _table_exists(conn, "annotations"):
        return
    if not _column_exists(conn, "annotations", "archived_at"):
        conn.execute(
            text("ALTER TABLE annotations ADD COLUMN archived_at DATETIME DEFAULT NULL")
        )
    # Backfill: existing archived annotations get updated_at as a reasonable proxy.
    conn.execute(
        text(
            "UPDATE annotations SET archived_at = updated_at "
            "WHERE status = 'archived' AND archived_at IS NULL"
        )
    )


def _create_annotation_agent_suggestion_table(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS annotation_agent_suggestions (
                id VARCHAR(32) NOT NULL,
                project_id VARCHAR(32) NOT NULL,
                doc_id VARCHAR(32) NOT NULL,
                annotation_id VARCHAR(64) NOT NULL,
                user_id VARCHAR(32) NOT NULL DEFAULT '',
                agent_id VARCHAR(128) NOT NULL DEFAULT '',
                source_hash VARCHAR(64) NOT NULL DEFAULT '',
                status VARCHAR(24) NOT NULL DEFAULT 'drafted',
                suggestions JSON NOT NULL,
                internal_meta JSON NOT NULL,
                error TEXT NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                CONSTRAINT uq_annotation_agent_suggestions_annotation_user_agent
                    UNIQUE (annotation_id, user_id, agent_id),
                FOREIGN KEY(project_id) REFERENCES projects (id),
                FOREIGN KEY(doc_id) REFERENCES docs (id),
                FOREIGN KEY(user_id) REFERENCES users (id)
            )
            """
        )
    )
    indexes = (
        "CREATE INDEX IF NOT EXISTS ix_annotation_agent_suggestions_project_id "
        "ON annotation_agent_suggestions(project_id)",
        "CREATE INDEX IF NOT EXISTS ix_annotation_agent_suggestions_doc_id "
        "ON annotation_agent_suggestions(doc_id)",
        "CREATE INDEX IF NOT EXISTS ix_annotation_agent_suggestions_annotation_id "
        "ON annotation_agent_suggestions(annotation_id)",
        "CREATE INDEX IF NOT EXISTS ix_annotation_agent_suggestions_user_id "
        "ON annotation_agent_suggestions(user_id)",
        "CREATE INDEX IF NOT EXISTS ix_annotation_agent_suggestions_agent_id "
        "ON annotation_agent_suggestions(agent_id)",
        "CREATE INDEX IF NOT EXISTS ix_annotation_agent_suggestions_created_at "
        "ON annotation_agent_suggestions(created_at)",
    )
    for stmt in indexes:
        conn.execute(text(stmt))


def _add_project_incremental_compile_column(conn) -> None:
    if not _table_exists(conn, "projects"):
        return
    if not _column_exists(conn, "projects", "incremental_compile"):
        conn.execute(
            text("ALTER TABLE projects ADD COLUMN incremental_compile BOOLEAN DEFAULT 0")
        )
    conn.execute(
        text(
            "UPDATE projects SET incremental_compile = 0 "
            "WHERE incremental_compile IS NULL"
        )
    )
