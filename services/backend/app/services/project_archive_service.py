"""Project-level archive snapshots backed by a local Git repository."""

from __future__ import annotations

import os
import re
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


@dataclass(frozen=True)
class CommitMeta:
    sha: str
    short_sha: str
    message: str
    author_name: str
    author_email: str
    date: str  # ISO 8601
    insertions: int
    deletions: int
    files_changed: int


@dataclass(frozen=True)
class FileEntry:
    path: str
    blob_sha: str
    size: int


@dataclass(frozen=True)
class FileDiff:
    path: str
    status: str  # A (added), M (modified), D (deleted), R (renamed)
    insertions: int
    deletions: int
    patch: str | None  # unified diff, None for binary


@dataclass(frozen=True)
class CommitDiff:
    from_sha: str
    to_sha: str
    files: list[FileDiff]
    total_insertions: int
    total_deletions: int
    files_changed: int


@dataclass(frozen=True)
class ArchiveDownload:
    filename: str
    content: bytes


GIT_CONTROL_PATH_NAMES = frozenset({".git", ".gitattributes", ".gitignore", ".gitmodules"})


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
        binding.github_repo_url = repo_url.strip() or (
            f"https://github.com/{owner.strip()}/{repo.strip()}"
            if owner.strip() and repo.strip()
            else ""
        )
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

    def push_to_github(
        self,
        message: str | None = None,
    ) -> tuple[ProjectArchiveBinding, ProjectArchiveSnapshot, str]:
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
            _write_archive_file(repo_path, rel, payload)
            byte_count += len(payload)

        for file in files:
            rel = Path(*folder_parts(file.folder_id), _safe_name(file.name))
            payload = file.blob or b""
            _write_archive_file(repo_path, rel, payload)
            byte_count += len(payload)

        readme = (
            f"# {self.project.name}\n\n"
            "This branch is maintained by SuperLeaf as project-level archive snapshots.\n"
            "The editor database remains the working source of truth.\n"
        ).encode()
        _write_archive_file(repo_path, Path("SUPERLEAF_ARCHIVE.md"), readme)
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
        return f"SuperLeaf snapshot: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}"

    def _git(self, repo_path: Path, *args: str, check: bool = True):
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        try:
            result = subprocess.run(
                ["git", *args],
                cwd=repo_path,
                env=env,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                check=False,
                timeout=300,  # 5 minutes
            )
        except subprocess.TimeoutExpired as exc:
            raise ArchiveError(
                f"Git operation timed out after 5 minutes. This usually means a network issue or "
                f"the archive repository is very large. Command: git {' '.join(args)}"
            ) from exc
        if check and result.returncode != 0:
            raise ArchiveError(result.stderr.strip() or f"git {' '.join(args)} failed")
        return result

    def _git_bytes(self, repo_path: Path, *args: str, check: bool = True):
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        try:
            result = subprocess.run(
                ["git", *args],
                cwd=repo_path,
                env=env,
                capture_output=True,
                check=False,
                timeout=300,  # 5 minutes
            )
        except subprocess.TimeoutExpired as exc:
            raise ArchiveError(
                f"Git operation timed out after 5 minutes. This usually means a network issue or "
                f"the archive repository is very large. Command: git {' '.join(args)}"
            ) from exc
        if check and result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            raise ArchiveError(stderr or f"git {' '.join(args)} failed")
        return result

    def _resolve_commit(self, repo_path: Path, sha: str) -> str:
        result = self._git(repo_path, "rev-parse", "--verify", f"{sha}^{{commit}}", check=False)
        if result.returncode != 0:
            raise ArchiveError(f"Commit not found: {sha}")
        return result.stdout.strip()

    def list_commits(self, *, limit: int = 50) -> list[CommitMeta]:
        """List recent commits from the archive repo."""
        binding = self.ensure_binding()
        repo_path = Path(binding.local_repo_path)
        if not (repo_path / ".git").exists():
            return []

        # git log format: sha|short_sha|author_name|author_email|date|message
        result = self._git(
            repo_path,
            "log",
            f"-{limit}",
            "--format=%H|%h|%an|%ae|%aI|%s",
            "--shortstat",
            check=False,
        )
        if result.returncode != 0:
            return []

        commits: list[CommitMeta] = []
        lines = result.stdout.strip().split("\n")
        i = 0
        while i < len(lines):
            if not lines[i].strip():
                i += 1
                continue

            parts = lines[i].split("|", 5)
            if len(parts) < 6:
                i += 1
                continue

            sha, short_sha, author_name, author_email, date, message = parts
            insertions = 0
            deletions = 0
            files_changed = 0

            # Next line might be shortstat
            if i + 1 < len(lines) and "changed" in lines[i + 1]:
                stat_line = lines[i + 1].strip()
                # Parse: " 3 files changed, 45 insertions(+), 12 deletions(-)"
                import re
                if m := re.search(r"(\d+) files? changed", stat_line):
                    files_changed = int(m.group(1))
                if m := re.search(r"(\d+) insertions?\(\+\)", stat_line):
                    insertions = int(m.group(1))
                if m := re.search(r"(\d+) deletions?\(-\)", stat_line):
                    deletions = int(m.group(1))
                i += 2
            else:
                i += 1

            commits.append(
                CommitMeta(
                    sha=sha,
                    short_sha=short_sha,
                    message=message,
                    author_name=author_name,
                    author_email=author_email,
                    date=date,
                    insertions=insertions,
                    deletions=deletions,
                    files_changed=files_changed,
                )
            )

        return commits

    def get_commit_diff(self, sha: str, *, against: str | None = None) -> CommitDiff:
        """
        Get a project diff.

        By default, compare the selected archive commit with the current live
        project tree from the database. If ``against`` is provided, compare the
        two archive commits for callers that still need an explicit pair.
        """
        binding = self.ensure_binding()
        repo_path = Path(binding.local_repo_path)
        if not (repo_path / ".git").exists():
            raise ArchiveError("No git repository found")

        sha = self._resolve_commit(repo_path, sha)
        if against is None:
            self._export_project_tree(repo_path)
            self._git(repo_path, "add", "-A")
            from_sha = sha
            to_sha = "current"
            diff_refs = [sha]
            diff_scope = ["--cached"]
            reset_index_after_diff = True
        else:
            against = self._resolve_commit(repo_path, against)
            from_sha = against
            to_sha = sha
            diff_refs = [against, sha]
            diff_scope = []
            reset_index_after_diff = False

        try:
            # Get file-level stats
            result = self._git(
                repo_path,
                "diff",
                *diff_scope,
                "--numstat",
                *diff_refs,
                check=False,
            )
            if result.returncode != 0:
                raise ArchiveError(f"Failed to get diff: {result.stderr}")

            status_result = self._git(
                repo_path,
                "diff",
                *diff_scope,
                "--name-status",
                *diff_refs,
                check=False,
            )
            if status_result.returncode != 0:
                raise ArchiveError(f"Failed to get diff status: {status_result.stderr}")
            status_by_path = _parse_name_status(status_result.stdout)

            patch_result = self._git(
                repo_path,
                "diff",
                *diff_scope,
                "--patch",
                "--unified=3",
                *diff_refs,
                check=False,
            )
            if patch_result.returncode != 0:
                raise ArchiveError(f"Failed to get diff patch: {patch_result.stderr}")
            patches_by_path = _split_git_patches(patch_result.stdout)
        finally:
            if reset_index_after_diff:
                self._git(repo_path, "reset", "--mixed", "HEAD", check=False)

        files: list[FileDiff] = []
        total_insertions = 0
        total_deletions = 0

        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split("\t", 2)
            if len(parts) < 3:
                continue

            insertions_str, deletions_str, path = parts
            insertions = 0 if insertions_str == "-" else int(insertions_str)
            deletions = 0 if deletions_str == "-" else int(deletions_str)
            total_insertions += insertions
            total_deletions += deletions

            status = status_by_path.get(path, "M")
            patch = patches_by_path.get(path)
            if patch and "Binary files" in patch:
                patch = None

            files.append(
                FileDiff(
                    path=path,
                    status=status,
                    insertions=insertions,
                    deletions=deletions,
                    patch=patch,
                )
            )

        return CommitDiff(
            from_sha=from_sha,
            to_sha=to_sha,
            files=files,
            total_insertions=total_insertions,
            total_deletions=total_deletions,
            files_changed=len(files),
        )

    def list_commit_files(self, sha: str) -> list[FileEntry]:
        """List all files in a commit."""
        binding = self.ensure_binding()
        repo_path = Path(binding.local_repo_path)
        if not (repo_path / ".git").exists():
            raise ArchiveError("No git repository found")

        result = self._git(
            repo_path,
            "ls-tree",
            "-r",
            "-l",
            sha,
            check=False,
        )
        if result.returncode != 0:
            raise ArchiveError(f"Failed to list files: {result.stderr}")

        files: list[FileEntry] = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            # Format: <mode> <type> <object> <size> <path>
            parts = line.split(None, 4)
            if len(parts) < 5:
                continue

            _, _, blob_sha, size_str, path = parts
            size = 0 if size_str == "-" else int(size_str)

            files.append(FileEntry(path=path, blob_sha=blob_sha, size=size))

        return files

    def read_commit_file(self, sha: str, rel_path: str) -> bytes:
        """Read a file from a specific commit."""
        binding = self.ensure_binding()
        repo_path = Path(binding.local_repo_path)
        if not (repo_path / ".git").exists():
            raise ArchiveError("No git repository found")

        commit_sha = self._resolve_commit(repo_path, sha)
        result = self._git_bytes(
            repo_path,
            "show",
            f"{commit_sha}:{rel_path}",
            check=False,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            raise ArchiveError(f"Failed to read file: {stderr}")

        return result.stdout

    def archive_commit_zip(self, sha: str) -> ArchiveDownload:
        """Return a binary ZIP archive for a specific project archive commit."""
        binding = self.ensure_binding()
        repo_path = Path(binding.local_repo_path)
        if not (repo_path / ".git").exists():
            raise ArchiveError("No git repository found")

        commit_sha = self._resolve_commit(repo_path, sha)
        short_sha = self._git(repo_path, "rev-parse", "--short", commit_sha).stdout.strip() or commit_sha[:7]
        prefix = f"{_safe_name(self.project.name)}-{short_sha}/"
        result = self._git_bytes(
            repo_path,
            "archive",
            "--format=zip",
            f"--prefix={prefix}",
            commit_sha,
            check=False,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            raise ArchiveError(f"Failed to archive commit: {stderr}")

        return ArchiveDownload(
            filename=f"{_safe_name(self.project.name)}-{short_sha}.zip",
            content=result.stdout,
        )

    def restore_to_commit(
        self, sha: str, *, message: str | None = None
    ) -> ProjectArchiveSnapshot:
        """
        Safe restore: replay commit content back into the DB and create a new
        commit. Append-only — never modifies git history.
        """
        binding = self.ensure_binding()
        repo_path = Path(binding.local_repo_path)
        if not (repo_path / ".git").exists():
            raise ArchiveError("No git repository found")

        commit_sha = self._resolve_commit(repo_path, sha)

        # Get original commit message for the restore message
        orig_msg_result = self._git(repo_path, "log", "-1", "--format=%s", commit_sha, check=False)
        orig_message = orig_msg_result.stdout.strip() if orig_msg_result.returncode == 0 else ""
        short_sha = commit_sha[:7]

        if message is None or not message.strip():
            message = (
                f"Restore from {short_sha}: {orig_message}"
                if orig_message
                else f"Restore from {short_sha}"
            )

        # List files in target commit
        files = self.list_commit_files(commit_sha)
        commit_files = {f.path: f for f in files}

        # Build current path → entity mapping (mirror of _export_project_tree)
        self._import_tree_to_db(commit_files, commit_sha)

        # Create a new commit with the restored content
        return self.create_snapshot(message)

    def _import_tree_to_db(self, commit_files: dict, sha: str) -> None:
        """
        Restore commit content back into the DB by matching paths against the
        current project tree. Mirror of _export_project_tree.
        """
        from . import version_service

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

        # Build path → entity mapping from current DB
        doc_by_path: dict[str, Doc] = {}
        file_by_path: dict[str, FileBlob] = {}

        for doc in docs:
            rel = "/".join([*folder_parts(doc.folder_id), _safe_name(doc.name)])
            doc_by_path[rel] = doc

        for file in files:
            rel = "/".join([*folder_parts(file.folder_id), _safe_name(file.name)])
            file_by_path[rel] = file

        # Restore content from commit
        for path in commit_files.keys():
            # Skip the auto-generated archive readme
            if path in {"SUPERLEAF_ARCHIVE.md", "YUWANLAB_ARCHIVE.md"}:
                continue

            content = self.read_commit_file(sha, path)

            if path in doc_by_path:
                doc = doc_by_path[path]
                try:
                    text_content = content.decode("utf-8")
                except UnicodeDecodeError:
                    # Skip docs that can't be decoded as text
                    continue
                if doc.content != text_content:
                    doc.content = text_content
                    doc.version += 1
                    doc.collab_generation += 1
                    doc.updated_at = datetime.utcnow()
                    # Trigger version snapshot for Layer 1 history
                    version_service.snapshot(
                        self.db,
                        doc.id,
                        text_content.encode("utf-8"),
                        origin="restore",
                        actor=self.user.id,
                    )
            elif path in file_by_path:
                file = file_by_path[path]
                if file.blob != content:
                    file.blob = content
                    file.size_bytes = len(content)

        self.db.commit()


def _safe_name(name: str) -> str:
    cleaned = "".join("_" if ch in '/\\:\0' else ch for ch in name).strip()
    return cleaned or "untitled"


def _write_archive_file(repo_path: Path, rel_path: Path, content: bytes) -> None:
    _validate_archive_rel_path(rel_path)
    repo_root = repo_path.resolve(strict=False)
    git_root = (repo_path / ".git").resolve(strict=False)
    target = repo_path / rel_path
    resolved_target = target.resolve(strict=False)

    try:
        resolved_target.relative_to(repo_root)
    except ValueError as e:
        raise ArchiveError("Archive export path escapes the repository root") from e

    try:
        resolved_target.relative_to(git_root)
    except ValueError:
        pass
    else:
        raise ArchiveError("Git control paths are not allowed in archive exports")

    _write_file(target, content)


def _validate_archive_rel_path(rel_path: Path) -> None:
    if rel_path.is_absolute():
        raise ArchiveError("Archive export path must be relative")
    for part in rel_path.parts:
        if part in {"", ".", ".."} or part.casefold() in GIT_CONTROL_PATH_NAMES:
            raise ArchiveError("Git control paths are not allowed in archive exports")


def _parse_name_status(output: str) -> dict[str, str]:
    statuses: dict[str, str] = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0][0] if parts[0] else "M"
        if status == "R" and len(parts) >= 3:
            statuses[parts[2]] = status
        elif len(parts) >= 2:
            statuses[parts[1]] = status
    return statuses


def _split_git_patches(output: str) -> dict[str, str]:
    patches: dict[str, str] = {}
    current_path: str | None = None
    current_lines: list[str] = []

    def flush() -> None:
        if current_path is not None and current_lines:
            patches[current_path] = "".join(current_lines)

    for line in output.splitlines(keepends=True):
        if line.startswith("diff --git "):
            flush()
            current_lines = [line]
            current_path = None
            match = re.match(r"^diff --git a/(.*) b/(.*)\r?\n?$", line)
            if match:
                current_path = match.group(2)
        else:
            current_lines.append(line)
    flush()

    return patches


def _write_file(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
