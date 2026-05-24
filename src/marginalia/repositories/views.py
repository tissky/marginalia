"""views repository — pure SA queries against the View table.

Caller owns the transaction.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from marginalia.db.models import View


async def list_for_snapshot(db: AsyncSession, *, limit: int) -> list[View]:
    """First N views ordered by name. Used by the agent's stable-context
    snapshot."""
    rows = (
        await db.execute(
            select(View).order_by(View.name).limit(limit)
        )
    ).scalars().all()
    return list(rows)


async def list_all(db: AsyncSession) -> list[View]:
    """Every saved view. Used by propose_views to compute "already-covered"
    cluster exclusions."""
    rows = (await db.execute(select(View))).scalars().all()
    return list(rows)
