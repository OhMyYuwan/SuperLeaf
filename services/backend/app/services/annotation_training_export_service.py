"""Project-level annotation training data export.

The export format is intentionally privacy-preserving: one JSONL row per user
evaluation, line-level source context for the annotated range, and no full
document content in the package.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..models import (
    Annotation,
    AnnotationEvaluation,
    AnnotationReviewState,
    Doc,
    Project,
    User,
)
from .annotation_service import list_by_doc
from .evaluation_service import list_evaluations_by_doc, list_review_states_by_doc


SCHEMA_VERSION = "annotation-training-export.v2"


def build_annotation_training_export_zip(
    db: Session,
    *,
    project: Project,
    user: User,
    only_training_candidates: bool = False,
) -> bytes:
    exported_at = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    docs = (
        db.query(Doc)
        .filter(Doc.project_id == project.id)
        .order_by(Doc.name.asc(), Doc.id.asc())
        .all()
    )
    docs_by_id = {doc.id: doc for doc in docs}

    annotations_by_id: dict[str, Annotation] = {}
    review_by_annotation: dict[str, AnnotationReviewState] = {}
    evaluations: list[AnnotationEvaluation] = []

    for doc in docs:
        for annotation in list_by_doc(db, doc.id, user_id=user.id):
            annotations_by_id[annotation.id] = annotation
        for review_state in list_review_states_by_doc(db, doc.id, user_id=user.id):
            review_by_annotation[review_state.annotation_id] = review_state
        evaluations.extend(list_evaluations_by_doc(db, doc.id, user_id=user.id))

    records: list[dict[str, Any]] = []
    used_doc_ids: set[str] = set()
    skipped_missing_annotation = 0
    skipped_missing_doc = 0

    for evaluation in evaluations:
        if only_training_candidates and not evaluation.training_candidate:
            continue
        annotation = annotations_by_id.get(evaluation.annotation_id)
        if annotation is None:
            skipped_missing_annotation += 1
            continue
        doc = docs_by_id.get(evaluation.doc_id)
        if doc is None:
            skipped_missing_doc += 1
            continue
        used_doc_ids.add(doc.id)
        records.append(_record_for(annotation, evaluation, review_by_annotation.get(annotation.id), doc, project))

    documents = [_document_payload(docs_by_id[doc_id]) for doc_id in sorted(used_doc_ids)]
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "project": {
            "id": project.id,
            "name": project.name,
        },
        "exported_at": exported_at,
        "exported_by": {
            "id": user.id,
            "email": user.email,
            "display_name": user.display_name or user.email,
        },
        "parameters": {
            "only_training_candidates": only_training_candidates,
            "context_mode": "current_line_only",
        },
        "formats": {
            "superleaf": [
                "records.jsonl",
                "documents.json",
            ],
            "phoenix": [
                "phoenix_dataset.json",
                "phoenix_dataset.jsonl",
            ],
        },
        "counts": {
            "records": len(records),
            "documents": len(documents),
            "training_candidate_records": sum(1 for r in records if r["is_training_candidate"]),
            "skipped_missing_annotation": skipped_missing_annotation,
            "skipped_missing_doc": skipped_missing_doc,
        },
    }
    phoenix_payload = _phoenix_dataset_payload(
        project,
        records,
        only_training_candidates=only_training_candidates,
        exported_at=exported_at,
    )
    phoenix_jsonl = "\n".join(_json_line(row) for row in _phoenix_jsonl_rows(phoenix_payload))

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", _json(manifest))
        zf.writestr("documents.json", _json(documents))
        zf.writestr("records.jsonl", "\n".join(_json_line(record) for record in records) + ("\n" if records else ""))
        zf.writestr("phoenix_dataset.json", _json(phoenix_payload))
        zf.writestr("phoenix_dataset.jsonl", phoenix_jsonl + ("\n" if phoenix_jsonl else ""))
        zf.writestr("agent_prompt.md", _agent_prompt(project.name))
        zf.writestr("README.md", _export_readme())
    return out.getvalue()


def _record_for(
    annotation: Annotation,
    evaluation: AnnotationEvaluation,
    review_state: AnnotationReviewState | None,
    doc: Doc,
    project: Project,
) -> dict[str, Any]:
    section = _find_section(doc.content, doc.format, annotation.range_from)
    line_context = _line_context_for_range(
        doc.content,
        annotation.range_from,
        annotation.range_to,
    )
    return {
        "record_id": f"{annotation.id}:{evaluation.id}",
        "schema_version": SCHEMA_VERSION,
        "project_id": project.id,
        "doc_id": doc.id,
        "annotation_id": annotation.id,
        "evaluation_id": evaluation.id,
        "is_training_candidate": bool(evaluation.training_candidate),
        "annotation": {
            "id": annotation.id,
            "kind": annotation.kind,
            "status": annotation.status,
            "severity": annotation.severity,
            "range_from": annotation.range_from,
            "range_to": annotation.range_to,
            "target_text": annotation.target_text,
            "content": annotation.content,
            "workflow_id": annotation.workflow_id,
            "agent_name": annotation.agent_name,
            "conversation_id": annotation.conversation_id,
            "suggestion": {
                "original": annotation.original,
                "proposed": annotation.proposed,
                "reason": annotation.reason,
            },
            "risk": {
                "risk_type": annotation.risk_type,
                "mitigation": annotation.mitigation,
            },
            "thread": annotation.thread or [],
            "attached_files": annotation.attached_files or [],
            "created_at": annotation.created_at.isoformat() if annotation.created_at else None,
            "updated_at": annotation.updated_at.isoformat() if annotation.updated_at else None,
        },
        "evaluation": {
            "id": evaluation.id,
            "target_type": evaluation.target_type,
            "target_id": evaluation.target_id,
            "verdict": evaluation.verdict,
            "reason": evaluation.reason,
            "tags": evaluation.tags or [],
            "adoption": evaluation.adoption,
            "training_candidate": bool(evaluation.training_candidate),
            "context": evaluation.context or {},
            "created_at": evaluation.created_at.isoformat() if evaluation.created_at else None,
            "updated_at": evaluation.updated_at.isoformat() if evaluation.updated_at else None,
        },
        "review_status": review_state.status if review_state else "open",
        "context": {
            "doc_id": doc.id,
            "doc_name": doc.name,
            "doc_format": doc.format,
            "doc_hash": _sha256_text(doc.content),
            "range_from": annotation.range_from,
            "range_to": annotation.range_to,
            "target_text": annotation.target_text,
            "section": section,
            **line_context,
        },
        "wiki_hints": {
            "tags": evaluation.tags or [],
            "verdict": evaluation.verdict,
            "adoption": evaluation.adoption,
            "agent_name": annotation.agent_name,
            "section": section,
        },
    }


def _document_payload(doc: Doc) -> dict[str, Any]:
    return {
        "id": doc.id,
        "name": doc.name,
        "format": doc.format,
        "version": doc.version,
        "hash": _sha256_text(doc.content),
        "content_omitted": True,
        "context_mode": "current_line_only",
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
    }


def _phoenix_dataset_payload(
    project: Project,
    records: list[dict[str, Any]],
    *,
    only_training_candidates: bool,
    exported_at: str,
) -> dict[str, Any]:
    inputs: list[dict[str, Any]] = []
    outputs: list[dict[str, Any]] = []
    metadata: list[dict[str, Any]] = []
    splits: list[list[str] | None] = []
    example_ids: list[str] = []

    for record in records:
        inputs.append(_phoenix_input(record))
        outputs.append(_phoenix_output(record))
        metadata.append(_phoenix_metadata(record))
        row_splits = _phoenix_splits(record)
        splits.append(row_splits or None)
        example_ids.append(str(record["record_id"]))

    return {
        "action": "create",
        "name": f"{project.name or 'Project'} Annotation Training",
        "description": (
            "SuperLeaf annotation training export for Phoenix datasets. "
            f"project_id={project.id}; only_training_candidates={only_training_candidates}; "
            f"exported_at={exported_at}"
        ),
        "inputs": inputs,
        "outputs": outputs,
        "metadata": metadata,
        "splits": splits,
        "example_ids": example_ids,
    }


def _phoenix_jsonl_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), list) else []
    outputs = payload.get("outputs") if isinstance(payload.get("outputs"), list) else []
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), list) else []
    splits = payload.get("splits") if isinstance(payload.get("splits"), list) else []
    example_ids = payload.get("example_ids") if isinstance(payload.get("example_ids"), list) else []
    rows: list[dict[str, Any]] = []
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


def _phoenix_input(record: dict[str, Any]) -> dict[str, Any]:
    annotation = record.get("annotation") if isinstance(record.get("annotation"), dict) else {}
    context = record.get("context") if isinstance(record.get("context"), dict) else {}
    thread = annotation.get("thread") if isinstance(annotation.get("thread"), list) else []
    messages = _thread_messages(thread)
    source_text = annotation.get("target_text") or context.get("target_text") or ""
    prompt_messages = messages or ([{"role": "user", "content": _textify(source_text)}] if source_text else [])
    out: dict[str, Any] = {
        "messages": prompt_messages,
        "source_text": source_text,
        "current_line_content": context.get("current_line_content") or "",
        "section": context.get("section"),
        "annotation": {
            "kind": annotation.get("kind") or "",
            "severity": annotation.get("severity") or "",
            "status": annotation.get("status") or "",
            "target_text": source_text,
        },
    }
    return out


def _phoenix_output(record: dict[str, Any]) -> dict[str, Any]:
    output_text = _annotation_output(record)
    if not output_text:
        return {}
    return {
        "messages": [{"role": "assistant", "content": output_text}],
        "agent_output": output_text,
    }


def _phoenix_metadata(record: dict[str, Any]) -> dict[str, Any]:
    annotation = record.get("annotation") if isinstance(record.get("annotation"), dict) else {}
    evaluation = record.get("evaluation") if isinstance(record.get("evaluation"), dict) else {}
    context = record.get("context") if isinstance(record.get("context"), dict) else {}
    label = {
        "source_kind": "annotation_evaluation",
        "source_id": evaluation.get("id") or "",
        "name": "human_verdict",
        "label": evaluation.get("verdict"),
        "score": _verdict_score(evaluation.get("verdict")),
        "explanation": evaluation.get("reason") or "",
        "tags": evaluation.get("tags") or [],
        "adoption": evaluation.get("adoption") or "",
        "training_candidate": bool(evaluation.get("training_candidate")),
        "context": evaluation.get("context") or {},
        "created_at": evaluation.get("created_at"),
        "updated_at": evaluation.get("updated_at"),
    }
    return {
        "record_id": record.get("record_id") or "",
        "source_type": "annotation_evaluation",
        "source_id": evaluation.get("id") or "",
        "project_id": record.get("project_id") or "",
        "doc_id": record.get("doc_id") or "",
        "annotation_id": annotation.get("id") or record.get("annotation_id") or "",
        "evaluation_id": evaluation.get("id") or record.get("evaluation_id") or "",
        "reference_kind": _reference_kind(record),
        "review_status": record.get("review_status") or "open",
        "annotation": {
            "kind": annotation.get("kind") or "",
            "status": annotation.get("status") or "",
            "severity": annotation.get("severity") or "",
            "workflow_id": annotation.get("workflow_id") or "",
            "agent_name": annotation.get("agent_name") or "",
            "conversation_id": annotation.get("conversation_id") or "",
            "suggestion": annotation.get("suggestion") or {},
            "risk": annotation.get("risk") or {},
            "attached_files": annotation.get("attached_files") or [],
        },
        "labels": [label],
        "context": {
            **context,
            "content_omitted": True,
        },
        "wiki_hints": record.get("wiki_hints") or {},
    }


def _thread_messages(thread: list[Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in thread:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not content:
            continue
        role = str(item.get("role") or "user").strip().lower()
        if role in {"agent", "ai"}:
            role = "assistant"
        elif role not in {"system", "developer", "user", "assistant"}:
            role = "user"
        out.append({"role": role, "content": _textify(content)})
    return out


def _annotation_output(record: dict[str, Any]) -> str:
    annotation = record.get("annotation") if isinstance(record.get("annotation"), dict) else {}
    suggestion = annotation.get("suggestion") if isinstance(annotation.get("suggestion"), dict) else {}
    risk = annotation.get("risk") if isinstance(annotation.get("risk"), dict) else {}
    for value in (
        suggestion.get("proposed"),
        risk.get("mitigation"),
        annotation.get("content"),
    ):
        if value:
            return _textify(value)
    return ""


def _phoenix_splits(record: dict[str, Any]) -> list[str]:
    return ["train"] if record.get("is_training_candidate") else []


def _reference_kind(record: dict[str, Any]) -> str:
    evaluation = record.get("evaluation") if isinstance(record.get("evaluation"), dict) else {}
    verdict = str(evaluation.get("verdict") or "").lower()
    adoption = str(evaluation.get("adoption") or "").lower()
    if verdict == "positive" and (
        record.get("is_training_candidate") or adoption in {"accepted", "adopted"}
    ):
        return "human_approved"
    if verdict:
        return "human_labeled"
    return "baseline"


def _verdict_score(value: Any) -> float | None:
    verdict = str(value or "").strip().lower()
    if verdict == "positive":
        return 1.0
    if verdict == "negative":
        return 0.0
    return None


def _textify(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def _line_context_for_range(content: str, range_from: int, range_to: int) -> dict[str, Any]:
    content_length = len(content)
    start = max(0, min(range_from, content_length))
    end = max(0, min(range_to, content_length))
    if end < start:
        start, end = end, start

    line_block_start = content.rfind("\n", 0, start) + 1
    end_anchor = start if end == start else max(start, end - 1)
    line_block_end = content.find("\n", end_anchor)
    if line_block_end == -1:
        line_block_end = content_length

    line_text = content[line_block_start:line_block_end]
    line_start_number = content.count("\n", 0, line_block_start) + 1
    line_end_number = content.count("\n", 0, line_block_end) + 1
    range_from_in_line = start - line_block_start
    range_to_in_line = min(end - line_block_start, len(line_text))

    return {
        "line_start_number": line_start_number,
        "line_end_number": line_end_number,
        "line_start_offset": line_block_start,
        "line_end_offset": line_block_end,
        "range_from_in_line": range_from_in_line,
        "range_to_in_line": range_to_in_line,
        "current_line_content": line_text,
    }


def _find_section(content: str, fmt: str, offset: int) -> str | None:
    prefix = content[: max(0, min(offset, len(content)))]
    patterns = (
        [r"\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^{}]+)\}"]
        if fmt == "tex"
        else [r"^(#{1,6})\s+(.+)$"]
    )
    best: str | None = None
    flags = re.MULTILINE
    for pattern in patterns:
        for match in re.finditer(pattern, prefix, flags):
            best = match.group(2).strip()
    return best


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n"


def _json_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _agent_prompt(project_name: str) -> str:
    return f"""# Agent Prompt: Build an LLM Wiki from Annotation Training Data

