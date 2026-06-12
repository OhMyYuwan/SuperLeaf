"""Catalog loader and validation helpers for SuperLeaf MCP presets."""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

from ..settings import settings
from .mcp_policy import normalize_mcp_transport, remote_endpoint_from_server
from .mcp_tool_service import call_mcp_tool, discover_mcp_tools


class McpCatalogError(RuntimeError):
    pass


class McpCatalogService:
    def __init__(self, root: Path | None = None, catalog_url: str | None = None) -> None:
        self.root = root or _default_catalog_root()
        self.catalog_url = (
            "" if root is not None and catalog_url is None else (catalog_url or settings.mcp_catalog_url)
        )
        self.catalog_url = self.catalog_url.strip()

    def catalog(self) -> dict[str, Any]:
        remote_error = ""
        if self.catalog_url:
            try:
                return self._catalog_from_url(self.catalog_url)
            except McpCatalogError as exc:
                remote_error = str(exc)

        try:
            catalog = self._catalog_from_root(self.root)
        except McpCatalogError as exc:
            if remote_error:
                raise McpCatalogError(
                    f"Remote MCP catalog failed: {remote_error}; local fallback failed: {exc}"
                ) from exc
            raise
        if remote_error:
            warnings = list(catalog.get("warnings") or [])
            warnings.append(f"Remote MCP catalog unavailable, using local fallback: {remote_error}")
            catalog["warnings"] = warnings
        return catalog

    def _catalog_from_root(self, root: Path) -> dict[str, Any]:
        catalog_path = root / "catalog.json"
        if not catalog_path.exists():
            raise McpCatalogError(f"MCP catalog not found: {catalog_path}")
        payload = _read_json(catalog_path)
        presets: list[dict[str, Any]] = []
        for rel in payload.get("presets", []):
            preset = self._load_local_preset(root, str(rel))
            presets.append(preset)
        return {
            "catalog_source": "local",
            "catalog_root": str(root),
            "id": payload.get("id", "superleaf-mcps"),
            "name": payload.get("name", "SuperLeaf MCPs"),
            "version": payload.get("version", ""),
            "updated_at": payload.get("updated_at", ""),
            "registries": list(payload.get("registries") or []),
            "presets": presets,
        }

    def _catalog_from_url(self, catalog_url: str) -> dict[str, Any]:
        payload = _read_json_url(catalog_url)
        base_url = _url_dir(catalog_url)
        presets: list[dict[str, Any]] = []
        for rel in payload.get("presets", []):
            preset = self._load_remote_preset(base_url, str(rel))
            presets.append(preset)
        return {
            "catalog_source": "remote",
            "catalog_url": catalog_url,
            "catalog_root": base_url,
            "id": payload.get("id", "superleaf-mcps"),
            "name": payload.get("name", "SuperLeaf MCPs"),
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
        transport_type = normalize_mcp_transport(str(transport.get("type") or "stdio"))
        endpoint = remote_endpoint_from_server(transport)
        command = str(transport.get("command") or "")
        if transport_type == "remote" and endpoint:
            command = endpoint
        return {
            "id": preset.get("id", ""),
            "name": preset.get("name", preset.get("id", "")),
            "enabled": enabled,
            "transport": transport_type,
            "endpoint": endpoint,
            "command": command,
            "args": [] if transport_type == "remote" else list(transport.get("args") or []),
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
            unavailable = next(
                (item for item in refs if item.tool_name == "__mcp_server_unavailable__"),
                None,
            )
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

    def _load_local_preset(self, root: Path, rel_path: str) -> dict[str, Any]:
        preset_path = root / rel_path
        preset = _read_json(preset_path)
        preset["_catalog_path"] = rel_path
        preset["_catalog_source"] = "local"
        preset["_catalog_root"] = str(root)
        return preset

    def _load_remote_preset(self, base_url: str, rel_path: str) -> dict[str, Any]:
        preset_url = urllib.parse.urljoin(base_url, rel_path)
        preset = _read_json_url(preset_url)
        preset["_catalog_path"] = rel_path
        preset["_catalog_source"] = "remote"
        preset["_catalog_root"] = base_url
        return preset

    def _golden_tests_for_preset(self, preset: dict[str, Any]) -> list[dict[str, Any]]:
        verification = preset.get("verification") if isinstance(preset.get("verification"), dict) else {}
        tests: list[dict[str, Any]] = []
        for rel in verification.get("golden_tests", []):
            if preset.get("_catalog_source") == "remote":
                test_url = urllib.parse.urljoin(str(preset.get("_catalog_root") or ""), str(rel))
                tests.append(_read_json_url(test_url))
                continue
            path = Path(str(preset.get("_catalog_root") or self.root)) / str(rel)
            if path.exists():
                tests.append(_read_json(path))
        return tests


def _default_catalog_root() -> Path:
    supports_root = Path(__file__).resolve().parents[4] / "supports"
    return supports_root / "SuperLeaf.MCPs"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise McpCatalogError(f"Failed to read MCP catalog file {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise McpCatalogError(f"MCP catalog file must be a JSON object: {path}")
    return payload


def _read_json_url(url: str) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/json,text/plain,*/*", "User-Agent": "SuperLeaf"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
    except HTTPError as exc:
        raise McpCatalogError(f"Failed to read MCP catalog URL {url}: HTTP {exc.code}") from exc
    except Exception as exc:  # noqa: BLE001
        raise McpCatalogError(f"Failed to read MCP catalog URL {url}: {exc}") from exc
    if not isinstance(payload, dict):
        raise McpCatalogError(f"MCP catalog URL must return a JSON object: {url}")
    return payload


def _url_dir(url: str) -> str:
    return url.rsplit("/", 1)[0] + "/"


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
    tool_error = _extract_mcp_tool_error(raw)
    if tool_error:
        return {
            "status": "failed",
            "passed": False,
            "preset_id": preset_id,
            "test_id": test.get("id", ""),
            "matched": {},
            "warnings": _mcp_tool_error_warnings(preset_id, tool_error),
            "error": _friendly_mcp_tool_error(preset_id, tool_error),
        }

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


def _extract_mcp_tool_error(raw: str) -> str:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return ""
    if not isinstance(payload, dict):
        return ""

    if "error" in payload:
        return _error_to_text(payload["error"])

    content = payload.get("content")
    text_items: list[str] = []
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                text_items.append(item["text"].strip())
    text = " ".join(item for item in text_items if item).strip()
    if payload.get("isError") is True:
        return text or "MCP tool returned an error"
    if text.startswith("Error calling tool") or "Rate limit exceeded" in text:
        return text
    return ""


def _error_to_text(error: Any) -> str:
    if isinstance(error, str):
        return error.strip()
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
    return json.dumps(error, ensure_ascii=False, default=str)


def _friendly_mcp_tool_error(preset_id: str, message: str) -> str:
    cleaned = " ".join(message.split())
    lower = cleaned.lower()
    if "rate limit exceeded" in lower:
        if preset_id == "semantic_scholar" or "/paper/search" in lower or "semantic scholar" in lower:
            return (
                "Semantic Scholar API 已触发匿名限流。请在拥有的 MCP 配置中添加 "
                "SEMANTIC_SCHOLAR_API_KEY，保存后再运行功能性检查。"
            )
        return "MCP 工具触发限流。请在 Env 中添加对应服务的 API Key 后重试。"
    return f"MCP 工具调用失败：{cleaned[:500]}" if cleaned else "MCP 工具调用失败。"


def _mcp_tool_error_warnings(preset_id: str, message: str) -> list[str]:
    if "rate limit exceeded" in message.lower() and preset_id == "semantic_scholar":
        return ["SEMANTIC_SCHOLAR_API_KEY is recommended for reliable Semantic Scholar searches"]
    return []


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
