"""Agent 使用统计 schema。"""

from __future__ import annotations

from pydantic import BaseModel


class AgentStatOut(BaseModel):
    workflow_id: str
    workflow_name: str
    runs: int
    accepts: int
    rejects: int
    accept_rate: float | None
    avg_latency_ms: float | None


class ProviderStatsOut(BaseModel):
    provider_id: str
    agents: list[AgentStatOut]
