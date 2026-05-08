"""/api/providers routes — register, list, activate, probe, rotate, delete."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Provider
from ..schemas import ProviderIn, ProviderOut, ProviderUpdate
from ..services.provider_service import ProviderService

router = APIRouter(prefix="/api/providers", tags=["providers"])


def _to_out(p: Provider) -> ProviderOut:
    return ProviderOut(
        id=p.id,
        name=p.name,
        kind=p.kind,
        endpoint=p.endpoint,
        status=p.status,
        status_detail=p.status_detail,
        is_active=p.is_active,
        meta=p.meta or {},
        created_at=p.created_at,
        updated_at=p.updated_at,
        has_api_key=bool(p.api_key_enc),
    )


@router.get("", response_model=list[ProviderOut])
def list_providers(db: Session = Depends(get_session)) -> list[ProviderOut]:
    return [_to_out(p) for p in ProviderService(db).list_providers()]


@router.post("", response_model=ProviderOut, status_code=201)
def create_provider(body: ProviderIn, db: Session = Depends(get_session)) -> ProviderOut:
    svc = ProviderService(db)
    p = svc.create(
        name=body.name,
        kind=body.kind,
        endpoint=body.endpoint,
        api_key=body.api_key,
        activate=body.activate,
    )
    return _to_out(p)


@router.patch("/{provider_id}", response_model=ProviderOut)
def update_provider(
    provider_id: str, body: ProviderUpdate, db: Session = Depends(get_session)
) -> ProviderOut:
    svc = ProviderService(db)
    p = svc.update(
        provider_id,
        name=body.name,
        endpoint=body.endpoint,
        api_key=body.api_key,
    )
    if p is None:
        raise HTTPException(404, "Provider not found")
    return _to_out(p)


@router.delete("/{provider_id}", status_code=204)
def delete_provider(provider_id: str, db: Session = Depends(get_session)) -> None:
    if not ProviderService(db).delete(provider_id):
        raise HTTPException(404, "Provider not found")


@router.post("/{provider_id}/activate", response_model=ProviderOut)
def activate_provider(provider_id: str, db: Session = Depends(get_session)) -> ProviderOut:
    p = ProviderService(db).activate(provider_id)
    if p is None:
        raise HTTPException(404, "Provider not found")
    return _to_out(p)


@router.post("/{provider_id}/probe", response_model=ProviderOut)
async def probe_provider(provider_id: str, db: Session = Depends(get_session)) -> ProviderOut:
    p = await ProviderService(db).probe(provider_id)
    if p is None:
        raise HTTPException(404, "Provider not found")
    return _to_out(p)
