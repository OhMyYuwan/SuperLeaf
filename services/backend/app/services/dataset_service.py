"""Dataset project ingestion, labeling, and export."""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from datetime import datetime
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..models import (
    Annotation,
    AnnotationEvaluation,
    CachedWorkflow,
    Conversation,
    DatasetBatch,
    DatasetProject,
    DatasetRecord,
    DatasetResponse,
    DatasetSourceRule,
    Doc,
    Message,
    NativeAgent,
    Project,
    User,
    WorkflowDefinition,
    WorkflowRun,
)
from .native_agent_service import NativeAgentService
from .project_member_service import ProjectMemberService

DEFAULT_DATASET_SCHEMA = {
    "version": 1,
    "fields": [
        {"name": "chat", "type": "chat", "title": "Conversation"},
        {"name": "source_text", "type": "text", "title": "Source text"},
        {"name": "agent_output", "type": "text", "title": "Agent output"},
        {"name": "trace", "type": "json", "title": "Workflow trace"},
    ],
    "questions": [
        {
            "name": "task_success",
            "type": "label",
            "title": "Task success",
            "options": ["success", "partial", "failure", "unclear"],
            "required": True,
        },
        {
            "name": "helpfulness",
            "type": "rating",
            "title": "Helpfulness",
            "min": 1,
            "max": 5,
        },
        {
            "name": "issues",
            "type": "multi_label",
            "title": "Issues",
            "options": [
                "incorrect",
                "missing_context",
                "formatting",
                "unsafe",
                "tool_error",
                "other",
            ],
        },
        {"name": "comments", "type": "text", "title": "Comments"},
        {
            "name": "training_candidate",
            "type": "label",
            "title": "Training candidate",
            "options": ["yes", "no"],
        },
    ],
}

DEFAULT_DATASET_GUIDELINES = (
    "Evaluate Agent behavior, mark issues, and flag samples that should improve "
    "Skills or Workflows."
)
DEFAULT_SOURCE_TYPES = ("annotations", "conversations", "workflow_runs")


