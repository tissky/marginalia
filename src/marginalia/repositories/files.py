"""files repository — pure SA queries against the File table.

Caller owns the transaction.
"""
from __future__ import annotations

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from marginalia.db.models import File


async def get_by_sha256(db: AsyncSession, sha256: str) -> File | None:
    """Live or soft-deleted file row matching the content hash. Used by
    upload to detect dedup hits before a tentative storage put is finalised."""
    return (
        await db.execute(select(File).where(File.sha256 == sha256))
    ).scalar_one_or_none()


async def hard_delete_by_id(db: AsyncSession, file_id: str) -> None:
    """Physical delete of a file row. Used by purge_deleted_files when no
    live or soft-deleted entries still reference the file."""
    await db.execute(delete(File).where(File.id == file_id))


async def list_live_storage_keys(
    db: AsyncSession,
) -> list[tuple[str, str, str]]:
    """`(id, storage_key, sha256)` for every live file row, oldest first.
    Used by the storage migration CLI to walk every file."""
    rows = (
        await db.execute(
            select(File.id, File.storage_key, File.sha256)
            .where(File.deleted_at.is_(None))
            .order_by(File.created_at.asc())
        )
    ).all()
    return [(fid, sk, sha) for fid, sk, sha in rows]


async def sample_live_storage_keys(
    db: AsyncSession, *, limit: int,
) -> list[str]:
    """First N live storage_keys. Used by the startup consistency check that
    detects backend-vs-stored-key mismatches."""
    rows = (
        await db.execute(
            select(File.storage_key)
            .where(File.deleted_at.is_(None))
            .limit(limit)
        )
    ).scalars().all()
    return list(rows)


async def update_storage_key(
    db: AsyncSession, *, file_id: str, storage_key: str,
) -> None:
    """Used by the storage migration CLI after successfully writing the
    file body to its new key on the destination backend."""
    await db.execute(
        update(File)
        .where(File.id == file_id)
        .values(storage_key=storage_key)
    )
