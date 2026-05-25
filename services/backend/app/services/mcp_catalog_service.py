"""Catalog loader and validation helpers for YuwanLabWriter MCP presets."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .mcp_tool_service import call_mcp_tool, discover_mcp_tools


class McpCatalogError(RuntimeError):
    pass


class McpCatalogService:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or _default_catalog_root()

    def catalog(self) -> dict[str, Any]:
        catalog_path = self.root / "catalog.json"
        if not catalog_path.exists():
            raise McpCatalogError(f"MCP catalog not found: {catalog_path}")
        payload = _read_json(catalog_path)
        presets: list[dict[str, Any]] = []
        for rel in payload.get("presets", []):
            preset = self._load_preset(str(rel))
            presets.append(preset)
        return {
            "catalog_root": str(self.root),
            "id": payload.get("id", "yuwanlabwriter-mcps"),
            "name": payload.get("name", "YuwanLabWriter MCPs"),
            "version": payload.get("version", ""),
            "updated_at": payload.get("updated_at", ""),
            "registries": list(payload.get("registries") or []),
            "presets": presets,
        }

    def preset(self, preset_id: str) -> dict[str, Any]:
        for preset in self.catalog()["presets"]:
            if preset.get("id") == preset_id:
                return preset
        raise McpCatalogError(f"MCP preset not found: {preset_id}")

    def server_config_from_preset(
        self,
        preset: dict[str, Any],
        *,
        env: dict[str, str] | None = None,
        enabled: bool = True,
        allowed_tools: list[str] | None = None,
    ) -> dict[str, Any]:
        transport = preset.get("transport") if isinstance(preset.get("transport"), dict) else {}
        policy = preset.get("tool_policy") if isinstance(preset.get("tool_policy"), dict) else {}
        tools = allowed_tools if allowed_tools is not None else policy.get("default_allowed_tools", [])
        return {
            "id": preset.get("id", ""),
            "name": preset.get("name", preset.get("id", "")),
            "enabled": enabled,
            "transport": transport.get("type", "stdio"),
            "command": transport.get("command", ""),
            "args": list(transport.get("args") or []),
            "env": env or {},
            "allowed_tools": list(tools or []),
        }

    async def probe(self, server: dict[str, Any], preset: dict[str, Any] | None = None) -> dict[str, Any]:
        refs = await discover_mcp_tools({"mcp_servers": [server]})
        unavailable = next((ref for ref in refs if ref.tool_name == "__mcp_server_unavailable__"), None)
        if unavailable is not None:
            return {
                "status": "error",
                "server_id": server.get("id", ""),
                "server_name": server.get("name", ""),
                "tools": [],
                "missing_tools": _expected_tools(preset or {}),
                "warnings": [unavailable.definition["function"]["description"]],
                "requires_env": _reliable_env_names(preset or {}),
            }

        tools = [
            {
                "name": ref.tool_name,
                "function_name": ref.function_name,
                "description": ref.definition.get("function", {}).get("description", ""),
                "parameters": ref.definition.get("function", {}).get("parameters", {}),
            }
            for ref in refs
        ]
        names = {tool["name"] for tool in tools}
        expected = _expected_tools(preset or {})
        missing = [tool for tool in expected if tool not in names]
        warnings = []
        for env_name in _reliable_env_names(preset or {}):
            if not (server.get("env") or {}).get(env_name):
                warnings.append(f"{env_name} is recommended for reliable use")
        if missing:
            warnings.append(f"Missing recommended tools: {', '.join(missing)}")
        return {
            "status": "ok" if not missing else "degraded",
            "server_id": server.get("id", ""),
            "server_name": server.get("name", ""),
            "tools": tools,
            "missing_tools": missing,
            "warnings": warnings,
            "requires_env": _reliable_env_names(preset or {}),
        }

    async def golden_test(
        self,
        *,
        preset_id: str,
        server: dict[str, Any] | None = None,
        env: dict[str, str] | None = None,
        test_id: str = "",
    ) -> dict[str, Any]:
        preset = self.preset(preset_id)
        tests = self._golden_tests_for_preset(preset)
        if test_id:
            tests = [test for test in tests if test.get("id") == test_id]
        if not tests:
            raise McpCatalogError(f"No golden test found for preset: {preset_id}")
        test = tests[0]
        server_config = server or self.server_config_from_preset(preset, env=env)
        refs = await discover_mcp_tools({"mcp_servers": [server_config]})
        ref = next((item for item in refs if item.tool_name == test.get("tool")), None)
        if ref is None:
            unavailable = next((item for item in refs if item.tool_name == "__mcp_server_unavailable__"), None)
            reason = unavailable.definition["function"]["description"] if unavailable else "tool not found"
            return {
                "status": "failed",
                "passed": False,
                "preset_id": preset_id,
                "test_id": test.get("id", ""),
                "error": reason,
                "warnings": [],
            }
        try:
            raw = await call_mcp_tool(ref, dict(test.get("arguments") or {}))
        except Exception as exc:  # noqa: BLE001
            return {
                "status": "failed",
                "passed": False,
                "preset_id": preset_id,
                "test_id": test.get("id", ""),
                "error": f"{type(exc).__name__}: {exc}",
                "warnings": [],
            }
        return _evaluate_golden_result(preset_id=preset_id, test=test, raw=raw)

    def _load_preset(self, rel_path: str) -> dict[str, Any]:
        preset_path = self.root / rel_path
        preset = _read_json(preset_path)
        preset["_catalog_path"] = rel_path
        return preset

    def _golden_tests_for_preset(self, preset: dict[str, Any]) -> list[dict[str, Any]]:
        verification = preset.get("verification") if isinstance(preset.get("verification"), dict) else {}
        tests: list[dict[str, Any]] = []
        for rel in verification.get("golden_tests", []):
            path = self.root / str(rel)
            if path.exists():
                tests.append(_read_json(path))
        return tests


def _default_catalog_root() -> Path:
    return Path(__file__).resolve().parents[4] / "supports" / "YuwanLabWriter.MCPs"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise McpCatalogError(f"Failed to read MCP catalog file {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise McpCatalogError(f"MCP catalog file must be a JSON object: {path}")
    return payload


def _expected_tools(preset: dict[str, Any]) -> list[str]:
    policy = preset.get("tool_policy") if isinstance(preset.get("tool_policy"), dict) else {}
    tools = policy.get("recommended_tools") or policy.get("default_allowed_tools") or []
    return [str(tool) for tool in tools if str(tool).strip()]


def _reliable_env_names(preset: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for item in preset.get("env_schema", []):
        if isinstance(item, dict) and item.get("required_for_reliable_use"):
            name = str(item.get("name") or "").strip()
            if name:
                out.append(name)
    return out


def _evaluate_golden_result(*, preset_id: str, test: dict[str, Any], raw: str) -> dict[str, Any]:
    parsed = _parse_mcp_text_result(raw)
    items = parsed if isinstance(parsed, list) else [parsed]
    title_needles = [str(item).lower() for item in test.get("expect_title_contains", [])]
    expected_year = test.get("expect_year")
    expected_fields = [str(item) for item in test.get("expect_fields", [])]
    matched: dict[str, Any] | None = None
    warnings: list[str] = []

    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").lower()
        if title_needles and not all(needle in title for needle in title_needles):
            continue
        matched = item
        break

    if matched is None:
        warnings.append("No result matched expected title constraints")
    else:
        missing_fields = [field for field in expected_fields if field not in matched]
        if missing_fields:
            warnings.append(f"Matched result is missing fields: {', '.join(missing_fields)}")
        if expected_year is not None and matched.get("year") != expected_year:
            warnings.append(f"Expected year {expected_year}, got {matched.get('year')}")

    passed = matched is not None and not warnings
    return {
        "status": "passed" if passed else "failed",
        "passed": passed,
        "preset_id": preset_id,
        "test_id": test.get("id", ""),
        "matched": matched or {},
        "warnings": warnings,
        "raw_preview": raw[:3000],
    }


def _parse_mcp_text_result(raw: str) -> Any:
    payload = json.loads(raw)
    content = payload.get("content") if isinstance(payload, dict) else None
    if isinstance(content, list) and content:
        first = content[0]
        if isinstance(first, dict) and isinstance(first.get("text"), str):
            try:
                return json.loads(first["text"])
            except json.JSONDecodeError:
                return {"text": first["text"]}
    return payload