You are given an annotation training export from project `{project_name}`.

Read `manifest.json`, `records.jsonl`, and `documents.json`.
The export is line-context only: records include `context.current_line_content`
and line metadata, while `documents.json` contains document metadata and hashes
without full document content.

Build a wiki that captures project-specific writing and review knowledge:

1. Extract reusable writing rules from positive examples.
2. Extract common failure patterns from negative examples.
3. Preserve evidence: cite `record_id`, `doc_name`, section, tags, and target text.
4. Separate project-specific preferences from general writing advice.
5. Include examples and counterexamples when the records support them.

Suggested output pages:

- Writing Rules
- Common Failure Patterns
- Good Revision Patterns
- Citation and Evidence Habits
- Project-specific Style Guide
- Examples and Counterexamples
"""


def _export_readme() -> str:
    return """# SuperLeaf Annotation Training Export

This package contains annotation evaluation samples for building an LLM wiki.

Files:

- `manifest.json`: export metadata and counts.
- `records.jsonl`: one evaluation sample per line.
- `documents.json`: metadata and hashes for documents referenced by records.
- `phoenix_dataset.json`: Phoenix `/v1/datasets/upload` compatible dataset payload.
- `phoenix_dataset.jsonl`: one Phoenix-style dataset example per line.
- `agent_prompt.md`: suggested prompt for an Agent/wiki builder.

Privacy note: this export intentionally omits full document content. Each
record includes only the line content touched by the annotation range. Treat it
as private research material unless you have intentionally sanitized it.

Context note: v2 uses current line content plus ranges and hashes. It does not
reconstruct the exact historical document state from when the annotation was
originally created.
"""
