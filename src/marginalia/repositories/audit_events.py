"""audit_events repository — pure SA helpers for the AuditEvent table.

The append path is on the model itself (`AuditEvent.append`) — this repo
only handles read + retention-prune queries that the tasks-layer needs.

Caller owns the transaction.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from marginalia.db.models import AuditEvent


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
