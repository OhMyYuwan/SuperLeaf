"""Native Agent registry APIs.

Phase 1 exposes configuration surfaces only. SDK execution is intentionally
left for a follow-up request.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, object_session

from ..database import get_session
from ..models import NativeAgent, NativeAgentCredential, Project, Skill, User
from ..schemas import (
    NativeAgentCredentialIn,
    NativeAgentCredentialOut,
    NativeAgentCredentialPatch,
    NativeAgentIn,
    NativeAgentOut,
    NativeAgentPatch,
    SkillIn,
    SkillMarketplaceEntryOut,
    SkillMarketplaceInstallOut,
    SkillMarketplaceOut,
    SkillOut,
    SkillPatch,
)
from ..services.native_agent_service import NativeAgentService
from ..services.skill_marketplace_service import (
    MarketplaceEntry,
    SkillMarketplaceError,
    SkillMarketplaceService,
)
from ..services.skill_content_crypto import decrypt_skill_content
from .deps import get_current_project, get_current_user, require_write_access


router = APIRouter(prefix="/api/native-agent", tags=["native-agent"])


def _credential_out(row: NativeAgentCredential) -> NativeAgentCredentialOut:
    return NativeAgentCredentialOut(
        id=row.id,
        user_id=row.user_id,
        name=row.name,
        base_url=row.base_url,
        runtime_kind=row.runtime_kind,
        default_model=row.default_model,
        status=row.status,
        status_detail=row.status_detail,
        meta=row.meta or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
        has_api_key=bool(row.api_key_enc),
    )


def _skill_out(row: Skill, user_id: str) -> SkillOut:
    out = SkillOut.model_validate(row, from_attributes=True)
    session = object_session(row)
    out.can_edit = bool(session) and NativeAgentService(session).can_edit_skill(row, user_id=user_id)
    out.content = decrypt_skill_content(row.content)
    return out


def _agent_out(row: NativeAgent) -> NativeAgentOut:
    return NativeAgentOut.model_validate(row, from_attributes=True)


def _marketplace_entry_out(entry: MarketplaceEntry) -> SkillMarketplaceEntryOut:
    return SkillMarketplaceEntryOut(**entry.__dict__)


@router.get("/credentials", response_model=list[NativeAgentCredentialOut])
def list_credentials(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[NativeAgentCredentialOut]:
    return [_credential_out(r) for r in NativeAgentService(db).list_credentials(user_id=user.id)]


@router.post("/credentials", response_model=NativeAgentCredentialOut, status_code=201)
def create_credential(
    body: NativeAgentCredentialIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentCredentialOut:
    row = NativeAgentService(db).create_credential(
        user_id=user.id,
        name=body.name,
        base_url=body.base_url,
        api_key=body.api_key,
        runtime_kind=body.runtime_kind,
        default_model=body.default_model,
    )
    return _credential_out(row)


@router.patch("/credentials/{credential_id}", response_model=NativeAgentCredentialOut)
def update_credential(
    credential_id: str,
    body: NativeAgentCredentialPatch,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentCredentialOut:
    row = NativeAgentService(db).update_credential(
        credential_id,
        user_id=user.id,
        name=body.name,
        base_url=body.base_url,
        api_key=body.api_key,
        runtime_kind=body.runtime_kind,
        default_model=body.default_model,
    )
    if row is None:
        raise HTTPException(404, "credential not found")
    return _credential_out(row)


@router.delete("/credentials/{credential_id}", status_code=204)
def delete_credential(
    credential_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    NativeAgentService(db).delete_credential(credential_id, user_id=user.id)


@router.post("/credentials/{credential_id}/probe", response_model=NativeAgentCredentialOut)
def probe_credential(
    credential_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentCredentialOut:
    row = NativeAgentService(db).mark_credential_probe(credential_id, user_id=user.id)
    if row is None:
        raise HTTPException(404, "credential not found")
    return _credential_out(row)


@router.get("/skills", response_model=list[SkillOut])
def list_skills(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[SkillOut]:
    return [_skill_out(r, user.id) for r in NativeAgentService(db).list_skills(user_id=user.id)]


@router.post("/skills", response_model=SkillOut, status_code=201)
def create_skill(
    body: SkillIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillOut:
    try:
        row = NativeAgentService(db).create_skill(
            user_id=user.id,
            name=body.name,
            folder_name=body.folder_name,
            entry_filename=body.entry_filename,
            description=body.description,
            content=body.content,
            tags=body.tags,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _skill_out(row, user.id)


@router.patch("/skills/{skill_id}", response_model=SkillOut)
def update_skill(
    skill_id: str,
    body: SkillPatch,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillOut:
    try:
        row = NativeAgentService(db).update_skill(
            skill_id,
            user_id=user.id,
            name=body.name,
            description=body.description,
            content=body.content,
            tags=body.tags,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if row is None:
        raise HTTPException(404, "skill not found")
    return _skill_out(row, user.id)


@router.post("/skills/{skill_id}/publish", response_model=SkillOut)
def publish_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillOut:
    try:
        row = NativeAgentService(db).publish_skill(skill_id, user_id=user.id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if row is None:
        raise HTTPException(404, "skill not found")
    return _skill_out(row, user.id)


@router.post("/skills/{skill_id}/unpublish", response_model=SkillOut)
def unpublish_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillOut:
    row = NativeAgentService(db).unpublish_skill(skill_id, user_id=user.id)
    if row is None:
        raise HTTPException(404, "skill not found")
    return _skill_out(row, user.id)


@router.delete("/skills/{skill_id}", status_code=204)
def delete_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    NativeAgentService(db).delete_skill(skill_id, user_id=user.id)


@router.get("/skill-marketplace", response_model=SkillMarketplaceOut)
def list_skill_marketplace(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillMarketplaceOut:
    svc = SkillMarketplaceService(db)
    try:
        entries = svc.list_entries(user_id=user.id)
    except SkillMarketplaceError as exc:
        raise HTTPException(502, str(exc)) from exc
    return SkillMarketplaceOut(
        catalog_url=svc.catalog_url,
        skills=[_marketplace_entry_out(entry) for entry in entries],
    )


@router.post("/skill-marketplace/{skill_id}/install", response_model=SkillMarketplaceInstallOut)
def install_marketplace_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillMarketplaceInstallOut:
    svc = SkillMarketplaceService(db)
    try:
        row, entry = svc.install(skill_id, user_id=user.id)
    except SkillMarketplaceError as exc:
        raise HTTPException(400, str(exc)) from exc
    return SkillMarketplaceInstallOut(
        skill=_skill_out(row, user.id),
        marketplace_entry=_marketplace_entry_out(entry),
    )


@router.post("/skill-marketplace/{skill_id}/update", response_model=SkillMarketplaceInstallOut)
def update_marketplace_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillMarketplaceInstallOut:
    return install_marketplace_skill(skill_id, db=db, user=user)


@router.delete("/skill-marketplace/{skill_id}/uninstall", status_code=204)
def uninstall_marketplace_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    SkillMarketplaceService(db).uninstall(skill_id, user_id=user.id)


@router.get("/agents", response_model=list[NativeAgentOut])
def list_agents(
    provider_id: str | None = None,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[NativeAgentOut]:
    svc = NativeAgentService(db)
    rows = (
        svc.list_agents_for_provider(project_id=project.id, user_id=user.id, provider_id=provider_id)
        if provider_id
        else svc.list_agents(project_id=project.id, user_id=user.id)
    )
    return [_agent_out(r) for r in rows]


@router.post("/agents", response_model=NativeAgentOut, status_code=201)
def create_agent(
    body: NativeAgentIn,
    project: Project = Depends(require_write_access),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentOut:
    try:
        row = NativeAgentService(db).create_agent(
            project_id=project.id,
            user_id=user.id,
            name=body.name,
            description=body.description,
            provider_id=body.provider_id,
            model=body.model,
            instructions=body.instructions,
            skill_ids=body.skill_ids,
            output_contract=body.output_contract,
            runtime_config=body.runtime_config,
            is_enabled=body.is_enabled,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _agent_out(row)


@router.patch("/agents/{agent_id}", response_model=NativeAgentOut)
def update_agent(
    agent_id: str,
    body: NativeAgentPatch,
    project: Project = Depends(require_write_access),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentOut:
    try:
        row = NativeAgentService(db).update_agent(
            agent_id,
            project_id=project.id,
            user_id=user.id,
            patch=body.model_dump(exclude_unset=True),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if row is None:
        raise HTTPException(404, "native agent not found")
    return _agent_out(row)


@router.delete("/agents/{agent_id}", status_code=204)
def delete_agent(
    agent_id: str,
    project: Project = Depends(require_write_access),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    NativeAgentService(db).delete_agent(agent_id, project_id=project.id, user_id=user.id)
