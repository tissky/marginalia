from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import os
from pathlib import Path
import shutil
import sqlite3
from uuid import uuid4

import pytest
import sqlalchemy as sa


async def _one_chunk(body: bytes) -> AsyncIterator[bytes]:
    yield body


def _make_test_root() -> Path:
    base = Path(os.environ.get("MARGINALIA_TEST_TMP", Path.cwd() / ".codex-run"))
    return base / f"marginalia_supplemental_e2e_{os.getpid()}_{uuid4().hex[:8]}"


def _sample_eml() -> bytes:
    return b"\r\n".join([
        b"From: sender@example.com",
        b"To: recipient@example.com",
        b"Subject: Supplemental EML",
        b"Date: Thu, 25 Jun 2026 10:00:00 +0800",
        b"MIME-Version: 1.0",
        b"Content-Type: text/plain; charset=utf-8",
        b"",
        b"Hello from the eml-upload-token body.",
    ])


class _MemoryObjectStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def put(self, key: str, stream: AsyncIterator[bytes], **kwargs) -> str:
        del kwargs
        chunks = []
        async for chunk in stream:
            chunks.append(chunk)
        self.objects[key] = b"".join(chunks)
        return key

    async def get(self, key: str) -> AsyncIterator[bytes]:
        yield self.objects[key]

    async def get_range(self, key: str, start: int, end: int) -> bytes:
        return self.objects[key][start:end + 1]

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    async def exists(self, key: str) -> bool:
        return key in self.objects

    async def rename(self, old_key: str, new_key: str) -> str:
        if old_key in self.objects and new_key != old_key:
            self.objects[new_key] = self.objects.pop(old_key)
            return new_key
        return old_key


class _FakeIngestClient:
    profile_name = "ingest"
    model = "fake-ingest"

    async def complete(self, request):
        from marginalia.llm.types import ChatResponse, TokenUsage

        return ChatResponse(
            text="""<summary>
Supplemental fixture extracted for upload testing.
</summary>
<description>
Synthetic upload fixture.
</description>
<sections>
s1 | lines 1-5 | Extracted content | Contains the uploaded text. | upload, fixture
</sections>
<extra>
notable: supplemental e2e fixture
</extra>
<entry_extra>
Uploaded through the real upload service.
</entry_extra>
<catalog_path>Tests / Supplemental</catalog_path>
<tags>
source: test-fixture
form: supplemental
</tags>""",
            tool_calls=[],
            stop_reason="end_turn",
            usage=TokenUsage(input_tokens=100, output_tokens=80),
            parsed_json=None,
        )