class DatasetService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def ensure_dataset_project(self, project: Project, *, user_id: str) -> DatasetProject:
        if project.project_type != "data":
            raise ValueError("Current project is not a Data Project")
        row = (
            self.db.query(DatasetProject)
            .filter(DatasetProject.project_id == project.id)
            .first()
        )
        if row is not None:
            return row
        row = DatasetProject(
            project_id=project.id,
            user_id=project.user_id or user_id,
            name=project.name,
            guidelines=DEFAULT_DATASET_GUIDELINES,
            label_schema=DEFAULT_DATASET_SCHEMA,
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def update_dataset_project(
        self,
        dataset: DatasetProject,
        *,
        name: str | None = None,
        guidelines: str | None = None,
        label_schema: dict | None = None,
    ) -> DatasetProject:
        if name is not None:
            dataset.name = name
        if guidelines is not None:
            dataset.guidelines = guidelines
        if label_schema is not None:
            dataset.label_schema = _jsonable(label_schema)
        dataset.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(dataset)
        return dataset

    def source_filter_options(self, source_project_id: str, *, user_id: str) -> dict[str, list[dict[str, Any]]]:
        self._require_source_access(source_project_id, user_id=user_id)
        agents = (
            self.db.query(NativeAgent)
            .filter(NativeAgent.project_id == source_project_id, NativeAgent.owner_user_id == user_id)
            .order_by(NativeAgent.name.asc())
            .all()
        )
        skills = NativeAgentService(self.db).list_skills(user_id=user_id)
        workflows = (
            self.db.query(CachedWorkflow)
            .filter(CachedWorkflow.user_id == user_id)
            .order_by(CachedWorkflow.name.asc())
            .all()
        )
        definitions = (
            self.db.query(WorkflowDefinition)
            .filter(
                WorkflowDefinition.project_id == source_project_id,
                WorkflowDefinition.user_id == user_id,
                WorkflowDefinition.is_active.is_(True),
            )
            .order_by(WorkflowDefinition.name.asc())
            .all()
        )
        return {
            "agents": [
                {
                    "id": row.id,
                    "name": row.name,
                    "kind": "native-agent",
                    "filter_key": "agent_id",
                    "project_id": row.project_id,
                    "description": row.description,
                    "disabled": not row.is_enabled,
                }
                for row in agents
            ],
            "skills": [
                {
                    "id": row.id,
                    "name": row.public_name or row.name,
                    "kind": row.source or "skill",
                    "filter_key": "skill_id",
                    "project_id": row.project_id or "",
                    "description": row.description,
                    "disabled": False,
                }
                for row in skills
            ],
            "workflows": [
                {
                    "id": row.id,
                    "name": row.name,
                    "kind": row.kind or "workflow",
                    "filter_key": "workflow_id",
                    "project_id": "",
                    "description": row.description,
                    "disabled": bool(row.is_disabled),
                }
                for row in workflows
            ]
            + [
                {
                    "id": row.id,
                    "name": row.name,
                    "kind": f"definition:{row.execution_mode}",
                    "filter_key": "workflow_definition_id",
                    "project_id": row.project_id,
                    "description": row.description,
                    "disabled": False,
                }
                for row in definitions
            ],
        }

    def list_source_rules(self, dataset: DatasetProject) -> list[DatasetSourceRule]:
        return (
            self.db.query(DatasetSourceRule)
            .filter(DatasetSourceRule.dataset_project_id == dataset.id)
            .order_by(DatasetSourceRule.updated_at.desc(), DatasetSourceRule.created_at.desc())
            .all()
        )

    def get_source_rule(
        self,
        dataset: DatasetProject,
        rule_id: str,
    ) -> DatasetSourceRule | None:
        return (
            self.db.query(DatasetSourceRule)
            .filter(
                DatasetSourceRule.id == rule_id,
                DatasetSourceRule.dataset_project_id == dataset.id,
            )
            .first()
        )

    def create_source_rule(
        self,
        dataset: DatasetProject,
        *,
        source_project_id: str,
        user_id: str,
        name: str = "",
        source_types: list[str] | None = None,
        filters: dict | None = None,
        is_enabled: bool = True,
    ) -> DatasetSourceRule:
        self._require_source_access(source_project_id, user_id=user_id)
        source_project = self.db.get(Project, source_project_id)
        rule = DatasetSourceRule(
            dataset_project_id=dataset.id,
            source_project_id=source_project_id,
            user_id=user_id,
            name=name.strip() or f"{source_project.name if source_project else 'Source'} data",
            source_types=self._normalize_source_types(source_types),
            filters=self._normalize_filters(filters or {}),
            last_cursor={},
            is_enabled=bool(is_enabled),
        )
        self.db.add(rule)
        self.db.commit()
        self.db.refresh(rule)
        return rule

    def update_source_rule(
        self,
        rule: DatasetSourceRule,
        *,
        user_id: str,
        name: str | None = None,
        source_types: list[str] | None = None,
        filters: dict | None = None,
        is_enabled: bool | None = None,
    ) -> DatasetSourceRule:
        self._require_source_access(rule.source_project_id, user_id=user_id)
        if name is not None:
            rule.name = name.strip() or rule.name
        if source_types is not None:
            rule.source_types = self._normalize_source_types(source_types)
        if filters is not None:
            rule.filters = self._normalize_filters(filters)
            rule.rule_version += 1
        if is_enabled is not None:
            rule.is_enabled = bool(is_enabled)
        rule.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(rule)
        return rule

    def sync_source_rule(
        self,
        dataset: DatasetProject,
        rule: DatasetSourceRule,
        *,
        user: User,
    ) -> tuple[DatasetBatch, int, int, int]:
        if not rule.is_enabled:
            raise ValueError("Source rule is disabled")
        self._require_source_access(rule.source_project_id, user_id=user.id)

        source_types = self._normalize_source_types(rule.source_types)
        filters = self._normalize_filters(rule.filters or {})
        candidates: list[dict[str, Any]] = []
        if "annotations" in source_types:
            candidates.extend(self._annotation_candidates(rule, filters, user=user))
        if "conversations" in source_types:
            candidates.extend(self._conversation_candidates(rule, filters, user=user))
        if "workflow_runs" in source_types:
            candidates.extend(self._workflow_run_candidates(rule, filters, user=user))

        cursor_from = _jsonable(rule.last_cursor or {})
        now = datetime.utcnow()
        batch = DatasetBatch(
            dataset_project_id=dataset.id,
            source_rule_id=rule.id,
            user_id=user.id,
            cursor_from=cursor_from,
            cursor_to={"synced_at": now.isoformat()},
            counts={},
            created_at=now,
        )
        self.db.add(batch)
        self.db.flush()

        fingerprints = [item["fingerprint"] for item in candidates]
        existing: dict[str, DatasetRecord] = {}
        if fingerprints:
            existing = {
                row.fingerprint: row
                for row in self.db.query(DatasetRecord)
                .filter(
                    DatasetRecord.dataset_project_id == dataset.id,
                    DatasetRecord.fingerprint.in_(fingerprints),
                )
                .all()
            }

        created = 0
        max_created_at: datetime | None = None
        for item in candidates:
            existing_record = existing.get(item["fingerprint"])
            if existing_record is not None:
                _refresh_existing_record_source_text(existing_record, item)
                continue
            record = DatasetRecord(
                dataset_project_id=dataset.id,
                batch_id=batch.id,
                source_rule_id=rule.id,
                user_id=user.id,
                source_type=item["source_type"],
                source_id=item["source_id"],
                source_created_at=item.get("source_created_at"),
                fingerprint=item["fingerprint"],
                fields=_jsonable(item["fields"]),
                record_metadata=_jsonable(item["metadata"]),
                provenance=_jsonable(item["provenance"]),
                status="pending",
                split="unassigned",
            )
            self.db.add(record)
            existing[item["fingerprint"]] = record
            created += 1
            source_created_at = item.get("source_created_at")
            if source_created_at and (max_created_at is None or source_created_at > max_created_at):
                max_created_at = source_created_at

        skipped = len(candidates) - created
        cursor_to = {"synced_at": now.isoformat()}
        if max_created_at is not None:
            cursor_to["max_source_created_at"] = max_created_at.isoformat()
        batch.cursor_to = cursor_to
        batch.counts = {
            "scanned": len(candidates),
            "created": created,
            "skipped": skipped,
            "source_types": source_types,
        }
        rule.last_cursor = cursor_to
        rule.last_synced_at = now
        rule.updated_at = now
        self.db.commit()
        self.db.refresh(batch)
        return batch, created, skipped, len(candidates)

    def list_records(
        self,
        dataset: DatasetProject,
        *,
        status: str = "all",
        source_type: str = "all",
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[DatasetRecord], int]:
        query = self.db.query(DatasetRecord).filter(DatasetRecord.dataset_project_id == dataset.id)
        if status and status != "all":
            query = query.filter(DatasetRecord.status == status)
        if source_type and source_type != "all":
            query = query.filter(DatasetRecord.source_type == _stored_source_type(source_type))
        total = query.count()
        rows = (
            query.order_by(DatasetRecord.created_at.desc(), DatasetRecord.id.asc())
            .offset(max(offset, 0))
            .limit(max(1, min(limit, 200)))
            .all()
        )
        return rows, total

    def get_record(self, dataset: DatasetProject, record_id: str) -> DatasetRecord | None:
        return (
            self.db.query(DatasetRecord)
            .filter(DatasetRecord.id == record_id, DatasetRecord.dataset_project_id == dataset.id)
            .first()
        )

    def response_for_record(
        self,
        record: DatasetRecord,
        *,
        user_id: str,
    ) -> DatasetResponse | None:
        return (
            self.db.query(DatasetResponse)
            .filter(DatasetResponse.record_id == record.id, DatasetResponse.user_id == user_id)
            .first()
        )

    def responses_for_records(
        self,
        records: list[DatasetRecord],
        *,
        user_id: str,
    ) -> dict[str, DatasetResponse]:
        record_ids = [row.id for row in records]
        if not record_ids:
            return {}
        rows = (
            self.db.query(DatasetResponse)
            .filter(DatasetResponse.record_id.in_(record_ids), DatasetResponse.user_id == user_id)
            .all()
        )
        return {row.record_id: row for row in rows}

    def save_response(
        self,
        record: DatasetRecord,
        *,
        user_id: str,
        values: dict,
        status: str = "draft",
        lead_time_ms: int = 0,
    ) -> DatasetResponse:
        if status not in {"draft", "submitted", "discarded"}:
            raise ValueError("Invalid response status")
        response = self.response_for_record(record, user_id=user_id)
        now = datetime.utcnow()
        if response is None:
            response = DatasetResponse(
                dataset_project_id=record.dataset_project_id,
                record_id=record.id,
                user_id=user_id,
                status=status,
                values=_jsonable(values),
                lead_time_ms=max(0, lead_time_ms),
            )
            self.db.add(response)
        else:
            response.status = status
            response.values = _jsonable(values)
            response.lead_time_ms = max(0, lead_time_ms)
            response.updated_at = now
        if status == "submitted":
            record.status = "labeled"
        elif status == "discarded":
            record.status = "discarded"
        elif record.status == "pending":
            record.status = "in_review"
        record.updated_at = now
        self.db.commit()
        self.db.refresh(response)
        self.db.refresh(record)
        return response

    def discard_record(self, record: DatasetRecord, *, user_id: str) -> DatasetResponse:
        return self.save_response(
            record,
            user_id=user_id,
            values={"discarded": True},
            status="discarded",
        )

    def export_package_files(
        self,
        dataset: DatasetProject,
        *,
        user: User,
        status: str = "submitted",
    ) -> tuple[dict[str, str], dict[str, Any]]:
        records = self._export_records(dataset, user_id=user.id, status=status)
        responses = self.responses_for_records(records, user_id=user.id)
        exported_at = datetime.utcnow().isoformat()
        phoenix_payload = _phoenix_dataset_payload(
            dataset,
            records,
            responses,
            status=status,
            exported_at=exported_at,
        )
        phoenix_jsonl = "\n".join(
            json.dumps(row, ensure_ascii=False, default=str)
            for row in _phoenix_jsonl_rows(phoenix_payload)
        )
        manifest = {
            "dataset_project_id": dataset.id,
            "project_id": dataset.project_id,
            "name": dataset.name,
            "status_filter": status,
            "record_count": len(records),
            "schema": dataset.label_schema,
            "formats": {
                "superleaf": [
                    "records.jsonl",
                    "responses.jsonl",
                    "labeled_samples.jsonl",
                ],
                "phoenix": [
                    "phoenix_dataset.json",
                    "phoenix_dataset.jsonl",
                ],
            },
            "exported_at": exported_at,
        }
        records_jsonl = "\n".join(
            json.dumps(_record_payload(row), ensure_ascii=False, default=str)
            for row in records
        )
        responses_jsonl = "\n".join(
            json.dumps(_response_payload(resp), ensure_ascii=False, default=str)
            for resp in responses.values()
        )
        labeled_samples_jsonl = "\n".join(
            json.dumps(
                {
                    **_record_payload(row),
                    "response": _response_payload(responses[row.id]),
                },
                ensure_ascii=False,
                default=str,
            )
            for row in records
            if row.id in responses
        )
        files = {
            "manifest.json": json.dumps(manifest, ensure_ascii=False, indent=2, default=str) + "\n",
            "records.jsonl": records_jsonl + ("\n" if records_jsonl else ""),
            "responses.jsonl": responses_jsonl + ("\n" if responses_jsonl else ""),
            "labeled_samples.jsonl": labeled_samples_jsonl + ("\n" if labeled_samples_jsonl else ""),
            "phoenix_dataset.json": (
                json.dumps(phoenix_payload, ensure_ascii=False, indent=2, default=str) + "\n"
            ),
            "phoenix_dataset.jsonl": phoenix_jsonl + ("\n" if phoenix_jsonl else ""),
        }
        return files, manifest

    def export_zip(self, dataset: DatasetProject, *, user: User, status: str = "submitted") -> bytes:
        files, _manifest = self.export_package_files(dataset, user=user, status=status)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for path, content in files.items():
                zf.writestr(path, content)
        return buf.getvalue()

    def _export_records(
        self,
        dataset: DatasetProject,
        *,
        user_id: str,
        status: str,
    ) -> list[DatasetRecord]:
        query = self.db.query(DatasetRecord).filter(DatasetRecord.dataset_project_id == dataset.id)
        if status == "all":
            pass
        elif status in {"pending", "in_review", "labeled", "discarded"}:
            query = query.filter(DatasetRecord.status == status)
        else:
            submitted_ids = select(DatasetResponse.record_id).where(
                DatasetResponse.dataset_project_id == dataset.id,
                DatasetResponse.user_id == user_id,
                DatasetResponse.status == "submitted",
            )
            query = query.filter(DatasetRecord.id.in_(submitted_ids))
        return query.order_by(DatasetRecord.created_at.asc()).all()

    def _annotation_candidates(
        self,
        rule: DatasetSourceRule,
        filters: dict,
        *,
        user: User,
    ) -> list[dict[str, Any]]:
        query = (
            self.db.query(Annotation)
            .filter(Annotation.project_id == rule.source_project_id)
            .filter(or_(Annotation.is_global.is_(True), Annotation.user_id == user.id))
            .order_by(Annotation.created_at.asc())
        )
        rows = query.all()
        out: list[dict[str, Any]] = []
        for row in rows:
            evaluations = self._annotation_evaluations(row, user_id=user.id)
            skill_ids = self._skill_ids_from_workflow_id(
                row.workflow_id,
                project_id=rule.source_project_id,
                user_id=user.id,
            )
            agent_ids = self._agent_ids_from_workflow_id(
                row.workflow_id,
                project_id=rule.source_project_id,
                user_id=user.id,
            )
            if not self._matches_filters(
                filters,
                source_status=row.status,
                workflow_id=row.workflow_id,
                agent_ids=agent_ids,
                skill_ids=skill_ids,
                evaluations=evaluations,
            ):
                continue
            doc = self.db.get(Doc, row.doc_id)
            fields = {
                "chat": _thread_as_chat(row.thread),
                "source_text": row.target_text or row.original,
                "agent_output": row.proposed or row.mitigation or row.content,
                "trace": [],
            }
            metadata = {
                "kind": row.kind,
                "status": row.status,
                "severity": row.severity,
                "doc_id": row.doc_id,
                "doc_name": doc.name if doc is not None else "",
                "range": {"from": row.range_from, "to": row.range_to},
                "agent_name": row.agent_name,
                "workflow_id": row.workflow_id,
                "conversation_id": row.conversation_id,
                "evaluations": [_evaluation_payload(e) for e in evaluations],
            }
            provenance = {
                "source_project_id": row.project_id,
                "source_type": "annotation",
                "source_id": row.id,
                "workflow_id": row.workflow_id,
                "agent_ids": agent_ids,
                "agent_name": row.agent_name,
                "skill_ids": skill_ids,
                "rule_id": rule.id,
            }
            out.append(_candidate("annotation", row.id, row.created_at, fields, metadata, provenance))
        return out

    def _conversation_candidates(
        self,
        rule: DatasetSourceRule,
        filters: dict,
        *,
        user: User,
    ) -> list[dict[str, Any]]:
        rows = (
            self.db.query(Conversation)
            .filter(Conversation.project_id == rule.source_project_id, Conversation.user_id == user.id)
            .order_by(Conversation.created_at.asc())
            .all()
        )
        out: list[dict[str, Any]] = []
        for row in rows:
            skill_ids = self._skill_ids_from_workflow_id(
                row.workflow_id,
                project_id=rule.source_project_id,
                user_id=user.id,
            )
            agent_ids = self._agent_ids_from_workflow_id(
                row.workflow_id,
                project_id=rule.source_project_id,
                user_id=user.id,
            )
            if not self._matches_filters(
                filters,
                workflow_id=row.workflow_id,
                agent_ids=agent_ids,
                skill_ids=skill_ids,
            ):
                continue
            messages = (
                self.db.query(Message)
                .filter(Message.conversation_id == row.id)
                .order_by(Message.created_at.asc())
                .all()
            )
            chat = [
                {
                    "id": msg.id,
                    "role": msg.role,
                    "content": msg.content,
                    "created_at": msg.created_at.isoformat(),
                }
                for msg in messages
            ]
            fields = {
                "chat": chat,
                "source_text": next((msg.content for msg in messages if msg.role == "user"), ""),
                "agent_output": next((msg.content for msg in reversed(messages) if msg.role == "agent"), ""),
                "trace": [],
            }
            metadata = {
                "title": row.title,
                "workflow_id": row.workflow_id,
                "document_id": row.document_id,
                "message_count": len(messages),
            }
            provenance = {
                "source_project_id": row.project_id,
                "source_type": "conversation",
                "source_id": row.id,
                "workflow_id": row.workflow_id,
                "agent_ids": agent_ids,
                "skill_ids": skill_ids,
                "rule_id": rule.id,
            }
            out.append(_candidate("conversation", row.id, row.created_at, fields, metadata, provenance))
        return out

    def _workflow_run_candidates(
        self,
        rule: DatasetSourceRule,
        filters: dict,
        *,
        user: User,
    ) -> list[dict[str, Any]]:
        rows = (
            self.db.query(WorkflowRun)
            .filter(WorkflowRun.project_id == rule.source_project_id, WorkflowRun.user_id == user.id)
            .order_by(WorkflowRun.started_at.asc())
            .all()
        )
        out: list[dict[str, Any]] = []
        for row in rows:
            skill_ids = self._skill_ids_from_trace(
                row.trace,
                project_id=rule.source_project_id,
                user_id=user.id,
            )
            skill_ids.update(
                self._skill_ids_from_workflow_id(
                    row.workflow_id,
                    project_id=rule.source_project_id,
                    user_id=user.id,
                )
            )
            agent_ids = self._agent_ids_from_trace(
                row.trace,
                project_id=rule.source_project_id,
                user_id=user.id,
            )
            agent_ids.update(
                self._agent_ids_from_workflow_id(
                    row.workflow_id,
                    project_id=rule.source_project_id,
                    user_id=user.id,
                )
            )
            if not self._matches_filters(
                filters,
                source_status=row.status,
                workflow_id=row.workflow_id,
                workflow_definition_id=row.workflow_definition_id or "",
                agent_ids=sorted(agent_ids),
                skill_ids=sorted(skill_ids),
            ):
                continue
            doc = self.db.get(Doc, row.document_id)
            source_text = row.source_text or _source_text_from_workflow_run_trace(row.trace)
            fields = {
                "chat": _trace_as_chat(row.trace),
                "source_text": source_text,
                "agent_output": json.dumps(row.outputs or {}, ensure_ascii=False, default=str),
                "trace": _jsonable(row.trace or []),
            }
            metadata = {
                "status": row.status,
                "workflow_id": row.workflow_id,
                "workflow_definition_id": row.workflow_definition_id,
                "document_id": row.document_id,
                "document_name": doc.name if doc is not None else "",
                "range": {"from": row.range_start, "to": row.range_end},
                "external_run_id": row.external_run_id,
                "error": row.error,
            }
            provenance = {
                "source_project_id": row.project_id,
                "source_type": "workflow_run",
                "source_id": row.id,
                "workflow_id": row.workflow_id,
                "workflow_definition_id": row.workflow_definition_id,
                "agent_ids": sorted(agent_ids),
                "skill_ids": sorted(skill_ids),
                "rule_id": rule.id,
            }
            out.append(_candidate("workflow_run", row.id, row.started_at, fields, metadata, provenance))
        return out

    def _annotation_evaluations(self, row: Annotation, *, user_id: str) -> list[AnnotationEvaluation]:
        return (
            self.db.query(AnnotationEvaluation)
            .filter(AnnotationEvaluation.annotation_id == row.id, AnnotationEvaluation.user_id == user_id)
            .order_by(AnnotationEvaluation.created_at.desc())
            .all()
        )

    def _matches_filters(
        self,
        filters: dict,
        *,
        source_status: str = "",
        workflow_id: str = "",
        workflow_definition_id: str = "",
        agent_ids: list[str] | set[str] | None = None,
        skill_ids: list[str] | set[str] | None = None,
        evaluations: list[AnnotationEvaluation] | None = None,
    ) -> bool:
        if filters.get("status") and source_status and source_status != filters["status"]:
            return False
        if filters.get("workflow_id") and workflow_id != filters["workflow_id"]:
            return False
        if filters.get("workflow_definition_id") and workflow_definition_id != filters["workflow_definition_id"]:
            return False
        expected_agent = str(filters.get("agent_id") or "").strip()
        if expected_agent:
            ids = set(agent_ids or [])
            if expected_agent not in ids:
                return False
        expected_skill = str(filters.get("skill_id") or "").strip()
        if expected_skill and expected_skill not in set(skill_ids or []):
            return False
        verdict = str(filters.get("verdict") or "").strip()
        if verdict:
            if not evaluations or verdict not in {row.verdict for row in evaluations}:
                return False
        if filters.get("only_training_candidates"):
            if not evaluations or not any(row.training_candidate for row in evaluations):
                return False
        return True

    def _normalize_source_types(self, source_types: list[str] | None) -> list[str]:
        allowed = set(DEFAULT_SOURCE_TYPES)
        normalized = [item for item in (source_types or list(DEFAULT_SOURCE_TYPES)) if item in allowed]
        return normalized or list(DEFAULT_SOURCE_TYPES)

    def _normalize_filters(self, filters: dict) -> dict:
        out = {}
        for key, value in (filters or {}).items():
            if value is None or value == "":
                continue
            out[str(key)] = _jsonable(value)
        return out

    def _require_source_access(self, project_id: str, *, user_id: str) -> None:
        if not ProjectMemberService(self.db).has_access(project_id, user_id):
            raise ValueError("Source project not found")

    def _agent_ids_from_workflow_id(
        self,
        workflow_id: str,
        *,
        project_id: str,
        user_id: str,
    ) -> list[str]:
        workflow_id = str(workflow_id or "").strip()
        if not workflow_id:
            return []
        if workflow_id.startswith("native:"):
            agent_id = workflow_id.split(":", 1)[1]
            agent = self._scoped_native_agent(agent_id, project_id=project_id, user_id=user_id)
            return [agent.id] if agent is not None else []
        cached = self.db.get(CachedWorkflow, workflow_id)
        if cached is None or cached.user_id != user_id:
            return []
        return [workflow_id]

    def _skill_ids_from_workflow_id(
        self,
        workflow_id: str,
        *,
        project_id: str,
        user_id: str,
    ) -> list[str]:
        workflow_id = str(workflow_id or "").strip()
        if not workflow_id.startswith("native:"):
            return []
        agent_id = workflow_id.split(":", 1)[1]
        agent = self._scoped_native_agent(agent_id, project_id=project_id, user_id=user_id)
        if agent is None:
            return []
        return sorted(self._scoped_skill_ids(agent.skill_ids or [], user_id=user_id))

    def _scoped_native_agent(
        self,
        agent_id: str,
        *,
        project_id: str,
        user_id: str,
    ) -> NativeAgent | None:
        agent = self.db.get(NativeAgent, agent_id)
        if agent is None or agent.project_id != project_id or agent.owner_user_id != user_id:
            return None
        return agent

    def _agent_ids_from_trace(
        self,
        trace: list | None,
        *,
        project_id: str,
        user_id: str,
    ) -> set[str]:
        ids: set[str] = set()
        for node in trace or []:
            if not isinstance(node, dict):
                continue
            for key in ("agentId", "agent_id", "agent"):
                value = str(node.get(key) or "").strip()
                scoped = self._scoped_agent_id_from_trace_ref(
                    value,
                    project_id=project_id,
                    user_id=user_id,
                )
                if scoped:
                    ids.add(scoped)
        return ids

    def _skill_ids_from_trace(
        self,
        trace: list | None,
        *,
        project_id: str,
        user_id: str,
    ) -> set[str]:
        ids: set[str] = set()
        for node in trace or []:
            if not isinstance(node, dict):
                continue
            for key in ("skill_ids", "skillIds", "skills"):
                raw = node.get(key)
                if isinstance(raw, list):
                    ids.update(self._scoped_skill_ids(raw, user_id=user_id))
                elif isinstance(raw, str) and raw:
                    ids.update(self._scoped_skill_ids([raw], user_id=user_id))
            agent_id = str(node.get("agentId") or node.get("agent_id") or "").strip()
            if agent_id:
                agent = self._native_agent_from_trace_ref(
                    agent_id,
                    project_id=project_id,
                    user_id=user_id,
                )
                if agent is not None:
                    ids.update(self._scoped_skill_ids(agent.skill_ids or [], user_id=user_id))
        return ids

    def _scoped_agent_id_from_trace_ref(
        self,
        agent_ref: str,
        *,
        project_id: str,
        user_id: str,
    ) -> str:
        native_agent = self._native_agent_from_trace_ref(
            agent_ref,
            project_id=project_id,
            user_id=user_id,
        )
        if native_agent is not None:
            return native_agent.id
        ref = str(agent_ref or "").strip()
        if not ref or ref.startswith("native:"):
            return ""
        cached = self.db.get(CachedWorkflow, ref)
        if cached is None or cached.user_id != user_id:
            return ""
        return cached.id

    def _native_agent_from_trace_ref(
        self,
        agent_ref: str,
        *,
        project_id: str,
        user_id: str,
    ) -> NativeAgent | None:
        ref = str(agent_ref or "").strip()
        if not ref:
            return None
        agent_id = ref.split(":", 1)[1] if ref.startswith("native:") else ref
        return self._scoped_native_agent(agent_id, project_id=project_id, user_id=user_id)

    def _scoped_skill_ids(self, skill_ids: list | set | tuple, *, user_id: str) -> set[str]:
        svc = NativeAgentService(self.db)
        out: set[str] = set()
        for item in skill_ids:
            skill_id = str(item or "").strip()
            if not skill_id:
                continue
            if svc.get_skill(skill_id, user_id=user_id) is not None:
                out.add(skill_id)
        return out


def _candidate(
    source_type: str,
    source_id: str,
    source_created_at: datetime | None,
    fields: dict,
    metadata: dict,
    provenance: dict,
) -> dict[str, Any]:
    source_project_id = provenance.get("source_project_id", "")
    fingerprint = hashlib.sha256(
        f"{source_project_id}:{source_type}:{source_id}".encode()
    ).hexdigest()
    return {
        "source_type": source_type,
        "source_id": source_id,
        "source_created_at": source_created_at,
        "fingerprint": fingerprint,
        "fields": fields,
        "metadata": metadata,
        "provenance": provenance,
    }


def _stored_source_type(source_type: str) -> str:
    return {
        "annotations": "annotation",
        "conversations": "conversation",
        "workflow_runs": "workflow_run",
    }.get(source_type, source_type)


def _thread_as_chat(thread: list | None) -> list[dict]:
    chat = []
    for item in thread or []:
        if not isinstance(item, dict):
            continue
        chat.append(
            {
                "id": item.get("id", ""),
                "role": item.get("role", ""),
                "content": item.get("content", ""),
                "created_at": item.get("created_at", ""),
                "agent_id": item.get("agent_id", ""),
                "agent_name": item.get("agent_name", ""),
            }
        )
    return chat


def _trace_as_chat(trace: list | None) -> list[dict]:
    chat = []
    for node in trace or []:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("nodeId") or node.get("node_id") or node.get("id") or "")
        if node.get("input") not in (None, ""):
            chat.append({"id": f"{node_id}:input", "role": "user", "content": _textify(node.get("input"))})
        if node.get("output") not in (None, ""):
            chat.append({"id": f"{node_id}:output", "role": "agent", "content": _textify(node.get("output"))})
    return chat


