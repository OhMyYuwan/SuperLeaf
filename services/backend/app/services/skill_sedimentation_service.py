"""Skill Sedimentation Service — extracts reusable procedures from conversations.

Inspired by hermes-agent's dialogue-to-skill pipeline.  On user trigger,
reviews a conversation and extracts durable procedural knowledge as
``SkillSedimentation`` candidates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.orm import Session

from ..models import SkillSedimentation


@dataclass
class SedimentationResult:
    id: str = ""
    procedure_summary: str = ""
    status: str = ""
    error: str = ""


class SkillSedimentationService:
    """Manage dialogue-to-skill sedimentation candidates."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def create_candidate(
        self,
        *,
        user_id: str,
        source_conversation_id: str,
        source_project_id: str,
        skill_id: str | None = None,
        procedure_summary: str,
        raw_context: dict | None = None,
        created_by: str = "agent",
    ) -> SedimentationResult:
        """Create a new sedimentation candidate.

        Args:
            user_id: The user who triggered the sedimentation.
            source_conversation_id: The conversation ID.
            source_project_id: The project ID.
            skill_id: Optional target Skill ID.
            procedure_summary: The extracted procedure summary.
            raw_context: Original conversation context (will be sanitized).
            created_by: "agent" or "user".

        Returns:
            SedimentationResult with the created candidate ID.
        """
        # Sanitize raw_context — remove sensitive data
        sanitized = self._sanitize_context(raw_context or {})

        candidate = SkillSedimentation(
            user_id=user_id,
            source_conversation_id=source_conversation_id,
            source_project_id=source_project_id,
            skill_id=skill_id,
            procedure_summary=procedure_summary,
            raw_context=sanitized,
            status="candidate",
            created_by=created_by,
        )
        self.db.add(candidate)
        self.db.commit()
        self.db.refresh(candidate)

        return SedimentationResult(
            id=candidate.id,
            procedure_summary=candidate.provenance_summary or procedure_summary,
            status="candidate",
        )

    def list_candidates(
        self,
        *,
        user_id: str,
        skill_id: str | None = None,
        status: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        """List sedimentation candidates.

        Args:
            user_id: Filter by user.
            skill_id: Filter by target skill.
            status: Filter by status.
            limit: Max results.

        Returns:
            List of candidate dicts.
        """
        q = self.db.query(SkillSedimentation).filter(
            SkillSedimentation.user_id == user_id
        )
        if skill_id:
            q = q.filter(SkillSedimentation.skill_id == skill_id)
        if status:
            q = q.filter(SkillSedimentation.status == status)

        rows = (
            q.order_by(SkillSedimentation.created_at.desc())
            .limit(limit)
            .all()
        )

        return [
            {
                "id": r.id,
                "source_conversation_id": r.source_conversation_id,
                "source_project_id": r.source_project_id,
                "skill_id": r.skill_id,
                "procedure_summary": r.procedure_summary,
                "status": r.status,
                "created_by": r.created_by,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]

    def review_candidate(
        self,
        candidate_id: str,
        *,
        user_id: str,
        action: str,
        target_skill_id: str | None = None,
    ) -> SedimentationResult:
        """Review a sedimentation candidate (merge or discard).

        Args:
            candidate_id: The candidate ID.
            user_id: The reviewing user.
            action: "merge" or "discard".
            target_skill_id: Skill ID to merge into (for merge action).

        Returns:
            SedimentationResult with updated status.
        """
        candidate = (
            self.db.query(SkillSedimentation)
            .filter(
                SkillSedimentation.id == candidate_id,
                SkillSedimentation.user_id == user_id,
            )
            .first()
        )
        if candidate is None:
            return SedimentationResult(error="Candidate not found")

        if action == "merge":
            candidate.status = "merged"
            if target_skill_id:
                candidate.skill_id = target_skill_id
        elif action == "discard":
            candidate.status = "discarded"
        else:
            return SedimentationResult(error=f"Unknown action: {action}")

        self.db.commit()
        self.db.refresh(candidate)

        return SedimentationResult(
            id=candidate.id,
            procedure_summary=candidate.procedure_summary,
            status=candidate.status,
        )

    def get_candidates_for_skill(
        self,
        skill_id: str,
        *,
        status: str = "candidate",
    ) -> list[dict]:
        """Get all candidates targeting a specific skill.

        Used by SkillSignalDiagnosisService to include in diagnosis.
        """
        return self.list_candidates(
            user_id="",  # No user filter for skill-level aggregation
            skill_id=skill_id,
            status=status,
            limit=50,
        )

    def _sanitize_context(self, context: dict) -> dict:
        """Remove sensitive data from raw conversation context.

        Keeps only the structure needed for procedure extraction:
        - Message roles and content (truncated)
        - Tool call names
        - Removes: API keys, tokens, full file contents
        """
        sanitized = {}
        messages = context.get("messages", [])
        if messages:
            clean_msgs = []
            for msg in messages[:20]:  # Limit to 20 messages
                if isinstance(msg, dict):
                    clean_msg = {
                        "role": msg.get("role", ""),
                        "content": str(msg.get("content", ""))[:500],
                    }
                    # Keep tool call names only
                    tool_calls = msg.get("tool_calls", [])
                    if tool_calls:
                        clean_msg["tool_calls"] = [
                            {"name": tc.get("name", "")}
                            for tc in tool_calls[:5]
                            if isinstance(tc, dict)
                        ]
                    clean_msgs.append(clean_msg)
            sanitized["messages"] = clean_msgs

        # Keep metadata
        for key in ["project_id", "conversation_id", "agent_id", "workflow_id"]:
            if key in context:
                sanitized[key] = context[key]

        return sanitized