@pytest.mark.asyncio
async def test_supplemental_formats_upload_ingest_and_read_segment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _make_test_root()
    root.mkdir(parents=True, exist_ok=False)
    try:
        monkeypatch.setenv("MARGINALIA_HOME", str(root))
        monkeypatch.setenv("STORAGE_BACKEND", "local")
        monkeypatch.setenv("WORKER_ENABLED", "false")
        monkeypatch.setenv("LLM_DEFAULT_API_KEY", "sk-fake")
        monkeypatch.setenv("LLM_DEFAULT_MODEL", "fake-model")
        monkeypatch.setenv("SEMANTIC_RECALL_ENABLED", "false")

        from marginalia.config import get_settings
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from sqlalchemy.pool import StaticPool

        import marginalia.db.engine as engine_module
        from marginalia.db.engine import dispose_engine, get_session_factory
        from marginalia.db.models import Base, File
        from marginalia.pipelines.registry import resolve_pipeline
        from marginalia.services.user_files import open_extracted_text_preview
        from marginalia.services.upload import upload
        from marginalia.storage import reset_storage_cache
        import marginalia.tasks.handlers.ingest_file as ingest_module
        from marginalia.tasks.handlers.ingest_file import handle_ingest_file

        get_settings.cache_clear()  # type: ignore[attr-defined]
        reset_storage_cache()
        await dispose_engine()
        engine_module._engine = create_async_engine(
            "sqlite+aiosqlite://",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        engine_module._session_factory = async_sessionmaker(
            bind=engine_module._engine,
            expire_on_commit=False,
            autoflush=False,
        )
        async with engine_module._engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        import marginalia.pipelines._text_indexer as text_indexer
        import marginalia.pipelines.markitdown as markitdown_pipeline

        text_indexer.get_chat_client = lambda profile="ingest": _FakeIngestClient()  # type: ignore[assignment]

        def fake_markitdown_convert(body: bytes, suffix: str) -> str:
            return f"{suffix} extracted body\nmarkitdown-token-{suffix.lstrip('.')}"

        monkeypatch.setattr(
            markitdown_pipeline,
            "_convert_bytes_with_markitdown",
            fake_markitdown_convert,
        )

        cases = [
            {
                "name": "thread.eml",
                "mime": "message/rfc822",
                "body": _sample_eml(),
                "pipeline": "email",
                "kind": "email",
                "coverage": "email_extracted_text",
                "token": "eml-upload-token",
            },
            {
                "name": "rules.xls",
                "mime": "application/vnd.ms-excel",
                "body": b"fake-xls-bytes",
                "pipeline": "markitdown",
                "kind": "table",
                "coverage": "markitdown_extracted_text",
                "token": "markitdown-token-xls",
            },
            {
                "name": "book.epub",
                "mime": "application/epub+zip",
                "body": b"fake-epub-bytes",
                "pipeline": "markitdown",
                "kind": "ebook",
                "coverage": "markitdown_extracted_text",
                "token": "markitdown-token-epub",
            },
            {
                "name": "mail.msg",
                "mime": "application/vnd.ms-outlook",
                "body": b"fake-msg-bytes",
                "pipeline": "markitdown",
                "kind": "email",
                "coverage": "markitdown_extracted_text",
                "token": "markitdown-token-msg",
            },
        ]

        storage = _MemoryObjectStorage()
        monkeypatch.setattr(ingest_module, "get_storage", lambda: storage)
        factory = get_session_factory()

        for case in cases:
            async with factory() as db:
                result = await upload(
                    db,
                    storage,
                    stream=_one_chunk(case["body"]),
                    fallback_name=case["name"],
                    remote_path=f"/tests/supplemental/{case['name']}",
                    content_type=case["mime"],
                )
                await db.commit()

            await handle_ingest_file({"file_id": result.file_id})

            async with factory() as db:
                file_row = await db.get(File, result.file_id)
                assert file_row is not None
                assert file_row.ingest_status == "done"
                assert file_row.kind == case["kind"]
                coverage = (file_row.description or {}).get("coverage") or {}
                assert coverage["source_mode"] == case["coverage"]
                assert coverage["indexed_partial"] is False

                pipeline = resolve_pipeline(
                    file_row.mime_type,
                    file_row.original_ext,
                    filename=result.display_name,
                )
                assert pipeline is not None
                assert pipeline.name == case["pipeline"]

                segment = await pipeline.read_segment(
                    file_row=file_row,
                    args={"pattern": case["token"], "context_lines": 1},
                    storage=storage,
                )
                assert segment.error is None
                assert case["token"] in segment.text

                if case["kind"] == "email":
                    preview = await open_extracted_text_preview(
                        db,
                        entry_id=result.entry_id,
                        max_chars=10_000,
                        storage=storage,
                    )
                    assert preview.truncated is False
                    assert case["token"] in preview.text
    finally:
        try:
            from marginalia.db.engine import dispose_engine
            from marginalia.storage import reset_storage_cache

            reset_storage_cache()
            await dispose_engine()
        finally:
            if root.name.startswith("marginalia_supplemental_e2e_"):
                shutil.rmtree(root, ignore_errors=True)


def test_files_kind_check_migration_allows_supplemental_kinds() -> None:
    from marginalia.db.bootstrap import _relax_files_kind_check

    engine = sa.create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as conn:
            conn.execute(sa.text("""
                CREATE TABLE files (
                    id VARCHAR(36) NOT NULL PRIMARY KEY,
                    storage_key VARCHAR(255) NOT NULL UNIQUE,
                    sha256 VARCHAR(64) NOT NULL,
                    size_bytes BIGINT NOT NULL,
                    mime_type VARCHAR(255),
                    original_ext VARCHAR(32),
                    kind VARCHAR(16),
                    summary TEXT,
                    description JSON,
                    extra TEXT,
                    ingest_status VARCHAR(16) NOT NULL,
                    ingested_at DATETIME,
                    deleted_at DATETIME,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    CONSTRAINT ck_files_ingest_status
                        CHECK (ingest_status IN ('pending', 'processing', 'done', 'failed')),
                    CONSTRAINT ck_files_kind
                        CHECK (kind IS NULL OR kind IN (
                            'text', 'table', 'log', 'image', 'audio', 'video',
                            'code', 'container'
                        ))
                )
            """))
            conn.execute(sa.text("""
                INSERT INTO files (
                    id, storage_key, sha256, size_bytes, kind, ingest_status,
                    created_at, updated_at
                )
                VALUES (
                    'file-1', 'objects/file-1', :sha, 10, 'text', 'done',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            """), {"sha": "0" * 64})

            _relax_files_kind_check(conn)

            conn.execute(sa.text("""
                INSERT INTO files (
                    id, storage_key, sha256, size_bytes, kind, ingest_status,
                    created_at, updated_at
                )
                VALUES (
                    'file-2', 'objects/file-2', :sha, 10, 'email', 'done',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            """), {"sha": "1" * 64})
            conn.execute(sa.text("""
                INSERT INTO files (
                    id, storage_key, sha256, size_bytes, kind, ingest_status,
                    created_at, updated_at
                )
                VALUES (
                    'file-3', 'objects/file-3', :sha, 10, 'ebook', 'done',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            """), {"sha": "2" * 64})
    finally:
        engine.dispose()


def test_bootstrap_migrates_files_kind_with_live_file_entries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    db_path = home / "marginalia.db"
    seed_engine = sa.create_engine(f"sqlite:///{db_path}")
    try:
        with seed_engine.begin() as conn:
            conn.execute(sa.text("PRAGMA foreign_keys=ON"))
            conn.execute(sa.text("""
                CREATE TABLE files (
                    storage_key VARCHAR(255) NOT NULL,
                    sha256 VARCHAR(64) NOT NULL,
                    size_bytes BIGINT NOT NULL,
                    mime_type VARCHAR(255),
                    original_ext VARCHAR(32),
                    kind VARCHAR(16),
                    summary TEXT,
                    description JSON,
                    extra TEXT,
                    ingest_status VARCHAR(16) NOT NULL,
                    ingested_at DATETIME,
                    deleted_at DATETIME,
                    id VARCHAR(36) NOT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    CONSTRAINT pk_files PRIMARY KEY (id),
                    CONSTRAINT ck_files_ingest_status
                        CHECK (ingest_status IN (
                            'pending', 'processing', 'done', 'failed'
                        )),
                    CONSTRAINT ck_files_kind
                        CHECK (kind IS NULL OR kind IN (
                            'text', 'table', 'log', 'image', 'audio', 'video',
                            'code', 'container'
                        )),
                    CONSTRAINT uq_files_storage_key UNIQUE (storage_key)
                )
            """))
            conn.execute(sa.text("""
                CREATE TABLE file_entries (
                    folder_id VARCHAR(36),
                    file_id VARCHAR(36) NOT NULL,
                    display_name VARCHAR(255) NOT NULL,
                    lifecycle VARCHAR(16) NOT NULL,
                    catalog_id VARCHAR(36),
                    extra TEXT,
                    deleted_at DATETIME,
                    purge_after DATETIME,
                    id VARCHAR(36) NOT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    CONSTRAINT pk_file_entries PRIMARY KEY (id),
                    CONSTRAINT lifecycle CHECK (
                        lifecycle IN (
                            'active', 'demoted', 'archived',
                            'manual_active', 'manual_archived'
                        )
                    ),
                    FOREIGN KEY(file_id) REFERENCES files (id) ON DELETE RESTRICT
                )
            """))
            conn.execute(sa.text("""
                INSERT INTO files (
                    storage_key, sha256, size_bytes, kind, ingest_status,
                    id, created_at, updated_at
                )
                VALUES (
                    'objects/file-1', :sha, 10, 'text', 'done',
                    'file-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            """), {"sha": "0" * 64})
            conn.execute(sa.text("""
                INSERT INTO file_entries (
                    file_id, display_name, lifecycle, id, created_at, updated_at
                )
                VALUES (
                    'file-1', 'sample.txt', 'active', 'entry-1',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            """))
    finally:
        seed_engine.dispose()

    monkeypatch.setenv("MARGINALIA_HOME", str(home))
    monkeypatch.setenv("DB_BACKEND", "sqlite")
    monkeypatch.setenv("STORAGE_BACKEND", "mirror")

    from marginalia.config import get_settings
    from marginalia.db.bootstrap import bootstrap_schema
    from marginalia.db.engine import dispose_engine
    from marginalia.storage import reset_storage_cache

    get_settings.cache_clear()  # type: ignore[attr-defined]
    reset_storage_cache()
    asyncio.run(dispose_engine())
    try:
        asyncio.run(bootstrap_schema())
    finally:
        asyncio.run(dispose_engine())

    with sqlite3.connect(db_path) as con:
        con.execute("PRAGMA foreign_keys=ON")
        con.execute("""
            INSERT INTO files (
                storage_key, sha256, size_bytes, kind, ingest_status,
                id, created_at, updated_at
            )
            VALUES (
                'objects/file-2', ?, 10, 'email', 'done',
                'file-2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
        """, ("1" * 64,))
        assert con.execute("PRAGMA foreign_key_check").fetchall() == []
