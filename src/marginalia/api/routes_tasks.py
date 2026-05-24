"""Task introspection HTTP routes.

These endpoints expose minimal task-queue state for CLI bookkeeping —
e.g. the embedded REPL checks `running-count` before exit so the user
can choose to wait for in-flight ingest work to finish before the
TaskRunner dies with the process.

These are not the worker's RPC surface; the worker reads the queue
directly from the DB.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from marginalia.db.session import get_session
from marginalia.repositories import tasks as tasks_repo

router = APIRouter(tags=["tasks"])


@router.get("/tasks/running-count")
async def running_count(
    db: AsyncSession = Depends(get_session),
) -> dict[str, int]:
    """Count tasks currently in `running` or `pending` status.

    Returned counts include both states because in embedded mode,
    pending tasks won't progress once the CLI exits either — the user
    cares about everything still on the queue, not just the in-flight
    rows.
    """
    return await tasks_repo.count_running_and_pending(db)