def _refresh_existing_record_source_text(record: DatasetRecord, candidate: dict[str, Any]) -> bool:
    fields = dict(record.fields or {})
    next_source = (candidate.get("fields") or {}).get("source_text")
    if not isinstance(next_source, str) or not next_source.strip():
        return False

    current_source = fields.get("source_text")
    if (
        isinstance(current_source, str)
        and current_source.strip()
        and not _looks_like_source_pointer(current_source)
    ):
        return False
    if isinstance(current_source, dict) and not _looks_like_source_pointer(current_source):
        return False
    if current_source == next_source:
        return False

    fields["source_text"] = next_source
    record.fields = _jsonable(fields)
    record.updated_at = datetime.utcnow()
    return True


def _looks_like_source_pointer(value: Any) -> bool:
    return _source_text_pointer(value) is not None


def _source_text_pointer(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, dict):
        return None
    if not {"document_id", "range_start", "range_end"}.issubset(value.keys()):
        return None
    return value


def _source_text_from_workflow_run_trace(trace: list | None) -> str:
    for node in trace or []:
        source_text = _source_text_from_trace_value(node)
        if source_text:
            return source_text
    return ""


def _source_text_from_trace_value(value: Any) -> str:
    if isinstance(value, list):
        for item in value:
            source_text = _source_text_from_trace_value(item)
            if source_text:
                return source_text
        return ""
    if not isinstance(value, dict):
        return ""

    for key in ("source_text", "target_text", "text", "selected_text", "selection_text"):
        item = value.get(key)
        if isinstance(item, str) and item.strip() and not _looks_like_source_pointer(item):
            return item

    for key in ("request", "inputs", "input"):
        source_text = _source_text_from_trace_value(value.get(key))
        if source_text:
            return source_text

    if value.get("node_type") == "input":
        source_text = _source_text_from_trace_value(value.get("output"))
        if source_text:
            return source_text
    return ""


