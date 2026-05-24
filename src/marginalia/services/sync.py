"""Apply scan diffs.

Three operations the user can run after `/check`:

  - ingest_all_new(report)      Upload + ingest each disk-side new file.
  - apply_moved(report)         Update db rename/move to match disk.
  - forget_all_missing(report)  Soft-delete entries whose disk file is gone.

Each operation is independent and idempotent — safe to re-run after
partial failure. The /sync command does ingest_all_new + apply_moved +
forget_all_missing in one call.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

from sqlalchemy.ext.asyncio import AsyncSession

from marginalia.db.engine import get_session_factory
from marginalia.db.models import FileEntry
from marginalia.services.entries import (
    move_entry,
    rename_entry,
    soft_delete_entry,
    _build_folder_display_path,
)
from marginalia.services.folders import resolve_or_create_folder
from marginalia.services.scan import ScanReport
from marginalia.services.upload import upload as upload_service
from marginalia.storage import MirrorStorage, get_storage

log = logging.getLogger(__name__)


async def adopt_disk_file(path: Path, vault_root: Path) -> str | None:
    """Register a single disk-side file in the db without re-writing
    the bytes (file is already where mirror wants it). Returns the
    new entry_id or None on failure.

    Used by both `/ingest --all` (called once per `report.new` entry)
    and `/ingest <path>` (single-file adoption from inside the vault).
    """
    storage = get_storage()
    if not isinstance(storage, MirrorStorage):
        raise RuntimeError(
            "adopt_disk_file is only meaningful when STORAGE_BACKEND=mirror"
        )

    from datetime import datetime, timezone
    import hashlib
    import mimetypes
    from marginalia.db.models import File, FileEntry
    from marginalia.services.audit import write_event
    from marginalia.services.folders import resolve_or_create_folder
    from marginalia.tasks.enqueue import enqueue
    from marginalia.tasks.kinds import KIND_INGEST_FILE
    from marginalia.utils.ids import new_id

    rel = path.relative_to(vault_root).as_posix()
    folder_segments = list(path.relative_to(vault_root).parts[:-1])
    display_name = path.relative_to(vault_root).parts[-1]
    size = path.stat().st_size
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 256):
            h.update(chunk)
    sha256 = h.hexdigest()
    ext_pos = display_name.rfind(".")
    original_ext = display_name[ext_pos:].lower() if ext_pos != -1 else None
    mime_type = mimetypes.guess_type(display_name)[0]

    factory = get_session_factory()
    async with factory() as session:
        try:
            folder = (
                await resolve_or_create_folder(
                    session, segments=folder_segments,
                )
                if folder_segments else None
            )
            folder_id = folder.id if folder else None
            now = datetime.now(timezone.utc)
            file_id = new_id()
            file_row = File(
                id=file_id,
                storage_key=rel,
                sha256=sha256,
                size_bytes=size,
                mime_type=mime_type,
                original_ext=original_ext,
                kind="text",
                ingest_status="pending",
                created_at=now, updated_at=now,
            )
            session.add(file_row)
            await session.flush()

            entry = FileEntry(
                id=new_id(),
                folder_id=folder_id or "",
                file_id=file_id,
                display_name=display_name,
                lifecycle="active",
                created_at=now, updated_at=now,
            )
            session.add(entry)
            await session.flush()

            await write_event(session, kind="file_uploaded", payload={
                "file_id": file_id, "entry_id": entry.id,
                "display_name": display_name, "sha256": sha256,
                "size_bytes": size, "mime_type": mime_type,
                "source": "scan_adopt",
            })
            await enqueue(
                session, kind=KIND_INGEST_FILE,
                payload={"file_id": file_id, "entry_id": entry.id},
            )
            await session.commit()
            return entry.id
        except Exception as exc:  # noqa: BLE001
            log.error("adopt_disk_file: failed for %s: %s", path, exc)
            await session.rollback()
            return None


async def ingest_all_new(report: ScanReport) -> list[str]:
    """Register each disk-side new file in the db. We do NOT re-write
    the bytes — the file is already where mirror wants it; rewriting
    would either duplicate (collision rename) or shred the source."""
    created: list[str] = []
    for path in report.new:
        eid = await adopt_disk_file(path, report.vault_root)
        if eid is not None:
            created.append(eid)
    return created


async def apply_moved(report: ScanReport) -> int:
    """For each entry whose disk file moved/renamed, update db to match.
    Returns the count actually applied.

    Key subtlety: the disk file is ALREADY at the new path (the user
    moved it externally). We need to update the file_row's storage_key
    to the new path BEFORE calling rename_entry / move_entry, so the
    mirror rename hook sees disk and db agree on current location and
    becomes a no-op move.
    """
    factory = get_session_factory()
    n = 0
    for entry, new_path in report.moved:
        rel = new_path.relative_to(report.vault_root).as_posix()
        new_segments = list(new_path.relative_to(report.vault_root).parts[:-1])
        new_name = new_path.relative_to(report.vault_root).parts[-1]

        async with factory() as session:
            live = await session.get(FileEntry, entry.id)
            if live is None or live.deleted_at is not None:
                continue
            # Sync storage_key to actual disk location FIRST.
            from marginalia.db.models import File
            file_row = await session.get(File, live.file_id)
            if file_row is None:
                continue
            file_row.storage_key = rel
            new_folder = (
                await resolve_or_create_folder(
                    session, segments=new_segments,
                )
                if new_segments else None
            )
            try:
                folder_changed = (
                    new_folder.id if new_folder else None
                ) != live.folder_id
                name_changed = live.display_name != new_name
                if folder_changed:
                    # move first, then rename if needed (move_entry
                    # doesn't accept new_name in this codebase).
                    await move_entry(
                        session, entry_id=live.id,
                        new_folder_id=(
                            new_folder.id if new_folder else live.folder_id
                        ),
                    )
                    if name_changed:
                        await rename_entry(
                            session, entry_id=live.id,
                            new_name=new_name,
                        )
                elif name_changed:
                    await rename_entry(
                        session, entry_id=live.id,
                        new_name=new_name,
                    )
                else:
                    await session.commit()
                    continue
                await session.commit()
                n += 1
            except Exception as exc:  # noqa: BLE001
                log.error("apply_moved: failed for entry=%s: %s",
                          entry.id, exc)
                await session.rollback()
    return n


async def forget_all_missing(report: ScanReport) -> int:
    """Soft-delete every entry the report flagged as missing on disk."""
    factory = get_session_factory()
    n = 0
    for entry in report.missing:
        async with factory() as session:
            try:
                await soft_delete_entry(session, entry_id=entry.id)
                await session.commit()
                n += 1
            except Exception as exc:  # noqa: BLE001
                log.error("forget_all_missing: failed for entry=%s: %s",
                          entry.id, exc)
                await session.rollback()
    return n
