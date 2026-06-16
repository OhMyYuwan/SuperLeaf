from __future__ import annotations

import pytest

from app.services import mcp_tool_service
from app.services.mcp_tool_service import McpServerConfig, McpToolError
from app.settings import settings


@pytest.mark.asyncio
async def test_stdio_mcp_rejects_direct_python_interpreter_before_spawn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "mcp_stdio_enabled", True)
    spawn_called = False

    async def fake_spawn(*_args, **_kwargs):
        nonlocal spawn_called
        spawn_called = True
        raise AssertionError("unsafe interpreter command should be rejected before spawn")

    monkeypatch.setattr(mcp_tool_service.asyncio, "create_subprocess_exec", fake_spawn)
    server = McpServerConfig(
        id="py",
        name="Python",
        command="python3",
        transport="stdio",
        args=["-c", "print('not an mcp server')"],
    )

    with pytest.raises(McpToolError, match="not allowed|interpreter"):
        await mcp_tool_service._with_mcp_session(server, lambda session: session.list_tools())

    assert spawn_called is False
