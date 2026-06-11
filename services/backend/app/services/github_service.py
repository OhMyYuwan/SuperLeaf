"""GitHub authorization plus repository import/push helpers."""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import tempfile
import urllib.parse
import urllib.request
from urllib.error import HTTPError
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import GitHubAccount, GitHubOAuthState, Project, User
from ..secrets_vault import decrypt, encrypt
from .project_fs_service import ProjectFsService


class GitHubError(RuntimeError):
    pass


@dataclass(frozen=True)
class GitHubRepoRef:
    owner: str
    repo: str
    branch_hint: str = ""

    @property
    def clone_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.repo}.git"

    @property
    def html_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.repo}"


@dataclass(frozen=True)
class GitHubImportResult:
    repo_url: str
    branch: str
    doc_count: int
    file_count: int
    byte_count: int


_HTTPS_RE = re.compile(r"^https://github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$")
_SSH_RE = re.compile(r"^git@github\.com:([^/\s]+)/([^/\s]+?)(?:\.git)?$")


def parse_repo_url(url: str) -> GitHubRepoRef:
    value = url.strip()
    if value.startswith("http://") or value.startswith("https://"):
        parsed = urllib.parse.urlparse(value)
        host = parsed.netloc.lower()
        if host not in {"github.com", "www.github.com"}:
            raise GitHubError("请输入 github.com 仓库链接")
        parts = [urllib.parse.unquote(part) for part in parsed.path.strip("/").split("/") if part]
        if len(parts) < 2:
            raise GitHubError("GitHub 仓库链接不完整")
        owner = parts[0].strip()
        repo = parts[1].removesuffix(".git").strip()
        branch_hint = ""
        if len(parts) >= 4 and parts[2] == "tree":
            branch_hint = "/".join(parts[3:]).strip()
        if not owner or not repo:
            raise GitHubError("GitHub 仓库链接不完整")
        return GitHubRepoRef(owner=owner, repo=repo, branch_hint=branch_hint)

    match = _SSH_RE.match(value)
    if not match:
        raise GitHubError("请输入 GitHub 仓库链接，例如 https://github.com/owner/repo")
    owner = match.group(1).strip()
    repo = match.group(2).strip()
    if not owner or not repo:
        raise GitHubError("GitHub 仓库链接不完整")
    return GitHubRepoRef(owner=owner, repo=repo)


