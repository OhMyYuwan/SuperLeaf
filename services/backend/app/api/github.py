"""GitHub account authorization routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import User
from ..schemas import GitHubAccountOut, GitHubOAuthStartOut, GitHubTokenConnectIn
from ..schemas import GitHubDevicePollIn, GitHubDevicePollOut, GitHubDeviceStartIn, GitHubDeviceStartOut
from ..services.github_service import GitHubError, GitHubService
from .deps import get_current_user

router = APIRouter(prefix="/api/github", tags=["github"])


def _account_out(account) -> GitHubAccountOut:
    if account is None:
        return GitHubAccountOut(connected=False)
    return GitHubAccountOut(
        connected=True,
        login=account.login,
        name=account.name,
        avatar_url=account.avatar_url,
        scope=account.scope,
        updated_at=account.updated_at,
    )


@router.get("/account", response_model=GitHubAccountOut)
def github_account(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> GitHubAccountOut:
    return _account_out(GitHubService(db, user).account())


@router.delete("/account", status_code=204)
def disconnect_github(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> None:
    GitHubService(db, user).disconnect()


@router.post("/token", response_model=GitHubAccountOut)
def connect_github_token(
    body: GitHubTokenConnectIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> GitHubAccountOut:
    try:
        account = GitHubService(db, user).connect_token(body.token)
    except GitHubError as e:
        raise HTTPException(400, str(e)) from e
    return _account_out(account)


@router.post("/oauth/start", response_model=GitHubOAuthStartOut)
def start_github_oauth(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> GitHubOAuthStartOut:
    try:
        authorize_url = GitHubService(db, user).begin_oauth()
    except GitHubError as e:
        raise HTTPException(400, str(e)) from e
    return GitHubOAuthStartOut(authorize_url=authorize_url)


@router.post("/device/start", response_model=GitHubDeviceStartOut)
def start_github_device_flow(
    body: GitHubDeviceStartIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> GitHubDeviceStartOut:
    try:
        payload = GitHubService(db, user).begin_device_flow(
            client_id=body.client_id,
            scope=body.scope,
        )
    except GitHubError as e:
        raise HTTPException(400, str(e)) from e
    return GitHubDeviceStartOut(
        device_code=str(payload.get("device_code") or ""),
        user_code=str(payload.get("user_code") or ""),
        verification_uri=str(payload.get("verification_uri") or ""),
        verification_uri_complete=str(payload.get("verification_uri_complete") or ""),
        expires_in=int(payload.get("expires_in") or 0),
        interval=int(payload.get("interval") or 5),
    )


@router.post("/device/poll", response_model=GitHubDevicePollOut)
def poll_github_device_flow(
    body: GitHubDevicePollIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> GitHubDevicePollOut:
    try:
        status, payload, interval = GitHubService(db, user).poll_device_flow(
            client_id=body.client_id,
            device_code=body.device_code,
        )
    except GitHubError as e:
        raise HTTPException(400, str(e)) from e
    account = payload.get("account")
    return GitHubDevicePollOut(
        status=status,
        error=str(payload.get("error") or ""),
        interval=interval,
        account=_account_out(account) if account is not None else None,
    )


@router.get("/oauth/callback", response_class=HTMLResponse)
def github_oauth_callback(
    code: str,
    state: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> HTMLResponse:
    try:
        GitHubService(db, user).complete_oauth(code=code, state=state)
    except GitHubError as e:
        return HTMLResponse(
            _callback_html(f"GitHub 授权失败：{str(e)}", success=False),
            status_code=400,
        )
    return HTMLResponse(_callback_html("GitHub 授权完成", success=True))


def _callback_html(message: str, *, success: bool) -> str:
    color = "#177245" if success else "#a33434"
    return f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>{message}</title>
    <style>
      body {{ font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 32px; color: #172018; }}
      strong {{ color: {color}; }}
    </style>
  </head>
  <body>
    <strong>{message}</strong>
    <p>可以关闭这个窗口，回到 YuwanLabWriter。</p>
    <script>
      if (window.opener) {{
        window.opener.postMessage({{ type: 'yuwanlab.github.connected', success: {str(success).lower()} }}, window.location.origin);
        setTimeout(() => window.close(), 500);
      }}
    </script>
  </body>
</html>"""
