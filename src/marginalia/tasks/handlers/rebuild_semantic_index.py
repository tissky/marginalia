from __future__ import annotations

from typing import Any, Mapping

from marginalia.db.session import session_scope
from marginalia.repositories import audit_events as audit_events_repo
from marginalia.semantic.index import DEFAULT_INDEX_NAME, build_semantic_index
from marginalia.tasks.kinds import KIND_REBUILD_SEMANTIC_INDEX, task_handler


@task_handler(KIND_REBUILD_SEMANTIC_INDEX)
async def handle_rebuild_semantic_index(payload: Mapping[str, Any]) -> None:
    index_name = str(payload.get("index_name") or DEFAULT_INDEX_NAME)
    batch_size = payload.get("batch_size")
    concurrency = int(payload.get("concurrency") or 1)

    async with session_scope() as session:
        result = await build_semantic_index(
            session,
            index_name=index_name,
            batch_size=int(batch_size) if batch_size is not None else None,
            concurrency=concurrency,
            resume=False,
            progress_every=0,
        )
        await audit_events_repo.append(
            session,
            kind="semantic_index_rebuilt",
            payload={
                "index_name": result.index_name,
                "index_dir": str(result.index_dir),
                "entries_indexed": result.entries_indexed,
                "model": result.model,
                "dimensions": result.dimensions,
                "elapsed_ms": result.elapsed_ms,
                "total_tokens": result.total_tokens,
            },
        )
        await session.commit()
