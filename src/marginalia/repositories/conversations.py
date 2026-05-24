"""conversations repository — pure SA queries against the Conversation table.

Caller owns the transaction.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from marginalia.db.models import Conversation


async def latest_ended(db: AsyncSession) -> Conversation | None:
    """Most-recently-ended conversation, or None. Used by /conversations/latest
    so the CLI's `/export` (no args) can pick a sensible default."""
    return (
        await db.execute(
            select(Conversation)
            .where(Conversation.ended_at.isnot(None))
            .order_by(Conversation.ended_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def list_agent_responses_since(
    db: AsyncSession, cutoff: datetime,
) -> list[str]:
    """Non-null `agent_response` strings for conversations started at or
    after `cutoff`. Used by mine_citation_graph to extract per-turn citation
    co-occurrences."""
    rows = (
        await db.execute(
            select(Conversation.agent_response).where(
                Conversation.agent_response.is_not(None),
                Conversation.started_at >= cutoff,
            )
        )
    ).scalars().all()
    return [r for r in rows if r is not None]
