"""Workflow Trace Parser — extracts structured patterns from workflow run traces.

Parses ``DatasetRecord.fields.trace`` arrays to identify tool call sequences,
success/failure patterns, and common error paths.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field


@dataclass
class ToolCallStep:
    tool: str
    args_summary: str = ""
    success: bool = True
    error: str = ""


@dataclass
class TracePattern:
    tools: list[str] = field(default_factory=list)
    success_rate: float = 0.0
    count: int = 0
    example_record_ids: list[str] = field(default_factory=list)


@dataclass
class TraceParseResult:
    total_traces: int = 0
    parsed_traces: int = 0
    patterns: list[TracePattern] = field(default_factory=list)
    common_errors: list[dict] = field(default_factory=list)


class WorkflowTraceParser:
    """Parse workflow run traces to extract tool call patterns."""

    def parse_records(self, records: list[dict]) -> TraceParseResult:
        """Parse a list of dataset records with traces.

        Args:
            records: List of dicts with 'record_id', 'fields', 'values'.

        Returns:
            TraceParseResult with extracted patterns.
        """
        success_combos: Counter[tuple[str, ...]] = Counter()
        fail_combos: Counter[tuple[str, ...]] = Counter()
        success_examples: dict[tuple[str, ...], list[str]] = {}
        fail_examples: dict[tuple[str, ...], list[str]] = {}
        error_counts: Counter[str] = Counter()
        parsed = 0

        for rec in records:
            trace = rec.get("fields", {}).get("trace", [])
            if not trace or not isinstance(trace, list):
                continue

            steps = self._parse_trace_steps(trace)
            if not steps:
                continue

            parsed += 1
            tools = [s.tool for s in steps if s.tool]
            if not tools:
                continue

            combo = tuple(sorted(set(tools)))
            values = rec.get("values", {})
            record_id = rec.get("record_id", "")

            if values.get("task_success") == "yes":
                success_combos[combo] += 1
                success_examples.setdefault(combo, []).append(record_id)
            else:
                fail_combos[combo] += 1
                fail_examples.setdefault(combo, []).append(record_id)

            # Collect errors
            for step in steps:
                if step.error:
                    error_counts[step.error] += 1

        # Build patterns
        all_combos = set(success_combos.keys()) | set(fail_combos.keys())
        patterns = []
        for combo in all_combos:
            s = success_combos.get(combo, 0)
            f = fail_combos.get(combo, 0)
            total = s + f
            if total >= 2:
                examples = success_examples.get(combo, []) + fail_examples.get(combo, [])
                patterns.append(
                    TracePattern(
                        tools=list(combo),
                        success_rate=round(s / total, 2) if total > 0 else 0.0,
                        count=total,
                        example_record_ids=examples[:5],
                    )
                )

        patterns.sort(key=lambda p: p.count, reverse=True)

        # Common errors
        common_errors = [
            {"error": err, "count": count}
            for err, count in error_counts.most_common(10)
        ]

        return TraceParseResult(
            total_traces=len(records),
            parsed_traces=parsed,
            patterns=patterns[:20],
            common_errors=common_errors,
        )

    def _parse_trace_steps(self, trace: list) -> list[ToolCallStep]:
        """Parse raw trace array into structured steps."""
        steps = []
        for item in trace:
            if not isinstance(item, dict):
                continue
            tool = item.get("tool") or item.get("name") or item.get("function") or ""
            if not tool:
                continue
            steps.append(
                ToolCallStep(
                    tool=tool,
                    args_summary=str(item.get("args", ""))[:100],
                    success=not bool(item.get("error")),
                    error=str(item.get("error", ""))[:200],
                )
            )
        return steps

    def format_patterns_markdown(self, result: TraceParseResult) -> str:
        """Format trace parse result as markdown."""
        lines = [
            "# Workflow Insights",
            "",
            f"Total traces: {result.total_traces}",
            f"Parsed traces: {result.parsed_traces}",
            "",
        ]

        if result.patterns:
            lines.append("## Tool Call Patterns")
            lines.append("")
            for i, p in enumerate(result.patterns[:10], 1):
                tools_str = " → ".join(p.tools)
                lines.append(
                    f"{i}. `{tools_str}` — success rate: {p.success_rate:.0%}, "
                    f"count: {p.count}"
                )
            lines.append("")

        if result.common_errors:
            lines.append("## Common Errors")
            lines.append("")
            for err in result.common_errors[:5]:
                lines.append(f"- {err['error']} ({err['count']} occurrences)")
            lines.append("")

        return "\n".join(lines)
