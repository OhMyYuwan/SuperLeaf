"""Test git subprocess timeout protection."""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.services.github_service import GitHubError, GitHubService
from app.services.project_archive_service import ArchiveError, ProjectArchiveService


def test_github_service_git_timeout():
    """GitHub git operations should timeout after 5 minutes."""
    user = MagicMock()
    user.id = "user1"
    svc = GitHubService(db=MagicMock(), user=user)

    with patch("app.services.github_service.subprocess.run") as mock_run:
        # Simulate timeout
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["git", "clone"], timeout=300)

        with pytest.raises(GitHubError) as exc_info:
            svc._git(Path("/tmp"), "clone", "https://example.com/repo.git")

        assert "timed out after 5 minutes" in str(exc_info.value)
        assert "git clone" in str(exc_info.value)

        # Verify timeout parameter was passed
        mock_run.assert_called_once()
        call_kwargs = mock_run.call_args.kwargs
        assert call_kwargs.get("timeout") == 300


def test_archive_service_git_timeout():
    """Archive git operations should timeout after 5 minutes."""
    user = MagicMock()
    user.id = "user1"
    user.email = "user@example.com"
    user.display_name = "User"

    project = MagicMock()
    project.id = "proj1"

    svc = ProjectArchiveService(db=MagicMock(), project=project, user=user)

    with patch("app.services.project_archive_service.subprocess.run") as mock_run:
        # Simulate timeout
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["git", "push"], timeout=300)

        with pytest.raises(ArchiveError) as exc_info:
            svc._git(Path("/tmp/repo"), "push", "origin", "main")

        assert "timed out after 5 minutes" in str(exc_info.value)
        assert "git push" in str(exc_info.value)

        # Verify timeout parameter was passed
        mock_run.assert_called_once()
        call_kwargs = mock_run.call_args.kwargs
        assert call_kwargs.get("timeout") == 300


def test_archive_service_git_bytes_timeout():
    """Archive _git_bytes should also have timeout protection."""
    user = MagicMock()
    user.id = "user1"
    user.email = "user@example.com"
    user.display_name = "User"

    project = MagicMock()
    project.id = "proj1"

    svc = ProjectArchiveService(db=MagicMock(), project=project, user=user)

    with patch("app.services.project_archive_service.subprocess.run") as mock_run:
        # Simulate timeout
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["git", "log"], timeout=300)

        with pytest.raises(ArchiveError) as exc_info:
            svc._git_bytes(Path("/tmp/repo"), "log", "--format=%H")

        assert "timed out after 5 minutes" in str(exc_info.value)
        assert "git log" in str(exc_info.value)

        # Verify timeout parameter was passed
        mock_run.assert_called_once()
        call_kwargs = mock_run.call_args.kwargs
        assert call_kwargs.get("timeout") == 300


def test_github_git_normal_execution_still_works():
    """Normal git operations should still work with timeout."""
    user = MagicMock()
    user.id = "user1"
    svc = GitHubService(db=MagicMock(), user=user)

    with patch("app.services.github_service.subprocess.run") as mock_run:
        # Simulate successful execution
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "main\n"
        mock_result.stderr = ""
        mock_run.return_value = mock_result

        result = svc._git(Path("/tmp/repo"), "branch", "--show-current")

        assert result.stdout == "main\n"
        assert result.returncode == 0

        # Verify timeout was passed
        call_kwargs = mock_run.call_args.kwargs
        assert call_kwargs.get("timeout") == 300


def test_github_git_uses_tolerant_utf8_decoding():
    """GitHub git operations should not crash on non-UTF-8 command output."""
    user = MagicMock()
    user.id = "user1"
    svc = GitHubService(db=MagicMock(), user=user)

    with patch("app.services.github_service.subprocess.run") as mock_run:
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "ok\n"
        mock_result.stderr = ""
        mock_run.return_value = mock_result

        svc._git(Path("/tmp/repo"), "status", "--short")

        call_kwargs = mock_run.call_args.kwargs
        assert call_kwargs.get("encoding") == "utf-8"
        assert call_kwargs.get("errors") == "replace"


def test_archive_git_uses_tolerant_utf8_decoding():
    """Archive git operations should not crash on non-UTF-8 command output."""
    user = MagicMock()
    user.id = "user1"
    user.email = "user@example.com"
    user.display_name = "User"

    project = MagicMock()
    project.id = "proj1"

    svc = ProjectArchiveService(db=MagicMock(), project=project, user=user)

    with patch("app.services.project_archive_service.subprocess.run") as mock_run:
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "ok\n"
        mock_result.stderr = ""
        mock_run.return_value = mock_result

        svc._git(Path("/tmp/repo"), "status", "--short")

        call_kwargs = mock_run.call_args.kwargs
        assert call_kwargs.get("encoding") == "utf-8"
        assert call_kwargs.get("errors") == "replace"
