"""Project-level archive snapshots backed by a local Git repository."""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import (
    Doc,
    FileBlob,
    Folder,
    Project,
    ProjectArchiveBinding,
    ProjectArchiveSnapshot,
    User,
)
from ..settings import settings
from .github_service import GitHubError, GitHubService, parse_repo_url


class ArchiveError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExportStats:
    doc_count: int
    file_count: int
    byte_count: int


class ProjectArchiveService:
    def __init__(self, db: Session, project: Project, user: User) -> None:
        self.db = db
        self.project = project
        self.user = user

    def status(self, *, limit: int = 20) -> tuple[ProjectArchiveBinding, list[ProjectArchiveSnapshot], bool]:
        binding = self.ensure_binding()
        snapshots = self.list_snapshots(limit=limit)
        return binding, snapshots, self._is_dirty(binding)

    def ensure_binding(self) -> ProjectArchiveBinding:
        binding = (
            self.db.query(ProjectArchiveBinding)
            .filter(ProjectArchiveBinding.project_id == self.project.id)
            .first()
        )
        if binding is not None:
            if not binding.local_repo_path:
                binding.local_repo_path = str(self._default_repo_path())
                self.db.commit()
                self.db.refresh(binding)
            return binding

        binding = ProjectArchiveBinding(
            project_id=self.project.id,
            user_id=self.project.user_id or self.user.id,
            local_repo_path=str(self._default_repo_path()),
            github_branch="yuwanlab-archive",
            github_private_required=True,
        )
        self.db.add(binding)
        self.db.commit()
        self.db.refresh(binding)
        return binding

    def configure_github(
        self,
        *,
        repo_url: str,
        owner: str,
        repo: str,
        branch: str,
        path: str,
        private_required: bool,
    ) -> ProjectArchiveBinding:
        if repo_url.strip():
            try:
                parsed = parse_repo_url(repo_url)
            except GitHubError as e:
                raise ArchiveError(str(e)) from e
            owner = parsed.owner
            repo = parsed.repo
        binding = self.ensure_binding()
        account = GitHubService(self.db, self.user).account()
        binding.github_account_id = account.id if account else binding.github_account_id
        binding.github_repo_url = repo_url.strip() or (f"https://github.com/{owner.strip()}/{repo.strip()}" if owner.strip() and repo.strip() else "")
        binding.github_owner = owner.strip()
        binding.github_repo = repo.strip()
        binding.github_branch = branch.strip() or "yuwanlab-archive"
        binding.github_path = path.strip().strip("/")
        binding.github_private_required = bool(private_required)
        binding.github_bound_at = datetime.utcnow() if binding.github_owner and binding.github_repo else None
        binding.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(binding)
        return binding

    def create_snapshot(self, message: str | None = None) -> ProjectArchiveSnapshot:
        binding = self.ensure_binding()
        repo_path = Path(binding.local_repo_path)
        self._ensure_git_repo(repo_path)
        stats = self._export_project_tree(repo_path)

        self._git(repo_path, "add", "-A")
        if not self._has_staged_changes(repo_path):
            sha = self._current_commit(repo_path)
            if not sha:
                # Empty first commit, useful when a project truly has no files.
                self._git(repo_path, "commit", "--allow-empty", "-m", self._message(message))
                sha = self._current_commit(repo_path)
            existing = (
                self.db.query(ProjectArchiveSnapshot)
                .filter(ProjectArchiveSnapshot.project_id == self.project.id)
                .filter(ProjectArchiveSnapshot.commit_sha == sha)
                .first()
            )
            if existing is not None:
                return existing
        else:
            self._git(repo_path, "commit", "-m", self._message(message))
            sha = self._current_commit(repo_path)

        if not sha:
            raise ArchiveError("failed to create archive commit")

        snapshot = ProjectArchiveSnapshot(
            project_id=self.project.id,
            user_id=self.user.id,
            commit_sha=sha,
            message=self._message(message),
            doc_count=stats.doc_count,
            file_count=stats.file_count,
            byte_count=stats.byte_count,
            pushed_to_github=False,
        )
        binding.last_local_commit_sha = sha
        binding.updated_at = datetime.utcnow()
        self.db.add(snapshot)
        self.db.commit()
        self.db.refresh(snapshot)
        return snapshot

    def list_snapshots(self, *, limit: int = 20) -> list[ProjectArchiveSnapshot]:
        return (
            self.db.query(ProjectArchiveSnapshot)
            .filter(ProjectArchiveSnapshot.project_id == self.project.id)
            .order_by(ProjectArchiveSnapshot.created_at.desc())
            .limit(limit)
            .all()
        )

    def push_to_github(self, message: str | None = None) -> tuple[ProjectArchiveBinding, ProjectArchiveSnapshot, str]:
        binding = self.ensure_binding()
        if not binding.github_repo_url and not (binding.github_owner and binding.github_repo):
            raise ArchiveError("请先填写 GitHub 仓库链接")
        if binding.github_path:
            raise ArchiveError("当前上传模式推送整个 archive branch，暂不支持 GitHub 子目录 Path")
        snapshot = self.create_snapshot(message)
        repo_url = binding.github_repo_url or f"https://github.com/{binding.github_owner}/{binding.github_repo}"
        try:
            sha = GitHubService(self.db, self.user).push_archive_repo(
                local_repo_path=Path(binding.local_repo_path),
                repo_url=repo_url,
                branch=binding.github_branch or "yuwanlab-archive",
            )
        except GitHubError as e:
            raise ArchiveError(str(e)) from e

        snapshot.pushed_to_github = True
        binding.last_pushed_commit_sha = sha
        binding.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(binding)
        self.db.refresh(snapshot)
        return binding, snapshot, sha

    def _default_repo_path(self) -> Path:
        return settings.data_dir / "archives" / self.project.id

    def _ensure_git_repo(self, repo_path: Path) -> None:
        repo_path.mkdir(parents=True, exist_ok=True)
        if not (repo_path / ".git").exists():
            self._git(repo_path, "init")
            self._git(repo_path, "checkout", "-B", "yuwanlab-archive")
        self._git(repo_path, "config", "user.name", self.user.display_name or self.user.email)
        self._git(repo_path, "config", "user.email", self.user.email)

    def _export_project_tree(self, repo_path: Path) -> ExportStats:
        for child in repo_path.iterdir():
            if child.name == ".git":
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

        folders = self.db.query(Folder).filter(Folder.project_id == self.project.id).all()
        docs = self.db.query(Doc).filter(Doc.project_id == self.project.id).all()
        files = self.db.query(FileBlob).filter(FileBlob.project_id == self.project.id).all()

        folder_by_id = {folder.id: folder for folder in folders}

        def folder_parts(folder_id: str | None) -> list[str]:
            parts: list[str] = []
            seen: set[str] = set()
            current = folder_id
            while current and current not in seen:
                seen.add(current)
                folder = folder_by_id.get(current)
                if folder is None:
                    break
                parts.append(_safe_name(folder.name))
                current = folder.parent_folder_id
            parts.reverse()
            return parts

        byte_count = 0
        for doc in docs:
            rel = Path(*folder_parts(doc.folder_id), _safe_name(doc.name))
            payload = (doc.content or "").encode("utf-8")
            _write_file(repo_path / rel, payload)
            byte_count += len(payload)

        for file in files:
            rel = Path(*folder_parts(file.folder_id), _safe_name(file.name))
            payload = file.blob or b""
            _write_file(repo_path / rel, payload)
            byte_count += len(payload)

        readme = (
            f"# {self.project.name}\n\n"
            "This branch is maintained by YuwanLabWriter as project-level archive snapshots.\n"
            "The editor database remains the working source of truth.\n"
        ).encode("utf-8")
        _write_file(repo_path / "YUWANLAB_ARCHIVE.md", readme)
        byte_count += len(readme)
        return ExportStats(doc_count=len(docs), file_count=len(files), byte_count=byte_count)

    def _is_dirty(self, binding: ProjectArchiveBinding) -> bool:
        repo_path = Path(binding.local_repo_path)
        if not (repo_path / ".git").exists():
            return False
        try:
            return bool(self._git(repo_path, "status", "--porcelain").stdout.strip())
        except ArchiveError:
            return False

    def _has_staged_changes(self, repo_path: Path) -> bool:
        return self._git(repo_path, "diff", "--cached", "--quiet", check=False).returncode != 0

    def _current_commit(self, repo_path: Path) -> str:
        result = self._git(repo_path, "rev-parse", "HEAD", check=False)
        return result.stdout.strip() if result.returncode == 0 else ""

    def _message(self, message: str | None) -> str:
        text = (message or "").strip()
        if text:
            return text
        return f"YuwanLabWriter snapshot: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}"

    def _git(self, repo_path: Path, *args: str, check: bool = True):
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        result = subprocess.run(
            ["git", *args],
            cwd=repo_path,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if check and result.returncode != 0:
            raise ArchiveError(result.stderr.strip() or f"git {' '.join(args)} failed")
        return result


def _safe_name(name: str) -> str:
    cleaned = "".join("_" if ch in '/\\:\0' else ch for ch in name).strip()
    return cleaned or "untitled"


def _write_file(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