class GitHubService:
    def __init__(self, db: Session, user: User) -> None:
        self.db = db
        self.user = user

    def account(self) -> GitHubAccount | None:
        return (
            self.db.query(GitHubAccount)
            .filter(GitHubAccount.user_id == self.user.id)
            .first()
        )

    def disconnect(self) -> None:
        account = self.account()
        if account is not None:
            self.db.delete(account)
            self.db.commit()

    def connect_token(self, token: str, *, token_type: str = "bearer", scope: str = "") -> GitHubAccount:
        token = token.strip()
        if not token:
            raise GitHubError("GitHub token 不能为空")
        user_info, response_scope = self._api_json("/user", token)
        account = self.account()
        if account is None:
            account = GitHubAccount(user_id=self.user.id)
            self.db.add(account)
        account.github_user_id = str(user_info.get("id") or "")
        account.login = str(user_info.get("login") or "")
        account.name = str(user_info.get("name") or "")
        account.avatar_url = str(user_info.get("avatar_url") or "")
        account.token_type = token_type or "bearer"
        account.scope = scope or response_scope
        account.access_token_enc = encrypt(token)
        account.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(account)
        return account

    def begin_oauth(self) -> str:
        client_id = os.getenv("GITHUB_CLIENT_ID", "").strip()
        if not client_id:
            raise GitHubError("缺少 GITHUB_CLIENT_ID，无法启动 GitHub OAuth")
        state = secrets.token_urlsafe(32)
        self.db.add(GitHubOAuthState(state=state, user_id=self.user.id))
        self.db.commit()
        params = {
            "client_id": client_id,
            "scope": "repo",
            "state": state,
        }
        redirect_uri = os.getenv("GITHUB_OAUTH_REDIRECT_URL", "").strip()
        if redirect_uri:
            params["redirect_uri"] = redirect_uri
        return f"https://github.com/login/oauth/authorize?{urllib.parse.urlencode(params)}"

    def begin_device_flow(self, *, client_id: str | None = None, scope: str = "repo") -> dict:
        app_client_id = _resolve_client_id(client_id)
        payload = {
            "client_id": app_client_id,
            "scope": scope or "repo",
        }
        body = self._post_github_json("https://github.com/login/device/code", payload)
        if "error" in body:
            raise GitHubError(str(body.get("error_description") or body["error"]))
        return body

    def poll_device_flow(self, *, device_code: str, client_id: str | None = None) -> tuple[str, dict, int | None]:
        app_client_id = _resolve_client_id(client_id)
        payload = {
            "client_id": app_client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }
        body = self._post_github_json("https://github.com/login/oauth/access_token", payload)
        if "access_token" in body:
            account = self.connect_token(
                str(body.get("access_token") or ""),
                token_type=str(body.get("token_type") or "bearer"),
                scope=str(body.get("scope") or ""),
            )
            return "connected", {"account": account}, None

        error = str(body.get("error") or "unknown_error")
        if error == "authorization_pending":
            return "pending", {}, None
        if error == "slow_down":
            return "slow_down", {}, int(body.get("interval") or 5)
        if error in {"expired_token", "access_denied", "incorrect_device_code"}:
            return "failed", {"error": str(body.get("error_description") or error)}, None
        return "failed", {"error": str(body.get("error_description") or error)}, None

    def complete_oauth(self, *, code: str, state: str) -> GitHubAccount:
        row = self.db.get(GitHubOAuthState, state)
        if row is None or row.user_id != self.user.id:
            raise GitHubError("GitHub OAuth state 无效或已过期")
        self.db.delete(row)
        self.db.commit()

        client_id = os.getenv("GITHUB_CLIENT_ID", "").strip()
        client_secret = os.getenv("GITHUB_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            raise GitHubError("缺少 GITHUB_CLIENT_ID 或 GITHUB_CLIENT_SECRET")
        payload = {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
        }
        redirect_uri = os.getenv("GITHUB_OAUTH_REDIRECT_URL", "").strip()
        if redirect_uri:
            payload["redirect_uri"] = redirect_uri
        data = urllib.parse.urlencode(payload).encode("utf-8")
        req = urllib.request.Request(
            "https://github.com/login/oauth/access_token",
            data=data,
            headers={"Accept": "application/json", "User-Agent": "SuperLeaf"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # pragma: no cover - network/runtime path
            raise GitHubError(f"GitHub OAuth 交换失败：{exc}") from exc
        if "error" in body:
            raise GitHubError(str(body.get("error_description") or body["error"]))
        token = str(body.get("access_token") or "")
        return self.connect_token(
            token,
            token_type=str(body.get("token_type") or "bearer"),
            scope=str(body.get("scope") or ""),
        )

    def import_repo_into_project(
        self,
        project: Project,
        *,
        repo_url: str,
        branch: str | None = None,
    ) -> GitHubImportResult:
        repo = parse_repo_url(repo_url)
        selected_branch = (branch or repo.branch_hint or "").strip()
        account = self.account()
        token = decrypt(account.access_token_enc) if account else ""
        with tempfile.TemporaryDirectory(prefix="ylw-gh-import-") as tmp:
            target = Path(tmp) / "repo"
            args = ["clone", "--depth", "1"]
            if selected_branch:
                args.extend(["--branch", selected_branch])
            args.extend([repo.clone_url, str(target)])
            self._git(Path(tmp), *args, token=token)
            actual_branch = self._git(target, "branch", "--show-current", token=token).stdout.strip()
            doc_count, file_count, byte_count = ProjectFsService(self.db, project).replace_from_directory(target)
        return GitHubImportResult(
            repo_url=repo.html_url,
            branch=actual_branch or selected_branch,
            doc_count=doc_count,
            file_count=file_count,
            byte_count=byte_count,
        )

    def push_archive_repo(
        self,
        *,
        local_repo_path: Path,
        repo_url: str,
        branch: str,
    ) -> str:
        account = self.account()
        if account is None:
            raise GitHubError("请先授权 GitHub 账户")
        token = decrypt(account.access_token_enc)
        if not token:
            raise GitHubError("GitHub 授权已失效，请重新授权")
        repo = parse_repo_url(repo_url)
        if not (local_repo_path / ".git").exists():
            raise GitHubError("本地归档仓库尚未初始化")
        sha = self._git(local_repo_path, "rev-parse", "HEAD", token=token).stdout.strip()
        if not sha:
            raise GitHubError("本地归档没有可推送的 commit")
        target = f"HEAD:refs/heads/{branch or 'yuwanlab-archive'}"
        self._git(local_repo_path, "push", repo.clone_url, target, token=token)
        return sha

    def _api_json(self, path: str, token: str) -> tuple[dict, str]:
        req = urllib.request.Request(
            f"https://api.github.com{path}",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "User-Agent": "SuperLeaf",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                scope = resp.headers.get("X-OAuth-Scopes", "")
                return json.loads(resp.read().decode("utf-8")), scope
        except Exception as exc:  # pragma: no cover - network/runtime path
            raise GitHubError(f"GitHub API 请求失败：{exc}") from exc

    def _post_github_json(self, url: str, payload: dict) -> dict:
        data = urllib.parse.urlencode(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Accept": "application/json", "User-Agent": "SuperLeaf"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = {}
            detail = (
                body.get("error_description")
                or body.get("error")
                or raw.strip()
                or f"HTTP {exc.code}"
            )
            raise GitHubError(f"GitHub 授权请求失败：{detail}") from exc
        except Exception as exc:  # pragma: no cover - network/runtime path
            raise GitHubError(f"GitHub 授权请求失败：{exc}") from exc

    def _git(self, cwd: Path, *args: str, token: str = ""):
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        env["GIT_TERMINAL_PROMPT"] = "0"
        with tempfile.TemporaryDirectory(prefix="ylw-gh-askpass-") as tmp:
            if token:
                askpass = Path(tmp) / "askpass.sh"
                askpass.write_text(
                    "#!/bin/sh\n"
                    "case \"$1\" in\n"
                    "*Username*) printf '%s\\n' 'x-access-token' ;;\n"
                    "*) printf '%s\\n' \"$GITHUB_TOKEN\" ;;\n"
                    "esac\n",
                    encoding="utf-8",
                )
                askpass.chmod(0o700)
                env["GIT_ASKPASS"] = str(askpass)
                env["GITHUB_TOKEN"] = token
            try:
                result = subprocess.run(
                    ["git", *args],
                    cwd=cwd,
                    env=env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                    timeout=300,  # 5 minutes
                )
            except subprocess.TimeoutExpired as exc:
                raise GitHubError(
                    f"Git operation timed out after 5 minutes. This usually means a network issue or "
                    f"the repository is very large. Command: git {' '.join(args)}"
                ) from exc
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise GitHubError(_redact(detail))
        return result


def _redact(text: str) -> str:
    return re.sub(r"(x-access-token:)[^@\s]+", r"\1***", text)


def _resolve_client_id(client_id: str | None) -> str:
    value = (client_id or os.getenv("GITHUB_CLIENT_ID", "")).strip()
    if not value:
        raise GitHubError("缺少 GitHub OAuth App Client ID")
    return value
