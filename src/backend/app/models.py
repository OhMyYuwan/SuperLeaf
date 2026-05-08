"""SQLAlchemy models.

W2a 最小集：Provider（Dify/Claude 凭据配置）、CachedWorkflow（Dify workflow 列表缓存）。
后续 W2b+ 会加入 Document/Annotation/Suggestion/Risk/Operation/Discussion/Message。
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _uuid() -> str:
    return uuid4().hex


class Provider(Base):
    __tablename__ = "providers"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(128))
    # 'dify-local' | 'dify-cloud' | 'claude-direct'
    kind: Mapped[str] = mapped_column(String(32))
    # API base URL; for dify-cloud typically https://api.dify.ai/v1
    endpoint: Mapped[str] = mapped_column(String(512))
    # Encrypted API key (Fernet). Never stored in plain text.
    api_key_enc: Mapped[str] = mapped_column(Text, default="")
    # Last known status: 'unknown' | 'ok' | 'error'
    status: Mapped[str] = mapped_column(String(16), default="unknown")
    status_detail: Mapped[str] = mapped_column(Text, default="")
    # Only one provider can be active at a time (enforced in service layer).
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class CachedWorkflow(Base):
    """Mirror of Dify workflows the user has installed.

    We cache so the UI can render the team-management panel even when Dify is
    unreachable, and so we can pin an external workflow ID to our local stats.
    """

    __tablename__ = "cached_workflows"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider_id: Mapped[str] = mapped_column(ForeignKey("providers.id"))
    # Dify-side identifier
    external_id: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str] = mapped_column(Text, default="")
    # 'workflow' | 'chatflow' | 'agent'
    kind: Mapped[str] = mapped_column(String(32), default="workflow")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)


class WorkflowRun(Base):
    """Persisted record of a single workflow invocation.

    Fine-grained node-level trace lives in Dify; we just track our side of the
    conversation (which document/selection it applied to, final outputs, errors).
    """

    __tablename__ = "workflow_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    provider_id: Mapped[str] = mapped_column(ForeignKey("providers.id"))
    workflow_id: Mapped[str] = mapped_column(ForeignKey("cached_workflows.id"))
    document_id: Mapped[str] = mapped_column(String(64))
    range_start: Mapped[int] = mapped_column(Integer)
    range_end: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="running")
    # Dify run id (returned by workflow API) — useful for cross-referencing in Dify logs.
    external_run_id: Mapped[str] = mapped_column(String(128), default="")
    outputs: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
