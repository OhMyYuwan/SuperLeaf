"""Skill Eval Service — Phase 4 of the optimization pipeline.

Reads eval cases from ``evals/skill-evals.jsonl`` in a Skill Project, runs
each case through the Native Agent, and evaluates the output against expected
criteria.

Uses real LLM API calls via NativeAgentRunner.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.orm import Session

from ..models import Doc, Project


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class EvalCaseResult:
    id: str
    input_summary: str = ""
    expected: dict = field(default_factory=dict)
    actual: dict = field(default_factory=dict)
    passed: bool = False
    is_regression: bool = False
    evaluators: dict = field(default_factory=dict)
    error: str = ""


@dataclass
class EvalSummary:
    total: int = 0
    passed: int = 0
    failed: int = 0
    regressions: int = 0
    pass_rate: float = 0.0


@dataclass
class EvalRunResult:
    summary: EvalSummary = field(default_factory=EvalSummary)
    cases: list[EvalCaseResult] = field(default_factory=list)
    regressions: list[dict] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "summary": {
                "total": self.summary.total,
                "passed": self.summary.passed,
                "failed": self.summary.failed,
                "regressions": self.summary.regressions,
                "pass_rate": self.summary.pass_rate,
            },
            "cases": [
                {
                    "id": c.id,
                    "input_summary": c.input_summary[:200],
                    "expected": c.expected,
                    "actual": c.actual,
                    "passed": c.passed,
                    "is_regression": c.is_regression,
                    "evaluators": c.evaluators,
                    "error": c.error,
                }
                for c in self.cases
            ],
            "regressions": self.regressions,
            "error": self.error,
        }


# ---------------------------------------------------------------------------
# Evaluators
# ---------------------------------------------------------------------------


def _eval_output_contains(expected: dict, actual_output: str) -> dict:
    """Check if output contains expected keywords."""
    contains = expected.get("contains", [])
    if not contains:
        return {"passed": True, "details": "No contains criteria"}

    missing = [kw for kw in contains if kw not in actual_output]
    return {
        "passed": len(missing) == 0,
        "details": f"Missing: {missing}" if missing else "All keywords found",
    }


def _eval_task_success_match(expected: dict, actual: dict) -> dict:
    """Check if task_success matches expected."""
    expected_val = expected.get("task_success")
    if expected_val is None:
        return {"passed": True, "details": "No task_success criteria"}

    actual_val = actual.get("task_success")
    return {
        "passed": expected_val == actual_val,
        "details": f"Expected '{expected_val}', got '{actual_val}'",
    }


def _eval_tools_called(expected: dict, actual: dict) -> dict:
    """Check if expected tools were called."""
    expected_tools = expected.get("tools_called", [])
    if not expected_tools:
        return {"passed": True, "details": "No tools_called criteria"}

    actual_tools = actual.get("tools_used", [])
    missing = [t for t in expected_tools if t not in actual_tools]
    return {
        "passed": len(missing) == 0,
        "details": f"Missing tools: {missing}" if missing else "All tools called",
    }


def _eval_output_not_empty(expected: dict, actual_output: str) -> dict:
    """Check if output is non-empty."""
    return {
        "passed": bool(actual_output and actual_output.strip()),
        "details": "Output is non-empty" if actual_output else "Output is empty",
    }


EVALUATORS = {
    "output_contains": _eval_output_contains,
    "task_success_match": _eval_task_success_match,
    "tools_called": _eval_tools_called,
    "output_not_empty": _eval_output_not_empty,
}


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class SkillEvalService:
    """Run eval cases against a Skill Project's Agent."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def load_eval_cases(
        self,
        skill_project_id: str,
        subset: str = "regression",
    ) -> list[dict]:
        """Load eval cases from evals/skill-evals.jsonl.

        Args:
            skill_project_id: The Skill Project ID.
            subset: "regression" (default), "dev", or "all".

        Returns:
            List of eval case dicts.
        """
        doc = (
            self.db.query(Doc)
            .filter(
                Doc.project_id == skill_project_id,
                Doc.name == "skill-evals.jsonl",
            )
            .first()
        )
        if doc is None or not doc.content:
            return []

        cases = []
        for line in doc.content.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                case = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Filter by subset
            splits = case.get("splits", [])
            if subset == "regression" and "regression" not in splits:
                continue
            elif subset == "dev" and "dev" not in splits and "regression" not in splits:
                continue
            # "all" returns everything

            cases.append(case)

        return cases

    def evaluate_case(
        self,
        case: dict,
        actual_output: str,
        actual_tools: list[str] | None = None,
        actual_task_success: str | None = None,
    ) -> EvalCaseResult:
        """Evaluate a single case against expected criteria.

        Args:
            case: The eval case dict with expected criteria.
            actual_output: The Agent's output text.
            actual_tools: Tools the Agent called (optional).
            actual_task_success: Inferred task success (optional).

        Returns:
            EvalCaseResult with per-evaluator results.
        """
        expected = case.get("expected", {})
        actual = {
            "output": actual_output,
            "tools_used": actual_tools or [],
            "task_success": actual_task_success,
        }

        evaluator_results = {}
        all_passed = True

        # Run applicable evaluators
        if "contains" in expected:
            result = _eval_output_contains(expected, actual_output)
            evaluator_results["output_contains"] = result
            if not result["passed"]:
                all_passed = False

        if "task_success" in expected:
            result = _eval_task_success_match(expected, actual)
            evaluator_results["task_success_match"] = result
            if not result["passed"]:
                all_passed = False

        if "tools_called" in expected:
            result = _eval_tools_called(expected, actual)
            evaluator_results["tools_called"] = result
            if not result["passed"]:
                all_passed = False

        # Always check output is non-empty
        result = _eval_output_not_empty(expected, actual_output)
        evaluator_results["output_not_empty"] = result
        if not result["passed"]:
            all_passed = False

        return EvalCaseResult(
            id=case.get("id", "unknown"),
            input_summary=_extract_input_summary(case),
            expected=expected,
            actual=actual,
            passed=all_passed,
            evaluators=evaluator_results,
        )

    def build_eval_report(
        self,
        results: list[EvalCaseResult],
        previous_results: dict[str, bool] | None = None,
    ) -> EvalRunResult:
        """Build an eval report from individual case results.

        Args:
            results: List of EvalCaseResult from evaluate_case.
            previous_results: Previous eval results {case_id: passed} for regression detection.

        Returns:
            EvalRunResult with summary, cases, and regressions.
        """
        passed = sum(1 for r in results if r.passed)
        failed = len(results) - passed
        regressions = []

        # Detect regressions
        if previous_results:
            for r in results:
                prev_passed = previous_results.get(r.id)
                if prev_passed is True and not r.passed:
                    r.is_regression = True
                    regressions.append(
                        {
                            "id": r.id,
                            "reason": "Previously passed, now failed",
                            "previous_result": "passed",
                            "current_result": "failed",
                        }
                    )

        total = len(results)
        summary = EvalSummary(
            total=total,
            passed=passed,
            failed=failed,
            regressions=len(regressions),
            pass_rate=round(passed / total, 3) if total > 0 else 0.0,
        )

        return EvalRunResult(
            summary=summary,
            cases=results,
            regressions=regressions,
        )

    def format_eval_report_markdown(self, report: EvalRunResult) -> str:
        """Format eval report as markdown for eval-report.md."""
        lines = [
            "# Eval Report",
            "",
            f"Generated at: {datetime.utcnow().isoformat()}",
            "",
            "## Summary",
            "",
            f"- Total: {report.summary.total}",
            f"- Passed: {report.summary.passed}",
            f"- Failed: {report.summary.failed}",
            f"- Regressions: {report.summary.regressions}",
            f"- Pass rate: {report.summary.pass_rate:.1%}",
            "",
        ]

        if report.regressions:
            lines.append("## Regressions")
            lines.append("")
            for reg in report.regressions:
                lines.append(f"- **{reg['id']}**: {reg['reason']}")
            lines.append("")

        lines.append("## Case Results")
        lines.append("")
        for case in report.cases:
            status = "✅" if case.passed else "❌"
            reg_mark = " ⚠️ REGRESSION" if case.is_regression else ""
            lines.append(f"### {status} {case.id}{reg_mark}")
            lines.append(f"- Input: {case.input_summary[:100]}")
            for eval_name, eval_result in case.evaluators.items():
                eval_status = "✅" if eval_result["passed"] else "❌"
                lines.append(f"  - {eval_status} {eval_name}: {eval_result['details']}")
            if case.error:
                lines.append(f"- Error: {case.error}")
            lines.append("")

        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_input_summary(case: dict) -> str:
    """Extract a short summary from the eval case input."""
    input_data = case.get("input", {})
    messages = input_data.get("messages", [])
    if messages:
        last_user = next(
            (m for m in reversed(messages) if m.get("role") == "user"),
            messages[-1] if messages else {},
        )
        return str(last_user.get("content", ""))[:200]
    return str(input_data)[:200]
