from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from sqlalchemy.ext.asyncio import AsyncSession

from marginalia.db.models.tasks import Task
from marginalia.repositories import tasks as tasks_repo
from marginalia.tasks.kinds import DEFAULT_PRIORITIES
from marginalia.utils.ids import new_id


async def enqueue(
    session: AsyncSession,
    *,
    kind: str,
    payload: Mapping[str, Any] | None = None,
    dedup_key: str | None = None,
    priority: int | None = None,
    scheduled_at: datetime | None = None,
    max_attempts: int = 5,
) -> Task | None:
    """Enqueue a task. If `dedup_key` matches an existing pending/running row,
    skip insertion and return the existing task (or None if it cannot be reused)."""
    now = datetime.now(timezone.utc)
    if dedup_key is not None:
        existing = await tasks_repo.find_pending_or_running_by_dedup(
            session, dedup_key,
        )
        if existing is not None:
            return existing

    task = Task(
        id=new_id(),
        kind=kind,
        payload=dict(payload or {}),
        dedup_key=dedup_key,
        status="pending",
        priority=priority if priority is not None else DEFAULT_PRIORITIES.get(kind, 100),
        attempts=0,
        max_attempts=max_attempts,
        scheduled_at=scheduled_at or now,
        created_at=now,
    )
    session.add(task)
    await session.flush()
    return task
