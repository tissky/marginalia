"""audit_events repository — pure SA helpers for the AuditEvent table.

Caller owns the transaction. Every state-changing DB op should be paired
with an `append(...)` in the same session_scope so the audit log can never
disagree with reality.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from marginalia.db.models import AuditEvent
from marginalia.utils.ids import new_id


async def append(
    db: AsyncSession,
    *,
    kind: str,
    payload: Mapping[str, Any] | None = None,
    session_id: str | None = None,
    conversation_id: str | None = None,
    task_id: str | None = None,
    occurred_at: datetime | None = None,
) -> AuditEvent:
    """Append one audit_events row in the caller's transaction."""
    event = AuditEvent(
        id=new_id(),
        occurred_at=occurred_at or datetime.now(timezone.utc),
        kind=kind,
        session_id=session_id,
        conversation_id=conversation_id,
        task_id=task_id,
        payload=dict(payload or {}),
    )
    db.add(event)
    return event


async def oldest_occurred_at(db: AsyncSession) -> datetime | None:
    """Used by prune for the "oldest_before" stat."""
    return (
        await db.execute(select(func.min(AuditEvent.occurred_at)))
    ).scalar_one_or_none()


async def delete_before(db: AsyncSession, cutoff: datetime) -> int:
    """Delete every audit row strictly older than `cutoff`. Returns row
    count. Used by the prune handler — this is the only legal delete path
    on this table."""
    return (
        await db.execute(
            delete(AuditEvent).where(AuditEvent.occurred_at < cutoff)
        )
    ).rowcount or 0
