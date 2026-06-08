from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from marginalia.config import get_settings
from marginalia.db.session import get_session
from marginalia.semantic.index import DEFAULT_INDEX_NAME, semantic_index_status
from marginalia.tasks.enqueue import enqueue
from marginalia.tasks.kinds import KIND_REBUILD_SEMANTIC_INDEX


router = APIRouter(prefix="/semantic-index", tags=["semantic_index"])


class SemanticIndexRebuildBody(BaseModel):
    index_name: str = DEFAULT_INDEX_NAME
    concurrency: int = 1


@router.get("/status")
async def status() -> dict[str, Any]:
    return semantic_index_status()


@router.post("/rebuild", status_code=202)
async def rebuild(
    body: SemanticIndexRebuildBody,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    settings = get_settings()
    if not settings.embedding_api_key:
        raise HTTPException(
            status_code=400,
            detail="embedding api key is not configured",
        )
    concurrency = max(1, int(body.concurrency or 1))
    index_name = body.index_name or DEFAULT_INDEX_NAME
    task = await enqueue(
        session,
        kind=KIND_REBUILD_SEMANTIC_INDEX,
        payload={
            "index_name": index_name,
            "concurrency": concurrency,
        },
        dedup_key=f"{KIND_REBUILD_SEMANTIC_INDEX}:{index_name}",
        max_attempts=2,
    )
    await session.commit()
    return {
        "task_id": task.id if task is not None else None,
        "index_name": index_name,
        "status": semantic_index_status(index_name),
    }
