from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Doc, Project, User
from app.services import latex_compiler
from app.services.latex_compiler import LatexCompilerService
from app.services.project_entry_name import ProjectEntryNameError


@pytest.fixture()
def db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture()
def project_with_main(db: Session) -> tuple[Project, Doc]:
    owner = User(id="owner", email="owner@example.com", password_hash="hash", display_name="Owner")
    project = Project(id="project-a", user_id=owner.id, name="Project A")
    main_doc = Doc(
        id="main-doc",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content=r"\documentclass{article}\begin{document}hello\end{document}",
    )
    db.add_all([owner, project, main_doc])
    db.commit()
    return project, main_doc


@pytest.mark.asyncio
async def test_latexmk_runs_with_rc_files_disabled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    service = LatexCompilerService()
    captured_commands: list[list[str]] = []

    async def fake_run_command(
        cmd: list[str],
        *,
        cwd: Path,
        env: dict[str, str],
    ) -> tuple[int | str, str]:
        del env
        captured_commands.append(cmd)
        (cwd / "main.pdf").write_bytes(b"%PDF-1.7\n")
        return 0, "Rc files read (in order):\n  NONE\n"

    monkeypatch.setattr(service, "_run_command", fake_run_command)

    result = await service._run_compiler(
        tmpdir=tmp_path,
        main_rel_path=Path("main.tex"),
        compiler="latexmk",
        source_paths={},
    )

    assert result.ok is True
    assert captured_commands
    assert captured_commands[0][0] == "latexmk"
    assert "-norc" in captured_commands[0]


def test_compile_tree_rejects_latexmk_control_file(
    db: Session,
    project_with_main: tuple[Project, Doc],
    tmp_path: Path,
) -> None:
    project, main_doc = project_with_main
    db.add(
        Doc(
            id="latexmkrc-doc",
            project_id=project.id,
            folder_id=None,
            name=".latexmkrc",
            format="tex",
            content='system("touch should-not-run")',
        )
    )
    db.commit()
    service = LatexCompilerService()

    with pytest.raises(ProjectEntryNameError, match="compiler control"):
        service._write_project_tree(db, project.id, tmp_path / "compile", main_doc)

    assert not (tmp_path / "compile" / ".latexmkrc").exists()


def test_compile_env_forces_paranoid_tex_file_policies(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("openin_any", "a")
    monkeypatch.setenv("openout_any", "a")

    env = LatexCompilerService._compile_env(tmp_path, tmp_path / "project")

    assert env["openin_any"] == "p"
    assert env["openout_any"] == "p"


def test_compile_subprocess_applies_resource_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, tuple[int, int]]] = []

    def fake_setrlimit(limit: int, values: tuple[int, int]) -> None:
        calls.append((limit, values))

    monkeypatch.setattr(latex_compiler.resource, "setrlimit", fake_setrlimit)

    LatexCompilerService._apply_compile_resource_limits()

    limit_names = {
        getattr(__import__("resource"), "RLIMIT_CPU", None),
        getattr(__import__("resource"), "RLIMIT_FSIZE", None),
        getattr(__import__("resource"), "RLIMIT_NPROC", None),
        getattr(__import__("resource"), "RLIMIT_AS", None),
    }
    seen = {limit for limit, _values in calls}
    assert seen >= {limit for limit in limit_names if limit is not None}


@pytest.mark.asyncio
async def test_direct_compilers_disable_shell_escape_on_every_pass(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    service = LatexCompilerService()
    captured_commands: list[list[str]] = []

    async def fake_run_command(
        cmd: list[str],
        *,
        cwd: Path,
        env: dict[str, str],
    ) -> tuple[int | str, str]:
        del env
        captured_commands.append(cmd)
        (cwd / "main.pdf").write_bytes(b"%PDF-1.7\n")
        return 0, "ok"

    monkeypatch.setattr(service, "_run_command", fake_run_command)

    result = await service._run_compiler(
        tmpdir=tmp_path,
        main_rel_path=Path("main.tex"),
        compiler="pdflatex",
        source_paths={},
    )

    assert result.ok is True
    assert len(captured_commands) == 3
    assert all(cmd[0] == "pdflatex" for cmd in captured_commands)
    assert all("-no-shell-escape" in cmd for cmd in captured_commands)