def _evaluation_payload(row: AnnotationEvaluation) -> dict:
    return {
        "id": row.id,
        "verdict": row.verdict,
        "reason": row.reason,
        "tags": row.tags,
        "adoption": row.adoption,
        "training_candidate": row.training_candidate,
        "context": row.context,
        "created_at": row.created_at.isoformat(),
    }


def _record_payload(row: DatasetRecord) -> dict:
    return {
        "id": row.id,
        "source_type": row.source_type,
        "source_id": row.source_id,
        "source_created_at": row.source_created_at.isoformat() if row.source_created_at else None,
        "fingerprint": row.fingerprint,
        "fields": row.fields,
        "metadata": row.record_metadata,
        "provenance": row.provenance,
        "status": row.status,
        "split": row.split,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _response_payload(row: DatasetResponse) -> dict:
    return {
        "id": row.id,
        "record_id": row.record_id,
        "status": row.status,
        "values": row.values,
        "lead_time_ms": row.lead_time_ms,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _phoenix_dataset_payload(
    dataset: DatasetProject,
    records: list[DatasetRecord],
    responses: dict[str, DatasetResponse],
    *,
    status: str,
    exported_at: str,
) -> dict[str, Any]:
    inputs: list[dict[str, Any]] = []
    outputs: list[dict[str, Any]] = []
    metadata: list[dict[str, Any]] = []
    splits: list[list[str] | None] = []
    example_ids: list[str] = []

    for row in records:
        response = responses.get(row.id)
        labels = _phoenix_labels(row, response)
        input_payload = _phoenix_input(row)
        output_payload = _phoenix_output(row)
        metadata_payload = _phoenix_metadata(row, response, labels)

        inputs.append(input_payload)
        outputs.append(output_payload)
        metadata.append(metadata_payload)
        row_splits = _phoenix_splits(row)
        splits.append(row_splits or None)
        example_ids.append(_phoenix_example_id(row))

    return {
        "action": "create",
        "name": dataset.name or f"Data Project {dataset.id}",
        "description": (
            "SuperLeaf Data Project export for Phoenix datasets. "
            f"dataset_project_id={dataset.id}; status_filter={status}; exported_at={exported_at}"
        ),
        "inputs": inputs,
        "outputs": outputs,
        "metadata": metadata,
        "splits": splits,
        "example_ids": example_ids,
    }


def _phoenix_jsonl_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), list) else []
    outputs = payload.get("outputs") if isinstance(payload.get("outputs"), list) else []
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), list) else []
    splits = payload.get("splits") if isinstance(payload.get("splits"), list) else []
    example_ids = payload.get("example_ids") if isinstance(payload.get("example_ids"), list) else []
    for idx, input_payload in enumerate(inputs):
        split_value = splits[idx] if idx < len(splits) else None
        rows.append(
            {
                "id": example_ids[idx] if idx < len(example_ids) else str(idx),
                "input": input_payload,
                "output": outputs[idx] if idx < len(outputs) else {},
                "metadata": metadata[idx] if idx < len(metadata) else {},
                "splits": split_value if isinstance(split_value, list) else [],
            }
        )
    return rows


