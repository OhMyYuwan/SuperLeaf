"""Filesystem workspace for backend-run Native Agents.

Each Native Agent owns one real workspace:

    <data_dir>/native/<user>/<project>/<agent>/.agents/

Runtime file tools are scoped to that `.agents` folder. The service stores
Skill package files in plain text because this directory is a per-user local
runtime asset, while API keys and provider credentials remain encrypted.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import shutil

from sqlalchemy.orm import Session

from ..models import NativeAgent
from ..settings import settings


SAFE_TEXT_SUFFIXES = {
    ".md",
    ".mdx",
    ".txt",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".csv",
    ".tsv",
    ".py",
    ".js",
    ".ts",
    ".tsx",
}
FORBIDDEN_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}
MAX_FILE_BYTES = 120_000
MAX_TREE_FILES = 160


@dataclass(slots=True)
class WorkspaceFile:
    path: str
    type: str
    size: int = 0


class AgentWorkspaceError(RuntimeError):
    pass


class AgentWorkspaceService:
    def __init__(self, db: Session | None = None) -> None:
        self.db = db

    def root_for(self, *, user_id: str, project_id: str, agent_id: str) -> Path:
        return settings.data_dir / "native" / _safe_segment(user_id) / _safe_segment(project_id) / _safe_segment(agent_id)

    def ensure_workspace(self, agent: NativeAgent, *, agent_md: str | None = None) -> Path:
        root = self.root_for(user_id=agent.owner_user_id, project_id=agent.project_id, agent_id=agent.id)
        agents_dir = root / ".agents"
        skills_dir = agents_dir / "skills"
        skills_dir.mkdir(parents=True, exist_ok=True)
        _chmod_private(root)
        md = agent_md if agent_md is not None else agent.agent_md or agent.instructions
        agent_file = agents_dir / "AGENT.md"
        if md.strip() or not agent_file.exists():
            agent_file.write_text(_agent_md(agent.name, md), encoding="utf-8")
        agent.workspace_path = str(root)
        if not agent.agent_md and md.strip():
            agent.agent_md = md.strip()
        if self.db is not None:
            self.db.add(agent)
        return root

    def write_agent_md(self, agent: NativeAgent, content: str) -> Path:
        root = self.ensure_workspace(agent, agent_md=content)
        agent.agent_md = content.strip()
        path = root / ".agents" / "AGENT.md"
        path.write_text(_agent_md(agent.name, content), encoding="utf-8")
        if self.db is not None:
            self.db.add(agent)
        return path

    def install_skill_folder(self, agent: NativeAgent, source_dir: Path, *, folder_name: str) -> tuple[Path, dict]:
        root = self.ensure_workspace(agent)
        source = source_dir.resolve()
        if not source.exists() or not source.is_dir():
            raise AgentWorkspaceError("Downloaded Skill folder not found")
        if not (source / "SKILL.md").exists():
            raise AgentWorkspaceError("Downloaded Skill folder must contain SKILL.md")

        safe_folder = _safe_folder_name(folder_name or source.name)
        dest = root / ".agents" / "skills" / safe_folder
        if dest.exists():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, dest, ignore=_ignore_unsafe_files)
        if not (dest / "SKILL.md").exists():
            raise AgentWorkspaceError("Skill folder copy did not preserve SKILL.md")
        manifest = self.build_manifest(dest)
        return dest, manifest

    def install_skill_content(self, agent: NativeAgent, *, folder_name: str, content: str) -> tuple[Path, dict]:
        root = self.ensure_workspace(agent)
        safe_folder = _safe_folder_name(folder_name)
        dest = root / ".agents" / "skills" / safe_folder
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "SKILL.md").write_text(content.strip() + "\n", encoding="utf-8")
        manifest = self.build_manifest(dest)
        return dest, manifest

    def remove_skill_folder(self, agent: NativeAgent, folder_name: str) -> None:
        root = self.ensure_workspace(agent)
        dest = self.resolve_inside_agents(root, f".agents/skills/{_safe_folder_name(folder_name)}")
        if dest.exists() and dest.is_dir():
            shutil.rmtree(dest)

    def workspace_tree(self, agent: NativeAgent) -> list[WorkspaceFile]:
        root = self.ensure_workspace(agent)
        return list_agent_workspace_files(root)

    def resolve_inside_agents(self, root: Path, rel_path: str) -> Path:
        return resolve_inside_agents(root, rel_path)

    def build_manifest(self, folder: Path) -> dict:
        files: list[dict] = []
        total_bytes = 0
        for path in sorted(folder.rglob("*")):
            if not path.is_file() or _is_unsafe_path(path.relative_to(folder)):
                continue
            rel = path.relative_to(folder).as_posix()
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if not _is_safe_text_file(path) or size > MAX_FILE_BYTES:
                continue
            total_bytes += size
            files.append({"path": rel, "size": size})
            if len(files) >= MAX_TREE_FILES:
                break
        return {"files": files, "file_count": len(files), "total_bytes": total_bytes}


def list_agent_workspace_files(root: Path, prefix: str = ".agents") -> list[WorkspaceFile]:
    base = resolve_inside_agents(root, prefix)
    if not base.exists():
        return []
    items: list[WorkspaceFile] = []
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if _is_unsafe_path(Path(rel)):
            continue
        if path.is_dir():
            items.append(WorkspaceFile(path=rel, type="directory"))
        elif path.is_file() and _is_safe_text_file(path):
            items.append(WorkspaceFile(path=rel, type="file", size=path.stat().st_size))
        if len(items) >= MAX_TREE_FILES:
            break
    return items


def read_agent_workspace_file(root: Path, rel_path: str) -> str:
    path = resolve_inside_agents(root, rel_path)
    if not path.exists() or not path.is_file():
        raise AgentWorkspaceError("File not found")
    if not _is_safe_text_file(path):
        raise AgentWorkspaceError("Only safe text files can be read")
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise AgentWorkspaceError(f"File too large: {size} bytes")
    return path.read_text(encoding="utf-8", errors="replace")


def resolve_inside_agents(root: Path, rel_path: str) -> Path:
    root_resolved = root.resolve()
    rel = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not rel:
        rel = ".agents"
    if rel == "AGENT.md":
        rel = ".agents/AGENT.md"
    if rel.startswith("skills/"):
        rel = f".agents/{rel}"
    if not (rel == ".agents" or rel.startswith(".agents/")):
        raise AgentWorkspaceError("Path must be inside .agents")
    candidate = (root_resolved / rel).resolve()
    if not candidate.is_relative_to(root_resolved / ".agents"):
        raise AgentWorkspaceError("Path escapes Agent workspace")
    return candidate


def find_installed_skill_folder(search_root: Path, preferred_skill_name: str = "") -> Path:
    candidates: list[Path] = []
    for skill_md in search_root.rglob("SKILL.md"):
        rel_parts = set(skill_md.relative_to(search_root).parts)
        if rel_parts & FORBIDDEN_DIRS:
            continue
        candidates.append(skill_md.parent)
    if not candidates:
        raise AgentWorkspaceError("npx install did not produce a SKILL.md folder")
    preferred = _safe_folder_name(preferred_skill_name).lower()
    if preferred:
        for candidate in candidates:
            name = candidate.name.lower()
            if name == preferred or name.endswith(f"@{preferred}"):
                return candidate
    # Prefer the deepest non-cache folder; npx usually writes to CODEX_HOME/skills/<name>.
    candidates.sort(key=lambda p: (len(p.parts), p.as_posix()), reverse=True)
    return candidates[0]


def _agent_md(name: str, content: str) -> str:
    body = content.strip()
    if body:
        return body + "\n"
    return f"# {name}\n\nYou are a native YuwanLabWriter Agent. Use the Skills in `.agents/skills/` when they are relevant.\n"


def _ignore_unsafe_files(directory: str, names: list[str]) -> set[str]:
    ignored: set[str] = set()
    base = Path(directory)
    for name in names:
        path = base / name
        if name in FORBIDDEN_DIRS or name.startswith(".") and name not in {".agents"}:
            ignored.add(name)
            continue
        if path.is_file() and (not _is_safe_text_file(path) or path.stat().st_size > MAX_FILE_BYTES):
            ignored.add(name)
    return ignored


def _is_unsafe_path(path: Path) -> bool:
    return any(part in FORBIDDEN_DIRS or part == ".." for part in path.parts)


def _is_safe_text_file(path: Path) -> bool:
    if path.name == "SKILL.md":
        return True
    return path.suffix.lower() in SAFE_TEXT_SUFFIXES


def _safe_segment(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(value or "").strip())
    return cleaned[:128] or "unknown"


def _safe_folder_name(value: str) -> str:
    cleaned = str(value or "").strip().replace("\\", "/").split("/")[-1]
    cleaned = "".join(ch if ch.isalnum() or ch in "._@-" else "-" for ch in cleaned)
    return cleaned.strip(".-")[:160] or "skill"


def _chmod_private(path: Path) -> None:
    try:
        path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, 0o700)
    except OSError:
        return
