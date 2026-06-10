from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from datetime import datetime, timezone

import pytest

from marginalia import mcp_server
from marginalia.config import get_settings
from marginalia.db.bootstrap import bootstrap_schema
from marginalia.db.engine import dispose_engine
from marginalia.db.models import File, FileEntry, Folder
from marginalia.db.session import session_scope
from marginalia.storage import get_storage, reset_storage_cache
from marginalia.utils.ids import new_id


def _tool_payload(response: dict[str, object] | None) -> dict[str, object]:
    assert response is not None
    result = response["result"]
    assert isinstance(result, dict)
    assert result["isError"] is False
    content = result["content"]
    assert isinstance(content, list)
    assert content
    text_content = content[0]
    assert isinstance(text_content, dict)
    return json.loads(str(text_content["text"]))


async def _one_chunk(data: bytes) -> AsyncIterator[bytes]:
    yield data


@pytest.mark.asyncio
async def test_mcp_search_metadata_then_read_files_uses_real_db_and_storage(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "mcp_e2e_home"
    monkeypatch.setenv("MARGINALIA_HOME", str(home))
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.setenv("WORKER_ENABLED", "false")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    reset_storage_cache()
    await dispose_engine()

    body = (
        "# MCP Probe\n\n"
        "MCP real e2e text includes raft consensus and file reads.\n"
    ).encode("utf-8")
    storage_key = "00/aa/mcp-probe.md"
    entry_id = new_id()

    try:
        await bootstrap_schema()
        await get_storage().put(
            storage_key,
            _one_chunk(body),
            content_type="text/markdown",
            display_name="mcp-probe.md",
        )

        now = datetime.now(timezone.utc)
        folder = Folder(
            id=new_id(),
            parent_id=None,
            name="MCP E2E",
            created_at=now,
            updated_at=now,
        )
        file_row = File(
            id=new_id(),
            storage_key=storage_key,
            sha256=hashlib.sha256(body).hexdigest(),
            size_bytes=len(body),
            mime_type="text/markdown",
            original_ext=".md",
            kind="text",
            summary="MCP raft consensus probe with mcp-probe-token",
            description={
                "text": "Small fixture for the real MCP read path.",
                "sections": [],
            },
            extra="mcp-probe-token",
            ingest_status="done",
            ingested_at=now,
            created_at=now,
            updated_at=now,
        )
        entry = FileEntry(
            id=entry_id,
            folder_id=folder.id,
            file_id=file_row.id,
            display_name="mcp-probe.md",
            lifecycle="active",
            catalog_id=None,
            extra="mcp-probe-token",
            created_at=now,
            updated_at=now,
        )
        async with session_scope() as db:
            db.add_all([folder, file_row])
            await db.flush()
            db.add(entry)
            await db.commit()

        search_response = await mcp_server.handle_message(
            {
                "jsonrpc": "2.0",
                "id": "search",
                "method": "tools/call",
                "params": {
                    "name": "search_metadata",
                    "arguments": {"text": "mcp-probe-token", "limit": 5},
                },
            }
        )
        search_payload = _tool_payload(search_response)
        entries = search_payload["entries"]
        assert isinstance(entries, list)
        assert any(
            isinstance(row, dict) and row.get("entry_id") == entry_id
            for row in entries
        )

        read_response = await mcp_server.handle_message(
            {
                "jsonrpc": "2.0",
                "id": "read",
                "method": "tools/call",
                "params": {
                    "name": "read_files",
                    "arguments": {
                        "requests": [
                            {
                                "entry_id": entry_id[:8],
                                "reads": [{"offset": 0, "max_chars": 200}],
                            }
                        ]
                    },
                },
            }
        )
        read_payload = _tool_payload(read_response)
        assert read_payload["ok"] is True
        results = read_payload["results"]
        assert isinstance(results, list)
        assert len(results) == 1
        result = results[0]
        assert isinstance(result, dict)
        assert result["entry_id"] == entry_id
        assert result["pipeline"] == "text"
        reads = result["reads"]
        assert isinstance(reads, list)
        assert reads
        first_read = reads[0]
        assert isinstance(first_read, dict)
        assert "raft consensus" in str(first_read["text"])
    finally:
        reset_storage_cache()
        get_settings.cache_clear()  # type: ignore[attr-defined]
        await dispose_engine()