def _phoenix_input(row: DatasetRecord) -> dict[str, Any]:
    fields = row.fields or {}
    chat = _normalize_chat_messages(fields.get("chat"))
    source_text = fields.get("source_text")
    trace = fields.get("trace")
    out: dict[str, Any] = {
        "messages": _phoenix_prompt_messages(chat, source_text),
    }
    if source_text not in (None, ""):
        out["source_text"] = source_text
    if chat:
        out["chat"] = chat
    if trace not in (None, ""):
        out["trace"] = _jsonable(trace)
    extra = {
        key: _jsonable(value)
        for key, value in fields.items()
        if key not in {"chat", "source_text", "agent_output", "trace"}
    }
    if extra:
        out["extra_fields"] = extra
    return out


def _phoenix_output(row: DatasetRecord) -> dict[str, Any]:
    fields = row.fields or {}
    agent_output = fields.get("agent_output")
    if agent_output in (None, ""):
        return {}
    return {
        "messages": [
            {
                "role": "assistant",
                "content": _textify(agent_output),
            }
        ],
        "agent_output": _jsonable(agent_output),
    }


def _phoenix_metadata(
    row: DatasetRecord,
    response: DatasetResponse | None,
    labels: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "record_id": row.id,
        "source_type": row.source_type,
        "source_id": row.source_id,
        "source_created_at": row.source_created_at.isoformat() if row.source_created_at else None,
        "fingerprint": row.fingerprint,
        "status": row.status,
        "split": row.split,
        "reference_kind": _phoenix_reference_kind(response, labels),
        "record_metadata": _jsonable(row.record_metadata or {}),
        "provenance": _jsonable(row.provenance or {}),
        "labels": labels,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _phoenix_labels(
    row: DatasetRecord,
    response: DatasetResponse | None,
) -> list[dict[str, Any]]:
    labels: list[dict[str, Any]] = []
    metadata = row.record_metadata or {}
    evaluations = metadata.get("evaluations")
    if isinstance(evaluations, list):
        for evaluation in evaluations:
            if not isinstance(evaluation, dict):
                continue
            labels.append(
                {
                    "source_kind": "annotation_evaluation",
                    "source_id": str(evaluation.get("id") or ""),
                    "name": "human_verdict",
                    "label": evaluation.get("verdict"),
                    "score": _phoenix_verdict_score(evaluation.get("verdict")),
                    "explanation": evaluation.get("reason"),
                    "tags": _jsonable(evaluation.get("tags") or []),
                    "adoption": evaluation.get("adoption"),
                    "training_candidate": bool(evaluation.get("training_candidate")),
                    "context": _jsonable(evaluation.get("context") or {}),
                    "created_at": evaluation.get("created_at"),
                }
            )
    if response is not None:
        labels.append(
            {
                "source_kind": "dataset_response",
                "source_id": response.id,
                "name": "dataset_response",
                "label": response.status,
                "status": response.status,
                "values": _jsonable(response.values or {}),
                "lead_time_ms": response.lead_time_ms,
                "created_at": response.created_at.isoformat(),
                "updated_at": response.updated_at.isoformat(),
            }
        )
    return labels


def _phoenix_prompt_messages(
    chat: list[dict[str, str]],
    source_text: Any,
) -> list[dict[str, str]]:
    messages = [
        {"role": row["role"], "content": row["content"]}
        for row in chat
        if row.get("role") in {"system", "developer", "user"}
    ]
    if messages:
        return messages
    if source_text not in (None, ""):
        return [{"role": "user", "content": _textify(source_text)}]
    return []


def _normalize_chat_messages(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if content in (None, ""):
            continue
        role = str(item.get("role") or "user").strip().lower()
        if role in {"agent", "ai", "assistant_message"}:
            role = "assistant"
        elif role not in {"system", "developer", "user", "assistant", "tool"}:
            role = "user"
        out.append({"role": role, "content": _textify(content)})
    return out


def _phoenix_splits(row: DatasetRecord) -> list[str]:
    split = str(row.split or "").strip()
    if not split or split == "unassigned":
        return []
    return [split]


def _phoenix_example_id(row: DatasetRecord) -> str:
    source_type = str(row.source_type or "").strip()
    source_id = str(row.source_id or "").strip()
    if source_type and source_id:
        return f"{source_type}:{source_id}"
    return f"record:{row.id}"


def _phoenix_reference_kind(
    response: DatasetResponse | None,
    labels: list[dict[str, Any]],
) -> str:
    if response is not None and response.status == "submitted":
        values = response.values or {}
        if _truthy_training_candidate(values.get("training_candidate")):
            return "human_approved"
        if str(values.get("task_success") or "").lower() == "success":
            return "human_approved"
        return "human_labeled"
    for label in labels:
        if (
            label.get("source_kind") == "annotation_evaluation"
            and label.get("label") == "positive"
            and (
                label.get("training_candidate") is True
                or str(label.get("adoption") or "").lower() in {"accepted", "adopted"}
            )
        ):
            return "human_approved"
    if labels:
        return "human_labeled"
    return "baseline"


def _truthy_training_candidate(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"yes", "true", "1", "candidate"}


def _phoenix_verdict_score(value: Any) -> float | None:
    verdict = str(value or "").strip().lower()
    if verdict == "positive":
        return 1.0
    if verdict == "negative":
        return 0.0
    return None


def _jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def _textify(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)
