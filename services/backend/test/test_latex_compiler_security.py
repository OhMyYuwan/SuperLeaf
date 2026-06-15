from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Doc, Project, User
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
