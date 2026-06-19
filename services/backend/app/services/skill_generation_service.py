"""Skill Generation Service — Phase 3 of the optimization pipeline.

Reads diagnosis results from ``_skill_data/`` handoff folder in a Skill Project,
then writes optimized SKILL.md, references/, and evals/ into the Skill Project's
formal file tree via ``ProjectFsService``.

Operates on the Skill Project side of the two-Project architecture.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.orm import Session

from ..models import Doc, Folder, Project
from .project_fs_service import ProjectFsService


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class GeneratedArtifact:
    path: str
    kind: str  # "doc" | "folder"
    action: str  # "created" | "updated"
    size_bytes: int = 0


@dataclass
class GenerationResult:
    artifacts: list[GeneratedArtifact] = field(default_factory=list)
    skill_md_diff: str = ""
    previous_skill_md: str = ""
    new_skill_md: str = ""
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "artifacts": [
                {
                    "path": a.path,
                    "kind": a.kind,
                    "action": a.action,
                    "size_bytes": a.size_bytes,
                }
                for a in self.artifacts
            ],
            "skill_md_diff": self.skill_md_diff,
            "error": self.error,
        }


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class SkillGenerationService:
    """Read handoff data from _skill_data/ and rewrite Skill Project files."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def generate(
        self,
        *,
        skill_project: Project,
        data_project_id: str,
        custom_instructions: str = "",
    ) -> GenerationResult:
        """Generate optimized Skill Project files from handoff data.

        Args:
            skill_project: The target Skill Project.
            data_project_id: The source Data Project ID (to find the handoff folder).
            custom_instructions: Optional extra instructions for the optimization.

        Returns:
            GenerationResult with artifact list and diff.
        """
        if not (skill_project.project_type == "skill" or skill_project.is_skill_project):
            return GenerationResult(error="Current project is not a Skill Project")

        fs = ProjectFsService(self.db, skill_project)

        # 1. Read handoff data
        handoff = self._read_handoff_data(skill_project.id, data_project_id)
        if not handoff:
            return GenerationResult(
                error="No handoff data found. Run attach_dataset_package + "
                "attach_diagnosis_results first."
            )

        # 2. Read current SKILL.md
        previous_skill_md = self._read_current_skill_md(skill_project.id)

        # 3. Generate optimized SKILL.md
        new_skill_md = self._generate_skill_md(
            previous_skill_md=previous_skill_md,
            handoff=handoff,
            custom_instructions=custom_instructions,
        )

        # 4. Compute diff
        diff = _compute_diff(previous_skill_md, new_skill_md)

        # 5. Write files
        artifacts: list[GeneratedArtifact] = []

        # Write SKILL.md
        root_folder_id = self._get_root_folder_id(skill_project.id)
        artifact = self._write_doc(fs, root_folder_id, "SKILL.md", "md", new_skill_md)
        artifacts.append(artifact)

        # Write references/
        ref_folder = fs.create_folder(parent_folder_id=root_folder_id, name="references")
        for name, content in self._generate_references(handoff).items():
            artifact = self._write_doc(
                fs, ref_folder.id, name, "md", content, folder_path="references"
            )
            artifacts.append(artifact)

        # Write evals/
        eval_cases = self._parse_eval_cases(handoff.get("eval-cases.jsonl", ""))
        if eval_cases:
            eval_folder = fs.create_folder(parent_folder_id=root_folder_id, name="evals")
            eval_content = "\n".join(json.dumps(c, ensure_ascii=False) for c in eval_cases)
            artifact = self._write_doc(
                fs, eval_folder.id, "skill-evals.jsonl", "txt", eval_content,
                folder_path="evals",
            )
            artifacts.append(artifact)

        return GenerationResult(
            artifacts=artifacts,
            skill_md_diff=diff,
            previous_skill_md=previous_skill_md,
            new_skill_md=new_skill_md,
        )

    # -------------------------------------------------------------------
    # Handoff data reading
    # -------------------------------------------------------------------

    def _read_handoff_data(
        self, skill_project_id: str, data_project_id: str
    ) -> dict[str, str]:
        """Read all files from _skill_data/<name>/latest/ in the Skill Project."""
        # Find _skill_data/ root folder
        root_folder = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == skill_project_id,
                Folder.parent_folder_id.is_(None),
                Folder.name == "_skill_data",
            )
            .first()
        )
        if root_folder is None:
            return {}

        # Find data project subfolder (scan children)
        data_folder = None
        for child in (
            self.db.query(Folder)
            .filter(
                Folder.project_id == skill_project_id,
                Folder.parent_folder_id == root_folder.id,
            )
            .all()
        ):
            latest = (
                self.db.query(Folder)
                .filter(
                    Folder.project_id == skill_project_id,
                    Folder.parent_folder_id == child.id,
                    Folder.name == "latest",
                )
                .first()
            )
            if latest is None:
                continue
            manifest = (
                self.db.query(Doc)
                .filter(
                    Doc.project_id == skill_project_id,
                    Doc.folder_id == latest.id,
                    Doc.name == "manifest.json",
                )
                .first()
            )
            if manifest is None:
                continue
            try:
                payload = json.loads(manifest.content or "{}")
            except json.JSONDecodeError:
                continue
            if payload.get("project_id") == data_project_id:
                data_folder = child
                break

        if data_folder is None:
            return {}

        latest_folder = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == skill_project_id,
                Folder.parent_folder_id == data_folder.id,
                Folder.name == "latest",
            )
            .first()
        )
        if latest_folder is None:
            return {}

        # Read all docs in latest/
        docs = (
            self.db.query(Doc)
            .filter(
                Doc.project_id == skill_project_id,
                Doc.folder_id == latest_folder.id,
            )
            .all()
        )
        return {doc.name: doc.content or "" for doc in docs}

    def _read_current_skill_md(self, skill_project_id: str) -> str:
        """Read the current SKILL.md from the project root."""
        doc = (
            self.db.query(Doc)
            .filter(
                Doc.project_id == skill_project_id,
                Doc.folder_id.is_(None),
                Doc.name == "SKILL.md",
            )
            .first()
        )
        return doc.content or "" if doc else ""

    def _get_root_folder_id(self, skill_project_id: str) -> str | None:
        """Get the root folder ID (None for root-level docs)."""
        return None  # SKILL.md and top-level folders use None as parent

    # -------------------------------------------------------------------
    # SKILL.md generation
    # -------------------------------------------------------------------

    def _generate_skill_md(
        self,
        *,
        previous_skill_md: str,
        handoff: dict[str, str],
        custom_instructions: str = "",
    ) -> str:
        """Generate optimized SKILL.md content.

        Strategy (inspired by hermes prompt policy):
        1. If no previous SKILL.md, create a new one from diagnosis
        2. If previous exists, patch it with new insights
        """
        if not previous_skill_md:
            return self._create_new_skill_md(handoff, custom_instructions)

        # Patch existing SKILL.md
        return self._patch_skill_md(previous_skill_md, handoff, custom_instructions)

    def _create_new_skill_md(
        self, handoff: dict[str, str], custom_instructions: str
    ) -> str:
        """Create a new SKILL.md from scratch based on diagnosis."""
        brief = handoff.get("optimization-brief.md", "")
        failure_patterns = handoff.get("failure-patterns.md", "")
        golden = handoff.get("golden-examples.md", "")

        sections = [
            "# Generated Skill",
            "",
            "Auto-generated from Data Project optimization signals.",
            "",
        ]

        if brief:
            sections.append("## Optimization Summary")
            sections.append(brief)
            sections.append("")

        if failure_patterns:
            sections.append("## Known Failure Patterns")
            sections.append("Avoid the following patterns identified from labeled data:")
            sections.append("")
            # Extract just the pattern names
            for line in failure_patterns.split("\n"):
                if line.startswith("## "):
                    sections.append(f"- {line[3:].strip()}")
            sections.append("")

        if golden:
            sections.append("## Reference Examples")
            sections.append("Follow these successful patterns:")
            sections.append("")
            sections.append("See `references/golden-examples.md` for details.")
            sections.append("")

        if custom_instructions:
            sections.append("## Additional Instructions")
            sections.append(custom_instructions)
            sections.append("")

        return "\n".join(sections)

    def _patch_skill_md(
        self,
        previous: str,
        handoff: dict[str, str],
        custom_instructions: str,
    ) -> str:
        """Patch existing SKILL.md with optimization insights.

        Adds a new section at the end with optimization-derived guidance,
        without modifying existing content.
        """
        failure_patterns = handoff.get("failure-patterns.md", "")
        brief = handoff.get("optimization-brief.md", "")

        # Check if optimization section already exists
        marker = "<!-- optimization-start -->"
        end_marker = "<!-- optimization-end -->"

        if marker in previous:
            # Replace existing optimization section
            before = previous[: previous.index(marker)]
            after_start = previous.index(end_marker) + len(end_marker)
            after = previous[after_start:]
        else:
            before = previous.rstrip() + "\n"
            after = ""

        # Build optimization section
        opt_lines = [
            "",
            marker,
            "",
            "## Optimization Guidance",
            "",
            f"_Auto-updated from Data Project signals at {datetime.utcnow().isoformat()}_",
            "",
        ]

        if brief:
            opt_lines.append("### Summary")
            opt_lines.append(brief.strip())
            opt_lines.append("")

        if failure_patterns:
            opt_lines.append("### Failure Patterns to Avoid")
            for line in failure_patterns.split("\n"):
                if line.startswith("## "):
                    opt_lines.append(f"- {line[3:].strip()}")
            opt_lines.append("")
            opt_lines.append("See `references/failure-patterns.md` for details.")
            opt_lines.append("")

        if custom_instructions:
            opt_lines.append("### Custom Instructions")
            opt_lines.append(custom_instructions)
            opt_lines.append("")

        opt_lines.append(end_marker)
        opt_lines.append("")

        return before + "\n".join(opt_lines) + after

    # -------------------------------------------------------------------
    # References generation
    # -------------------------------------------------------------------

    def _generate_references(self, handoff: dict[str, str]) -> dict[str, str]:
        """Generate references/ files from handoff data."""
        refs: dict[str, str] = {}

        for name in [
            "failure-patterns.md",
            "golden-examples.md",
            "negative-examples.md",
            "workflow-insights.md",
            "optimization-brief.md",
        ]:
            content = handoff.get(name, "")
            if content:
                refs[name] = content

        return refs

    # -------------------------------------------------------------------
    # Eval cases parsing
    # -------------------------------------------------------------------

    def _parse_eval_cases(self, content: str) -> list[dict]:
        """Parse eval-cases.jsonl content."""
        if not content:
            return []
        cases = []
        for line in content.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                cases.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return cases

    # -------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------

    def _write_doc(
        self,
        fs: ProjectFsService,
        folder_id: str | None,
        name: str,
        format: str,
        content: str,
        folder_path: str = "",
    ) -> GeneratedArtifact:
        """Write a doc and return artifact metadata."""
        existing = self._find_doc(fs, folder_id, name)
        action = "updated" if existing else "created"
        doc = fs.create_doc(folder_id=folder_id, name=name, format=format, content=content)
        path = f"{folder_path}/{name}" if folder_path else name
        return GeneratedArtifact(
            path=path,
            kind="doc",
            action=action,
            size_bytes=len((doc.content or "").encode("utf-8")),
        )

    def _find_doc(
        self, fs: ProjectFsService, folder_id: str | None, name: str
    ) -> Doc | None:
        """Find a doc by folder_id and name."""
        q = self.db.query(Doc).filter(
            Doc.project_id == fs.project.id,
            Doc.name == name,
        )
        if folder_id is None:
            q = q.filter(Doc.folder_id.is_(None))
        else:
            q = q.filter(Doc.folder_id == folder_id)
        return q.first()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _compute_diff(old: str, new: str) -> str:
    """Simple line-based diff for display."""
    if not old:
        return f"+++ New file ({len(new)} chars)"
    if old == new:
        return "(no changes)"

    old_lines = old.splitlines()
    new_lines = new.splitlines()

    diff_lines = []
    max_lines = max(len(old_lines), len(new_lines))
    for i in range(max_lines):
        ol = old_lines[i] if i < len(old_lines) else None
        nl = new_lines[i] if i < len(new_lines) else None
        if ol == nl:
            diff_lines.append(f"  {ol}")
        else:
            if ol is not None:
                diff_lines.append(f"- {ol}")
            if nl is not None:
                diff_lines.append(f"+ {nl}")

    return "\n".join(diff_lines[:50])  # Limit to 50 lines
