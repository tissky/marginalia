"""End-to-end checks for non-interactive CLI commands.

Run:
    .venv/Scripts/python -B tests/test_cli_oneshot_e2e.py
"""
from __future__ import annotations

import asyncio
import atexit
import contextlib
import io
import json
import os
import shutil
import sys
from pathlib import Path
from uuid import uuid4

from sqlalchemy import text

_TEST_PARENT = Path(os.environ.get(
    "MARGINALIA_TEST_TMP",
    str(Path(__file__).resolve().parent),
))
_TEST_PARENT.mkdir(parents=True, exist_ok=True)
_TEST_ROOT = _TEST_PARENT / f"_cli_oneshot_e2e_{os.getpid()}_{uuid4().hex[:8]}"
_TEST_ROOT.mkdir(parents=True)
atexit.register(lambda: shutil.rmtree(_TEST_ROOT, ignore_errors=True))

os.environ["MARGINALIA_HOME"] = str(_TEST_ROOT / "home")
os.environ["STORAGE_BACKEND"] = "mirror"
os.environ["WORKER_ENABLED"] = "false"
os.environ["LLM_DEFAULT_API_KEY"] = "sk-fake"
os.environ["LLM_DEFAULT_MODEL"] = "fake-model"

from httpx import ASGITransport

from marginalia.config import get_settings

get_settings.cache_clear()  # type: ignore[attr-defined]

from marginalia.cli.client import MarginaliaClient
from marginalia.cli.oneshot import run_async
from marginalia.db.bootstrap import bootstrap_schema
from marginalia.db.engine import get_session_factory
from marginalia.llm.types import ChatRequest, ChatResponse, TokenUsage
from marginalia.main import app


class _FakeChat:
    profile_name = "chat"
    model = "fake-chat"

    def __init__(self) -> None:
        self.requests: list[ChatRequest] = []

    async def complete(self, request: ChatRequest) -> ChatResponse:
        self.requests.append(request)
        if not request.tools:
            return ChatResponse(
                text="Plan: answer directly.",
                tool_calls=[],
                stop_reason="end_turn",
                usage=TokenUsage(input_tokens=30, output_tokens=5),
                parsed_json=None,
            )
        return ChatResponse(
            text="One-shot answer from fake agent.",
            tool_calls=[],
            stop_reason="end_turn",
            usage=TokenUsage(input_tokens=40, output_tokens=7),
            parsed_json=None,
        )


def _install_fake_chat(fake: _FakeChat) -> None:
    import marginalia.agent.runtime as runtime

    runtime.get_chat_client = lambda profile="chat": fake  # type: ignore[assignment]


async def _capture(client: MarginaliaClient, argv: list[str]) -> tuple[int, str]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = await run_async(argv, client=client)
    return rc, buf.getvalue()


async def _create_schema() -> None:
    await bootstrap_schema()


async def _mark_file_failed(file_id: str) -> None:
    factory = get_session_factory()
    async with factory() as s:
        await s.execute(
            text("UPDATE files SET ingest_status='failed' WHERE id=:id"),
            {"id": file_id},
        )
        await s.commit()


async def main() -> None:
    fake = _FakeChat()
    _install_fake_chat(fake)

    local_file = _TEST_ROOT / "hello world.md"
    local_file.write_text("# Hello\n\nThis file is for one-shot CLI tests.\n", encoding="utf-8")

    transport = ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        client = MarginaliaClient(base_url="http://test", transport=transport)
        try:
            rc, out = await _capture(
                client,
                ["upload", str(local_file), "/docs/hello world.md", "--json"],
            )
            assert rc == 0, out
            uploaded = json.loads(out)
            assert uploaded["ok"] is True
            file_id = uploaded["file_id"]
            entry_id = uploaded["entry_id"]
            print("[1] upload --json OK")

            await _mark_file_failed(file_id)
            rc, out = await _capture(client, ["reprocess", "failed", "--json"])
            assert rc == 0, out
            reprocessed = json.loads(out)
            assert reprocessed["ok"] is True
            assert reprocessed["file_count"] == 1
            assert reprocessed["status_filter"] == "failed"
            assert reprocessed["scope"] == "all files, status=failed"
            print("[2] reprocess failed --json OK")

            rc, out = await _capture(client, ["search", "hello", "--json"])
            assert rc == 0, out
            search = json.loads(out)
            assert search["ok"] is True
            assert any(row["entry_id"] == entry_id for row in search["entries"])
            print("[3] search --json OK")

            rc, out = await _capture(client, ["info", entry_id, "--json"])
            assert rc == 0, out
            info = json.loads(out)
            assert info["ok"] is True
            assert info["display_name"] == "hello world.md"
            print("[4] info --json OK")

            rc, out = await _capture(client, ["check", "--json"])
            assert rc == 0, out
            check = json.loads(out)
            assert check["ok"] is True
            assert check["in_sync"] >= 1
            assert check["total_changes"] == 0
            print("[5] check --json OK")

            rc, out = await _capture(client, ["ask", "summarize", "this", "--json"])
            assert rc == 0, out
            answer = json.loads(out)
            assert answer["ok"] is True
            assert "fake agent" in answer["answer"]
            print("[6] ask --json OK")

            second = _TEST_ROOT / "plain text upload.md"
            second.write_text("plain text mode", encoding="utf-8")
            rc, out = await _capture(client, ["upload", str(second), "/docs/plain text upload.md"])
            assert rc == 0, out
            assert "uploaded" in out
            print("[7] text one-shot preserves spaced paths")
        finally:
            await client.aclose()

    print("\nALL CLI ONESHOT E2E CHECKS PASSED")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as exc:
        print("FAIL:", exc, file=sys.stderr)
        sys.exit(1)
