"""/api/skill-optimization — Data-driven Skill optimization pipeline."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import (
    OptimizationRun,
    Project,
    Skill,
    SkillSedimentation,
    User,
)
from ..schemas.skill_optimization import (
    DiagnosisOut,
    GenerationResultOut,
    HandoffRequest,
    HandoffResultOut,
    OptimizationReviewIn,
    OptimizationRunCreate,
    OptimizationRunListOut,
    OptimizationRunOut,
    SedimentationCreate,
    SedimentationListOut,
    SedimentationOut,
    SedimentationReviewIn,
)
from ..services.dataset_service import DatasetService
from ..services.skill_data_handoff_service import SkillDataHandoffService
from ..services.skill_generation_service import SkillGenerationService
from ..services.skill_signal_diagnosis_service import SkillSignalDiagnosisService
from .deps import get_current_user

router = APIRouter(prefix="/api/skill-optimization", tags=["skill-optimization"])

CurrentUser = Depends(get_current_user)
DbSession = Depends(get_session)


# ---------------------------------------------------------------------------
# OptimizationRun CRUD
# ---------------------------------------------------------------------------


@router.post("/runs", response_model=OptimizationRunOut, status_code=201)
def create_optimization_run(
    body: OptimizationRunCreate,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Create and execute an optimization run.

    1. Validate skill and data project
    2. Run diagnosis on the data project
    3. Write handoff + diagnosis to skill project's _skill_data/
    4. Generate optimized Skill Project files
    """
    # Validate skill
    skill = db.query(Skill).filter(Skill.id == body.skill_id).first()
    if skill is None:
        raise HTTPException(404, "Skill not found")

    # Validate data project
    data_project = (
        db.query(Project)
        .filter(Project.id == body.data_project_id, Project.project_type == "data")
        .first()
    )
    if data_project is None:
        raise HTTPException(404, "Data Project not found")

    # Resolve skill project
    skill_project = (
        db.query(Project)
        .filter(
            Project.project_id == skill.project_id
            if hasattr(Project, "project_id")
            else Project.id == skill.project_id,
            Project.is_skill_project == True,  # noqa: E712
        )
        .first()
    )
    if skill_project is None:
        # Fallback: try by skill.project_id directly
        skill_project = (
            db.query(Project)
            .filter(Project.id == skill.project_id, Project.is_skill_project == True)  # noqa: E712
            .first()
        )
    if skill_project is None:
        raise HTTPException(404, "Skill Project not found for this skill")

    # Create OptimizationRun
    run = OptimizationRun(
        data_project_id=data_project.id,
        skill_id=skill.id,
        skill_project_id=skill_project.id,
        user_id=user.id,
        status="collecting",
        signal_sources=body.signal_sources,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    # Phase 1-2: Run diagnosis
    run.status = "diagnosing"
    db.commit()

    diag_svc = SkillSignalDiagnosisService(db)
    diagnosis = diag_svc.diagnose(
        data_project=data_project,
        include_annotations=body.signal_sources.get("include_annotations", True),
        include_sedimentations=body.signal_sources.get("include_sedimentations", True),
    )
    run.diagnosis = diagnosis.to_dict()
    run.signal_snapshot = diagnosis.summary
    db.commit()

    # Phase 3a: Handoff — write data + diagnosis to _skill_data/
    run.status = "generating"
    db.commit()

    handoff_svc = SkillDataHandoffService(db)
    try:
        handoff_svc.attach_dataset_package(
            skill_project=skill_project,
            data_project=data_project,
            user=user,
            status=body.signal_sources.get("status_filter", "submitted"),
        )
        handoff_svc.attach_diagnosis_results(
            skill_project=skill_project,
            data_project=data_project,
            diagnosis=diagnosis.to_dict(),
        )
    except ValueError as exc:
        run.status = "discarded"
        run.review_notes = f"Handoff failed: {exc}"
        db.commit()
        raise HTTPException(422, str(exc))

    # Phase 3b: Generate optimized Skill Project files
    gen_svc = SkillGenerationService(db)
    gen_result = gen_svc.generate(
        skill_project=skill_project,
        data_project_id=data_project.id,
    )

    if gen_result.error:
        run.status = "discarded"
        run.review_notes = f"Generation failed: {gen_result.error}"
        db.commit()
        raise HTTPException(422, gen_result.error)

    run.generated_artifacts = gen_result.to_dict()["artifacts"]
    run.diff_from_previous = gen_result.skill_md_diff
    run.status = "reviewing"
    run.review_status = "pending"
    db.commit()
    db.refresh(run)

    return run


@router.get("/runs", response_model=OptimizationRunListOut)
def list_optimization_runs(
    skill_id: str | None = Query(None),
    data_project_id: str | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """List optimization runs with optional filters."""
    q = db.query(OptimizationRun).filter(OptimizationRun.user_id == user.id)
    if skill_id:
        q = q.filter(OptimizationRun.skill_id == skill_id)
    if data_project_id:
        q = q.filter(OptimizationRun.data_project_id == data_project_id)
    if status:
        q = q.filter(OptimizationRun.status == status)

    total = q.count()
    items = (
        q.order_by(OptimizationRun.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return OptimizationRunListOut(items=items, total=total)


@router.get("/runs/{run_id}", response_model=OptimizationRunOut)
def get_optimization_run(
    run_id: str,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Get a single optimization run."""
    run = (
        db.query(OptimizationRun)
        .filter(OptimizationRun.id == run_id, OptimizationRun.user_id == user.id)
        .first()
    )
    if run is None:
        raise HTTPException(404, "Optimization run not found")
    return run


@router.post("/runs/{run_id}/review", response_model=OptimizationRunOut)
def review_optimization_run(
    run_id: str,
    body: OptimizationReviewIn,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Approve or reject an optimization run."""
    run = (
        db.query(OptimizationRun)
        .filter(OptimizationRun.id == run_id, OptimizationRun.user_id == user.id)
        .first()
    )
    if run is None:
        raise HTTPException(404, "Optimization run not found")
    if run.status != "reviewing":
        raise HTTPException(
            409, f"Cannot review run in status '{run.status}'"
        )

    if body.action == "approve":
        run.status = "published"
        run.review_status = "approved"
    else:
        run.status = "discarded"
        run.review_status = "rejected"

    run.review_notes = body.notes
    db.commit()
    db.refresh(run)
    return run


@router.get("/runs/{run_id}/diagnosis", response_model=DiagnosisOut)
def get_run_diagnosis(
    run_id: str,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Get the diagnosis result for an optimization run."""
    run = (
        db.query(OptimizationRun)
        .filter(OptimizationRun.id == run_id, OptimizationRun.user_id == user.id)
        .first()
    )
    if run is None:
        raise HTTPException(404, "Optimization run not found")
    if not run.diagnosis:
        raise HTTPException(422, "Diagnosis not available yet")
    return run.diagnosis


@router.get("/runs/{run_id}/artifacts")
def get_run_artifacts(
    run_id: str,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Get the list of generated artifacts."""
    run = (
        db.query(OptimizationRun)
        .filter(OptimizationRun.id == run_id, OptimizationRun.user_id == user.id)
        .first()
    )
    if run is None:
        raise HTTPException(404, "Optimization run not found")
    return {"artifacts": run.generated_artifacts or []}


@router.get("/runs/{run_id}/diff")
def get_run_diff(
    run_id: str,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Get the SKILL.md diff for an optimization run."""
    run = (
        db.query(OptimizationRun)
        .filter(OptimizationRun.id == run_id, OptimizationRun.user_id == user.id)
        .first()
    )
    if run is None:
        raise HTTPException(404, "Optimization run not found")
    return {"diff": run.diff_from_previous or ""}


@router.get("/runs/{run_id}/eval-results")
def get_run_eval_results(
    run_id: str,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Get the eval results for an optimization run."""
    run = (
        db.query(OptimizationRun)
        .filter(OptimizationRun.id == run_id, OptimizationRun.user_id == user.id)
        .first()
    )
    if run is None:
        raise HTTPException(404, "Optimization run not found")
    return run.eval_results or {}


# ---------------------------------------------------------------------------
# Handoff (standalone)
# ---------------------------------------------------------------------------


@router.post("/handoff", response_model=HandoffResultOut)
def trigger_handoff(
    body: HandoffRequest,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Standalone handoff: write Data Project data + diagnosis to Skill Project."""
    data_project = (
        db.query(Project)
        .filter(Project.id == body.data_project_id, Project.project_type == "data")
        .first()
    )
    if data_project is None:
        raise HTTPException(404, "Data Project not found")

    skill_project = (
        db.query(Project)
        .filter(
            Project.id == body.skill_project_id,
            Project.is_skill_project == True,  # noqa: E712
        )
        .first()
    )
    if skill_project is None:
        raise HTTPException(404, "Skill Project not found")

    handoff_svc = SkillDataHandoffService(db)
    try:
        result = handoff_svc.attach_dataset_package(
            skill_project=skill_project,
            data_project=data_project,
            user=user,
            status=body.status_filter,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    diagnosis_files = []
    if body.include_diagnosis:
        diag_svc = SkillSignalDiagnosisService(db)
        diagnosis = diag_svc.diagnose(data_project=data_project)
        try:
            diagnosis_files = handoff_svc.attach_diagnosis_results(
                skill_project=skill_project,
                data_project=data_project,
                diagnosis=diagnosis.to_dict(),
            )
        except ValueError:
            pass  # Handoff folder may not exist yet

    return HandoffResultOut(
        dataset_project_id=result.dataset_project_id,
        dataset_name=result.dataset_name,
        status_filter=result.status_filter,
        record_count=result.record_count,
        folder=result.folder,
        files=[*result.files, *diagnosis_files],
        generated_at=result.generated_at,
    )


# ---------------------------------------------------------------------------
# Sedimentation
# ---------------------------------------------------------------------------


@router.post("/sedimentations", response_model=SedimentationOut, status_code=201)
def create_sedimentation(
    body: SedimentationCreate,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Create a sedimentation candidate from a conversation."""
    from ..services.skill_sedimentation_service import SkillSedimentationService

    svc = SkillSedimentationService(db)
    result = svc.create_candidate(
        user_id=user.id,
        source_conversation_id=body.conversation_id,
        source_project_id=body.project_id,
        skill_id=body.skill_id,
        procedure_summary="Extracted from conversation",  # Placeholder
    )
    if result.error:
        raise HTTPException(422, result.error)

    candidate = db.query(SkillSedimentation).filter(SkillSedimentation.id == result.id).first()
    if candidate is None:
        raise HTTPException(500, "Failed to create candidate")
    return candidate


@router.get("/sedimentations", response_model=SedimentationListOut)
def list_sedimentations(
    skill_id: str | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """List sedimentation candidates."""
    from ..services.skill_sedimentation_service import SkillSedimentationService

    svc = SkillSedimentationService(db)
    items = svc.list_candidates(
        user_id=user.id,
        skill_id=skill_id,
        status=status,
        limit=limit,
    )
    return SedimentationListOut(items=items, total=len(items))


@router.post("/sedimentations/{sed_id}/review", response_model=SedimentationOut)
def review_sedimentation(
    sed_id: str,
    body: SedimentationReviewIn,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Review a sedimentation candidate (merge or discard)."""
    from ..services.skill_sedimentation_service import SkillSedimentationService

    svc = SkillSedimentationService(db)
    result = svc.review_candidate(
        sed_id,
        user_id=user.id,
        action=body.action,
        target_skill_id=body.target_skill_id,
    )
    if result.error:
        raise HTTPException(422, result.error)

    candidate = db.query(SkillSedimentation).filter(SkillSedimentation.id == result.id).first()
    if candidate is None:
        raise HTTPException(500, "Failed to update candidate")
    return candidate
