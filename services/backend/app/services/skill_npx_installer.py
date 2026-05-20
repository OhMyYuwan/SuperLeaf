"""Install open Agent Skills into a Native Agent workspace via npx."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile

from ..models import NativeAgent
from ..settings import settings
from .agent_workspace_service import AgentWorkspaceService, find_installed_skill_folder


class SkillNpxInstallError(RuntimeError):
    pass


@dataclass(slots=True)
class SkillInstallRecipe:
    repo_url: str
    skill_name: str
    source_url: str = ""
    install_command: str = ""
    marketplace_id: str = ""
    source_ref: str = ""
    source: str = "marketplace"


@dataclass(slots=True)
class SkillInstallResult:
    folder_name: str
    folder_path: str
    manifest: dict
    install_command: str
    log: str


class SkillNpxInstaller:
    def __init__(self, workspace: AgentWorkspaceService | None = None) -> None:
        self.workspace = workspace or AgentWorkspaceService()

    def install(self, agent: NativeAgent, recipe: SkillInstallRecipe) -> SkillInstallResult:
        source_url = _validate_source_url(recipe.source_url or recipe.repo_url)
        skill_name = _validate_skill_name(recipe.skill_name, required=not _is_direct_skill_source(source_url))
        command = ["npx", "--yes", "skills", "add", source_url]
        if skill_name and not _is_direct_skill_source(source_url):
            command.extend(["--skill", skill_name])
        command.extend(["--agent", "codex", "--copy", "--yes"])
        display_command = recipe.install_command.strip() or " ".join(command)

        tmp_parent = settings.data_dir / "tmp" / "native-skill-installs"
        tmp_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="skill-", dir=tmp_parent) as tmp:
            tmp_path = Path(tmp)
            home = tmp_path / "home"
            codex_home = tmp_path / "codex"
            agents_home = tmp_path / "agents"
            home.mkdir()
            codex_home.mkdir()
            agents_home.mkdir()
            env = {
                **os.environ,
                "HOME": str(home),
                "CODEX_HOME": str(codex_home),
                "AGENTS_HOME": str(agents_home),
                "NO_COLOR": "1",
            }
            try:
                proc = subprocess.run(
                    command,
                    cwd=tmp_path,
                    env=env,
                    text=True,
                    capture_output=True,
                    timeout=180,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise SkillNpxInstallError("npx skills add timed out") from exc
            log = _clip_log((proc.stdout or "") + ("\n" if proc.stdout and proc.stderr else "") + (proc.stderr or ""))
            if proc.returncode != 0:
                raise SkillNpxInstallError(log or f"npx skills add failed with exit code {proc.returncode}")

            source_folder = find_installed_skill_folder(tmp_path, preferred_skill_name=skill_name)
            folder_name = _folder_name(recipe, source_folder)
            dest, manifest = self.workspace.install_skill_folder(agent, source_folder, folder_name=folder_name)
            return SkillInstallResult(
                folder_name=dest.name,
                folder_path=str(dest),
                manifest=manifest,
                install_command=display_command,
                log=log or "Installed successfully.",
            )


def _validate_source_url(value: str) -> str:
    cleaned = str(value or "").strip()
    if not cleaned:
        raise SkillNpxInstallError("repo_url or source_url is required")
    if any(ch in cleaned for ch in "\n\r\t"):
        raise SkillNpxInstallError("repo_url contains invalid whitespace")
    if not (
        cleaned.startswith("https://github.com/")
        or cleaned.startswith("git@github.com:")
        or re.fullmatch(r"@?[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*", cleaned)
    ):
        raise SkillNpxInstallError("repo_url must be a GitHub repo or skills package")
    return cleaned


def _validate_skill_name(value: str, *, required: bool) -> str:
    cleaned = str(value or "").strip()
    if required and not cleaned:
        raise SkillNpxInstallError("skill_name is required")
    if any(ch in cleaned for ch in "\n\r\t /\\"):
        raise SkillNpxInstallError("skill_name must be a single skill name")
    return cleaned


def _is_direct_skill_source(value: str) -> bool:
    return "github.com/" in value and "/tree/" in value


def _folder_name(recipe: SkillInstallRecipe, source_folder: Path) -> str:
    if recipe.marketplace_id:
        return recipe.marketplace_id
    if "@" in source_folder.name:
        return source_folder.name
    return recipe.skill_name or source_folder.name


def _clip_log(value: str) -> str:
    text = value.strip()
    if len(text) <= 12000:
        return text
    return text[-12000:]
