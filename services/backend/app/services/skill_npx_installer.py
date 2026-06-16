"""Install open Agent Skills into a Native Agent workspace via npx."""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

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


SAFE_NPX_PREFIX_FLAGS = {"--yes", "-y"}


class SkillNpxInstaller:
    def __init__(self, workspace: AgentWorkspaceService | None = None) -> None:
        self.workspace = workspace or AgentWorkspaceService()

    def install(self, agent: NativeAgent, recipe: SkillInstallRecipe) -> SkillInstallResult:
        command, source_url, skill_name = _command_from_recipe(recipe)
        display_command = " ".join(shlex.quote(part) for part in command)

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
                    encoding="utf-8",
                    errors="replace",
                    capture_output=True,
                    timeout=180,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise SkillNpxInstallError("npx skills add timed out") from exc
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            log = _clip_log(stdout + ("\n" if stdout and stderr else "") + stderr)
            if proc.returncode != 0:
                raise SkillNpxInstallError(log or f"npx skills add failed with exit code {proc.returncode}")

            source_folder = find_installed_skill_folder(tmp_path, preferred_skill_name=skill_name)
            folder_name = _folder_name(recipe, source_folder)
            dest, manifest = self.workspace.install_skill_folder(
                agent,
                source_folder,
                folder_name=folder_name,
            )
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


def _command_from_recipe(recipe: SkillInstallRecipe) -> tuple[list[str], str, str]:
    raw_command = str(recipe.install_command or "").strip()
    if raw_command:
        command, source_url, command_skill_name = _parse_npx_install_command(raw_command)
        skill_name = command_skill_name or _validate_skill_name(recipe.skill_name, required=False)
        if (
            skill_name
            and "--skill" not in command
            and not any(part.startswith("--skill=") for part in command)
        ):
            command.extend(["--skill", skill_name])
        command = _ensure_install_flags(command)
        if not _is_direct_skill_source(source_url):
            _validate_skill_name(skill_name, required=True)
        return command, source_url, skill_name

    source_url = _validate_source_url(recipe.source_url or recipe.repo_url)
    skill_name = _validate_skill_name(recipe.skill_name, required=not _is_direct_skill_source(source_url))
    command = ["npx", "--yes", "skills", "add", source_url]
    if skill_name and not _is_direct_skill_source(source_url):
        command.extend(["--skill", skill_name])
    command.extend(["--agent", "codex", "--copy", "--yes"])
    return command, source_url, skill_name


def _parse_npx_install_command(command: str) -> tuple[list[str], str, str]:
    try:
        parts = shlex.split(command)
    except ValueError as exc:
        raise SkillNpxInstallError("install_command must be a valid npx command") from exc
    if not parts or parts[0] != "npx":
        raise SkillNpxInstallError("install_command must start with npx")
    skills_index = -1
    for idx in range(len(parts) - 1):
        if parts[idx] == "skills" and parts[idx + 1] == "add":
            skills_index = idx
            break
    if skills_index < 0 or skills_index + 2 >= len(parts):
        raise SkillNpxInstallError("install_command must contain `skills add <source>`")
    _validate_npx_install_command_parts(parts, skills_index)
    source_url = _validate_source_url(parts[skills_index + 2])
    skill_name = ""
    rest = parts[skills_index + 3 :]
    for idx, item in enumerate(rest):
        if item == "--skill" and idx + 1 < len(rest):
            skill_name = _validate_skill_name(rest[idx + 1], required=False)
            break
        if item.startswith("--skill="):
            skill_name = _validate_skill_name(item.split("=", 1)[1], required=False)
            break
    return parts, source_url, skill_name


def _validate_npx_install_command_parts(parts: list[str], skills_index: int) -> None:
    for item in parts[1:skills_index]:
        if item not in SAFE_NPX_PREFIX_FLAGS:
            raise SkillNpxInstallError("install_command contains unsupported npx execution flags")

    rest = parts[skills_index + 3 :]
    idx = 0
    while idx < len(rest):
        item = rest[idx]
        if item in {"--yes", "-y", "--copy"}:
            idx += 1
            continue
        if item == "--skill":
            if idx + 1 >= len(rest):
                raise SkillNpxInstallError("install_command --skill requires a value")
            _validate_skill_name(rest[idx + 1], required=True)
            idx += 2
            continue
        if item.startswith("--skill="):
            _validate_skill_name(item.split("=", 1)[1], required=True)
            idx += 1
            continue
        if item == "--agent":
            if idx + 1 >= len(rest):
                raise SkillNpxInstallError("install_command --agent requires a value")
            if rest[idx + 1] != "codex":
                raise SkillNpxInstallError("install_command --agent must be codex")
            idx += 2
            continue
        if item.startswith("--agent="):
            if item.split("=", 1)[1] != "codex":
                raise SkillNpxInstallError("install_command --agent must be codex")
            idx += 1
            continue
        if item.startswith("-"):
            raise SkillNpxInstallError("install_command contains unsupported skills add flags")
        raise SkillNpxInstallError("install_command contains unexpected extra arguments")


def _ensure_install_flags(command: list[str]) -> list[str]:
    out = list(command)
    if len(out) == 1 or out[1] != "--yes":
        out.insert(1, "--yes")
    if "--agent" not in out:
        out.extend(["--agent", "codex"])
    if "--copy" not in out:
        out.append("--copy")
    if not out or out[-1] != "--yes":
        out.append("--yes")
    return out


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
