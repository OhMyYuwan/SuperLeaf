import pytest

from app.models import Provider
from app.services.provider_service import ProviderService


def test_browser_nanobot_provider_cannot_create_backend_client():
    provider = Provider(
        id="provider1",
        user_id="user1",
        name="Local Nanobot",
        kind="nanobot",
        endpoint="http://127.0.0.1:8902",
        api_key_enc="",
        meta={"transport": "browser"},
    )

    with pytest.raises(ValueError, match="browser Nanobot providers cannot be called"):
        ProviderService(db=None).make_client(provider)
