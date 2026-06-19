"""Skill Signal Diagnosis Service — Phase 2 of the optimization pipeline.

Collects signals from Data Project labeled samples, Annotation Evaluations,
Workflow Traces, and dialogue sedimentations.  Produces a structured diagnosis
JSON consumed by the Skill generation step.

Operates on the Data Project side of the two-Project architecture.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import (
    AnnotationEvaluation,
    DatasetProject,
    DatasetRecord,
    DatasetResponse,
    Project,
    SkillSedimentation,
)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class FailurePattern:
    pattern: str
    count: int
    example_ids: list[str] = field(default_factory=list)
    suggested_fix: str = ""


@dataclass
class Example:
    id: str
    input: str = ""
    output: str = ""
    reason: str = ""


@dataclass
class WorkflowPattern:
    tools: list[str] = field(default_factory=list)
    success_rate: float = 0.0
    count: int = 0


@dataclass
class SedimentationCandidate:
    id: str
    procedure_summary: str = ""
    source_conversation_id: str = ""


@dataclass
class OptimizationSuggestion:
    priority: str = "medium"
    target: str = ""
    suggestion: str = ""


@dataclass
class DiagnosisResult:
    failure_patterns: list[FailurePattern] = field(default_factory=list)
    golden_examples: list[Example] = field(default_factory=list)
    negative_examples: list[Example] = field(default_factory=list)
    workflow_patterns: list[WorkflowPattern] = field(default_factory=list)
    sedimentation_candidates: list[SedimentationCandidate] = field(default_factory=list)
    optimization_suggestions: list[OptimizationSuggestion] = field(default_factory=list)
    summary: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "failure_patterns": [
                {
                    "pattern": fp.pattern,
                    "count": fp.count,
                    "example_ids": fp.example_ids,
                    "suggested_fix": fp.suggested_fix,
                }
                for fp in self.failure_patterns
            ],
            "golden_examples": [
                {
                    "id": e.id,
                    "input": e.input[:500],
                    "output": e.output[:500],
                    "reason": e.reason,
                }
                for e in self.golden_examples
            ],
            "negative_examples": [
                {
                    "id": e.id,
                    "input": e.input[:500],
                    "output": e.output[:500],
                    "reason": e.reason,
                }
                for e in self.negative_examples
            ],
            "workflow_patterns": [
                {
                    "tools": wp.tools,
                    "success_rate": wp.success_rate,
                    "count": wp.count,
                }
                for wp in self.workflow_patterns
            ],
            "sedimentation_candidates": [
                {
                    "id": sc.id,
                    "procedure_summary": sc.procedure_summary,
                    "source_conversation_id": sc.source_conversation_id,
                }
                for sc in self.sedimentation_candidates
            ],
            "optimization_suggestions": [
                {
                    "priority": s.priority,
                    "target": s.target,
                    "suggestion": s.suggestion,
                }
                for s in self.optimization_suggestions
            ],
            "summary": self.summary,
        }


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class SkillSignalDiagnosisService:
    """Diagnose optimization signals from a Data Project and related sources."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def diagnose(
        self,
        *,
        data_project: Project,
        include_annotations: bool = True,
        include_sedimentations: bool = True,
        top_k_patterns: int = 10,
        top_k_examples: int = 10,
    ) -> DiagnosisResult:
        """Run full diagnosis on a Data Project's labeled data.

        Args:
            data_project: The Data Project to diagnose.
            include_annotations: Whether to include Annotation Evaluation signals.
            include_sedimentations: Whether to include dialogue sedimentation candidates.
            top_k_patterns: Max failure patterns to return.
            top_k_examples: Max golden/negative examples to return.

        Returns:
            DiagnosisResult with all extracted patterns and examples.
        """
        dataset = (
            self.db.query(DatasetProject)
            .filter(DatasetProject.project_id == data_project.id)
            .first()
        )
        if dataset is None:
            return DiagnosisResult(
                summary={"error": "Data Project has no DatasetProject companion row"}
            )

        # Collect labeled samples
        labeled_records = self._get_labeled_records(dataset.id)

        # Collect annotation evaluations (project-wide)
        evals = []
        if include_annotations:
            evals = self._get_project_evaluations(data_project.id)

        # Extract failure patterns
        failure_patterns = self._extract_failure_patterns(
            labeled_records, evals, top_k=top_k_patterns
        )

        # Extract golden/negative examples
        golden = self._extract_golden_examples(labeled_records, evals, top_k=top_k_examples)
        negative = self._extract_negative_examples(labeled_records, evals, top_k=top_k_examples)

        # Extract workflow patterns
        workflow_patterns = self._extract_workflow_patterns(labeled_records)

        # Collect sedimentation candidates
        sedimentations = []
        if include_sedimentations:
            sedimentations = self._get_sedimentation_candidates(data_project.id)

        # Generate optimization suggestions
        suggestions = self._generate_suggestions(
            failure_patterns, golden, negative, workflow_patterns
        )

        # Build summary
        summary = {
            "data_project_id": data_project.id,
            "dataset_name": dataset.name or data_project.name,
            "total_labeled_records": len(labeled_records),
            "total_evaluations": len(evals),
            "failure_pattern_count": len(failure_patterns),
            "golden_example_count": len(golden),
            "negative_example_count": len(negative),
            "workflow_pattern_count": len(workflow_patterns),
            "sedimentation_candidate_count": len(sedimentations),
            "diagnosed_at": datetime.utcnow().isoformat(),
        }

        return DiagnosisResult(
            failure_patterns=failure_patterns,
            golden_examples=golden,
            negative_examples=negative,
            workflow_patterns=workflow_patterns,
            sedimentation_candidates=sedimentations,
            optimization_suggestions=suggestions,
            summary=summary,
        )

    # -------------------------------------------------------------------
    # Data collection
    # -------------------------------------------------------------------

    def _get_labeled_records(self, dataset_project_id: str) -> list[dict]:
        """Get records that have at least one submitted response."""
        rows = (
            self.db.query(DatasetRecord, DatasetResponse)
            .join(DatasetResponse, DatasetResponse.record_id == DatasetRecord.id)
            .filter(
                DatasetRecord.dataset_project_id == dataset_project_id,
                DatasetResponse.status == "submitted",
            )
            .all()
        )
        results = []
        for record, response in rows:
            results.append(
                {
                    "record_id": record.id,
                    "source_type": record.source_type,
                    "fields": record.fields or {},
                    "provenance": record.provenance or {},
                    "values": response.values or {},
                }
            )
        return results

    def _get_project_evaluations(self, project_id: str) -> list[dict]:
        """Get all AnnotationEvaluation rows for docs in this project."""
        from ..models import Doc

        doc_ids = [
            d.id
            for d in self.db.query(Doc.id)
            .filter(Doc.project_id == project_id)
            .all()
        ]
        if not doc_ids:
            return []

        evals = (
            self.db.query(AnnotationEvaluation)
            .filter(AnnotationEvaluation.doc_id.in_(doc_ids))
            .all()
        )
        return [
            {
                "id": e.id,
                "annotation_id": e.annotation_id,
                "doc_id": e.doc_id,
                "verdict": e.verdict,
                "reason": e.reason or "",
                "tags": e.tags or [],
                "adoption": e.adoption,
                "training_candidate": e.training_candidate,
                "context": e.context or {},
            }
            for e in evals
        ]

    def _get_sedimentation_candidates(self, project_id: str) -> list[SedimentationCandidate]:
        """Get pending sedimentation candidates for this project."""
        rows = (
            self.db.query(SkillSedimentation)
            .filter(
                SkillSedimentation.source_project_id == project_id,
                SkillSedimentation.status == "candidate",
            )
            .order_by(SkillSedimentation.created_at.desc())
            .limit(20)
            .all()
        )
        return [
            SedimentationCandidate(
                id=r.id,
                procedure_summary=r.procedure_summary or "",
                source_conversation_id=r.source_conversation_id or "",
            )
            for r in rows
        ]

    # -------------------------------------------------------------------
    # Pattern extraction
    # -------------------------------------------------------------------

    def _extract_failure_patterns(
        self,
        labeled_records: list[dict],
        evals: list[dict],
        top_k: int = 10,
    ) -> list[FailurePattern]:
        """Cluster failures by issues tags and evaluation tags."""
        counter: Counter[str] = Counter()
        example_map: dict[str, list[str]] = {}

        # From labeled records (task_success=no)
        for rec in labeled_records:
            values = rec["values"]
            if values.get("task_success") == "no":
                issues = values.get("issues", [])
                if isinstance(issues, str):
                    issues = [issues]
                for issue in issues:
                    issue = (issue or "").strip()
                    if issue:
                        counter[issue] += 1
                        example_map.setdefault(issue, []).append(rec["record_id"])

        # From negative evaluations
        for ev in evals:
            if ev["verdict"] == "negative":
                for tag in ev["tags"]:
                    tag = (tag or "").strip().lstrip("#").strip()
                    if tag:
                        counter[tag] += 1
                        example_map.setdefault(tag, []).append(ev["id"])

        patterns = []
        for pattern, count in counter.most_common(top_k):
            patterns.append(
                FailurePattern(
                    pattern=pattern,
                    count=count,
                    example_ids=example_map.get(pattern, [])[:5],
                    suggested_fix=f"Address '{pattern}' in SKILL.md references or instructions",
                )
            )
        return patterns

    def _extract_golden_examples(
        self,
        labeled_records: list[dict],
        evals: list[dict],
        top_k: int = 10,
    ) -> list[Example]:
        """Extract golden examples: task_success=yes + helpfulness>=4 or verdict=positive."""
        examples = []

        for rec in labeled_records:
            values = rec["values"]
            if values.get("task_success") == "yes" and _safe_int(values.get("helpfulness")) >= 4:
                examples.append(
                    Example(
                        id=rec["record_id"],
                        input=_truncate(rec["fields"].get("chat", ""), 300),
                        output=_truncate(rec["fields"].get("agent_output", ""), 300),
                        reason=f"helpfulness={values.get('helpfulness')}, task_success=yes",
                    )
                )

        # Also from positive evaluations
        for ev in evals:
            if ev["verdict"] == "positive" and ev.get("training_candidate"):
                examples.append(
                    Example(
                        id=ev["id"],
                        input=_truncate(ev["reason"], 300),
                        output="",
                        reason=f"verdict=positive, tags={ev['tags']}",
                    )
                )

        return examples[:top_k]

    def _extract_negative_examples(
        self,
        labeled_records: list[dict],
        evals: list[dict],
        top_k: int = 10,
    ) -> list[Example]:
        """Extract negative examples: task_success=no + helpfulness<=2 or verdict=negative."""
        examples = []

        for rec in labeled_records:
            values = rec["values"]
            if values.get("task_success") == "no" and _safe_int(values.get("helpfulness")) <= 2:
                issues = values.get("issues", [])
                if isinstance(issues, str):
                    issues = [issues]
                examples.append(
                    Example(
                        id=rec["record_id"],
                        input=_truncate(rec["fields"].get("chat", ""), 300),
                        output=_truncate(rec["fields"].get("agent_output", ""), 300),
                        reason=f"helpfulness={values.get('helpfulness')}, issues={issues}",
                    )
                )

        for ev in evals:
            if ev["verdict"] == "negative":
                examples.append(
                    Example(
                        id=ev["id"],
                        input=_truncate(ev["reason"], 300),
                        output="",
                        reason=f"verdict=negative, tags={ev['tags']}",
                    )
                )

        return examples[:top_k]

    def _extract_workflow_patterns(
        self,
        labeled_records: list[dict],
    ) -> list[WorkflowPattern]:
        """Extract tool call patterns from workflow traces."""
        success_combos: Counter[tuple[str, ...]] = Counter()
        fail_combos: Counter[tuple[str, ...]] = Counter()

        for rec in labeled_records:
            trace = rec["fields"].get("trace", [])
            if not trace or not isinstance(trace, list):
                continue

            tools_used = []
            for step in trace:
                if isinstance(step, dict):
                    tool = step.get("tool") or step.get("name") or ""
                    if tool:
                        tools_used.append(tool)

            if not tools_used:
                continue

            combo = tuple(sorted(set(tools_used)))
            values = rec["values"]
            if values.get("task_success") == "yes":
                success_combos[combo] += 1
            else:
                fail_combos[combo] += 1

        # Merge into patterns
        all_combos = set(success_combos.keys()) | set(fail_combos.keys())
        patterns = []
        for combo in all_combos:
            s = success_combos.get(combo, 0)
            f = fail_combos.get(combo, 0)
            total = s + f
            if total >= 2:  # Only include patterns seen at least twice
                patterns.append(
                    WorkflowPattern(
                        tools=list(combo),
                        success_rate=round(s / total, 2) if total > 0 else 0.0,
                        count=total,
                    )
                )

        patterns.sort(key=lambda p: p.count, reverse=True)
        return patterns[:10]

    # -------------------------------------------------------------------
    # Suggestion generation
    # -------------------------------------------------------------------

    def _generate_suggestions(
        self,
        failure_patterns: list[FailurePattern],
        golden: list[Example],
        negative: list[Example],
        workflow_patterns: list[WorkflowPattern],
    ) -> list[OptimizationSuggestion]:
        """Generate optimization suggestions based on diagnosis results."""
        suggestions = []

        # Suggest fixing top failure patterns
        for fp in failure_patterns[:5]:
            priority = "high" if fp.count >= 10 else "medium" if fp.count >= 5 else "low"
            suggestions.append(
                OptimizationSuggestion(
                    priority=priority,
                    target=f"references/failure-patterns.md",
                    suggestion=f"Add failure pattern '{fp.pattern}' ({fp.count} occurrences) "
                    f"with corrective guidance to SKILL.md references",
                )
            )

        # Suggest adding golden examples if many exist
        if len(golden) >= 3:
            suggestions.append(
                OptimizationSuggestion(
                    priority="medium",
                    target="references/golden-examples.md",
                    suggestion=f"Add {len(golden)} golden examples as reference material "
                    f"for the Agent to learn from successful patterns",
                )
            )

        # Suggest workflow optimization
        for wp in workflow_patterns[:3]:
            if wp.success_rate >= 0.8 and wp.count >= 5:
                suggestions.append(
                    OptimizationSuggestion(
                        priority="low",
                        target="SKILL.md#workflow",
                        suggestion=f"Document successful tool workflow: "
                        f"{' → '.join(wp.tools)} (success rate: {wp.success_rate:.0%})",
                    )
                )

        return suggestions


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _truncate(text: str, max_len: int = 300) -> str:
    if not text:
        return ""
    text = str(text)
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."
