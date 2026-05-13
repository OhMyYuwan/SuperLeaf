"""Per-agent statistics for the team panel (V3 Phase 3 task 3.4).

For each `CachedWorkflow` under a provider we expose:
  * runs:           number of completed WorkflowRun rows (= how many times the
                    agent finished successfully).
  * accepts/rejects: count of `accept_suggestion` / `reject_suggestion` rows
                    in the Operation log whose `payload.workflow_id` matches
                    this workflow.
  * accept_rate:    accepts / (accepts + rejects); None when no decisions yet.
  * avg_latency_ms: average (finished_at - started_at) over completed runs;
                    None when no completed runs.

The accept-rate join goes through the Operation table because annotations are
client-side state in V3 — the operation log is the only persisted trace of
user decisions against a particular agent's output.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import CachedWorkflow, Operation, WorkflowRun


@dataclass
class AgentStat:
    workflow_id: str
    workflow_name: str
    runs: int
    accepts: int
    rejects: int
    accept_rate: float | None
    avg_latency_ms: float | None


def _aggregate_runs(db: Session, provider_id: str) -> dict[str, tuple[int, float | None]]:
    """Return {workflow_id: (completed_run_count, avg_latency_ms_or_None)}."""
    rows = (
        db.query(
            WorkflowRun.workflow_id,
            func.count(WorkflowRun.id),
            func.avg(
                # SQLite stores DateTime as ISO strings; julianday() yields days
                # as float. Multiply by 86_400_000 to get milliseconds.
                (func.julianday(WorkflowRun.finished_at) - func.julianday(WorkflowRun.started_at))
                * 86_400_000.0
            ),
        )
        .filter(WorkflowRun.provider_id == provider_id)
        .filter(WorkflowRun.status == "completed")
        .filter(WorkflowRun.finished_at.is_not(None))
        .group_by(WorkflowRun.workflow_id)
        .all()
    )
    out: dict[str, tuple[int, float | None]] = {}
    for workflow_id, count, avg_ms in rows:
        out[workflow_id] = (int(count or 0), float(avg_ms) if avg_ms is not None else None)
    return out


def _aggregate_decisions(db: Session, workflow_ids: list[str]) -> dict[str, tuple[int, int]]:
    """Return {workflow_id: (accepts, rejects)} extracted from operation log."""
    if not workflow_ids:
        return {}
    workflow_id_expr = func.json_extract(Operation.payload, "$.workflow_id")
    rows = (
        db.query(workflow_id_expr, Operation.type, func.count(Operation.id))
        .filter(workflow_id_expr.in_(workflow_ids))
        .filter(Operation.type.in_(("accept_suggestion", "reject_suggestion")))
        .group_by(workflow_id_expr, Operation.type)
        .all()
    )
    out: dict[str, tuple[int, int]] = {wid: (0, 0) for wid in workflow_ids}
    for wid, op_type, count in rows:
        if wid not in out:
            continue
        accepts, rejects = out[wid]
        if op_type == "accept_suggestion":
            out[wid] = (accepts + int(count), rejects)
        else:
            out[wid] = (accepts, rejects + int(count))
    return out


def stats_for_provider(db: Session, provider_id: str) -> list[AgentStat]:
    workflows = (
        db.query(CachedWorkflow)
        .filter(CachedWorkflow.provider_id == provider_id)
        .all()
    )
    if not workflows:
        return []

    runs_by_wf = _aggregate_runs(db, provider_id)
    decisions = _aggregate_decisions(db, [w.id for w in workflows])

    stats: list[AgentStat] = []
    for wf in workflows:
        runs, avg_ms = runs_by_wf.get(wf.id, (0, None))
        accepts, rejects = decisions.get(wf.id, (0, 0))
        decided = accepts + rejects
        accept_rate = (accepts / decided) if decided > 0 else None
        stats.append(
            AgentStat(
                workflow_id=wf.id,
                workflow_name=wf.name,
                runs=runs,
                accepts=accepts,
                rejects=rejects,
                accept_rate=accept_rate,
                avg_latency_ms=avg_ms,
            )
        )
    return stats
