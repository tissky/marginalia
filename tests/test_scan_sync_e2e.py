"""Vault scan + sync e2e.

Run:
    .venv/Scripts/python tests/test_scan_sync_e2e.py

Steps:
  1. Mirror backend, vault is `data/library/`.
  2. Upload three files via the upload service. They land on disk under
     the vault.
  3. Add a 4th file directly on disk (simulating a user dropping a
     file into Finder). /check should report 1 new.
  4. Rename a 5th-file's display via plain os.rename. /check should
     report 1 moved.
  5. Delete a file from disk. /check should report 1 missing.
  6. Run sync (ingest_all_new + apply_moved + forget_all_missing).
     Final /check should be in_sync.
"""
from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

_TEST_ROOT = Path(__file__).resolve().parent / "_scan_sync_e2e_data"
if _TEST_ROOT.exists():
    shutil.rmtree(_TEST_ROOT)
_TEST_ROOT.mkdir(parents=True)
_VAULT = _TEST_ROOT / "library"
os.environ["MARGINALIA_HOME"] = str(_TEST_ROOT)
os.environ["SQLITE_PATH"] = str(_TEST_ROOT / "marginalia.db")
os.environ["MIRROR_VAULT_ROOT"] = str(_VAULT)
os.environ["STORAGE_BACKEND"] = "mirror"
os.environ["WORKER_ENABLED"] = "false"
os.environ["LLM_DEFAULT_API_KEY"] = "sk-fake"
os.environ["LLM_DEFAULT_MODEL"] = "fake-model"

from marginalia.config import get_settings  # noqa: E402

get_settings.cache_clear()  # type: ignore[attr-defined]

from sqlalchemy import select  # noqa: E402

from marginalia.db.engine import get_engine, get_session_factory  # noqa: E402
from marginalia.db.models import Base, FileEntry  # noqa: E402
from marginalia.services.scan import scan_vault  # noqa: E402
from marginalia.services.sync import (  # noqa: E402
    apply_moved, forget_all_missing, ingest_all_new,
)
from marginalia.storage import get_storage, reset_storage_cache  # noqa: E402


async def _create_schema():
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def _upload(body: bytes, *, name: str, remote_path: str) -> str:
    from marginalia.services.upload import upload
    storage = get_storage()

    async def _stream():
        yield body

    factory = get_session_factory()
    async with factory() as db:
        result = await upload(
            db, storage,
            stream=_stream(), fallback_name=name,
            remote_path=remote_path,
            content_type="text/plain",
        )
        await db.commit()
        return result.entry_id


async def _main() -> None:
    reset_storage_cache()
    await _create_schema()

    # 1. Seed three files.
    e1 = await _upload(b"first body\n", name="alpha.txt", remote_path="/notes/")
    e2 = await _upload(b"second body\n", name="beta.txt", remote_path="/notes/")
    e3 = await _upload(b"third body\n", name="gamma.txt", remote_path="/research/")
    print("[1] uploaded 3 files via mirror upload service")

    # Sanity: scan should be all in_sync.
    report = await scan_vault(_VAULT)
    assert report.in_sync_count == 3, \
        f"expected 3 in_sync, got {report.in_sync_count}"
    assert report.total_changes == 0, \
        f"expected 0 changes, got {report.total_changes}"
    print(f"[2] initial scan: in_sync={report.in_sync_count}, changes=0")

    # 3. Drop a file directly on disk.
    new_disk = _VAULT / "research" / "delta.txt"
    new_disk.write_bytes(b"externally added\n")
    report = await scan_vault(_VAULT)
    assert len(report.new) == 1, f"expected 1 new, got {report.new}"
    assert report.new[0].name == "delta.txt"
    print(f"[3] disk-side new file detected: {report.new[0].relative_to(_VAULT)}")

    # 4. Rename a file on disk: alpha.txt → alpha-renamed.txt.
    old_alpha = _VAULT / "notes" / "alpha.txt"
    new_alpha = _VAULT / "notes" / "alpha-renamed.txt"
    os.rename(old_alpha, new_alpha)
    report = await scan_vault(_VAULT)
    assert len(report.moved) == 1, \
        f"expected 1 moved, got {[(e.display_name, p) for e, p in report.moved]}"
    moved_entry, moved_path = report.moved[0]
    assert moved_entry.id == e1, f"wrong moved entry: {moved_entry.id} vs {e1}"
    assert moved_path.name == "alpha-renamed.txt"
    print(f"[4] disk rename detected: alpha.txt → {moved_path.name}")

    # 5. Delete a file from disk.
    (_VAULT / "notes" / "beta.txt").unlink()
    report = await scan_vault(_VAULT)
    missing_ids = {e.id for e in report.missing}
    assert e2 in missing_ids, \
        f"expected e2 in missing; missing_ids={missing_ids}"
    print(f"[5] disk delete detected: 1 missing entry")

    # 6. Apply sync.
    n_ingest = len(await ingest_all_new(report))
    n_moved = await apply_moved(report)
    n_forgotten = await forget_all_missing(report)
    print(f"[6] applied: ingest={n_ingest} moved={n_moved} forgotten={n_forgotten}")
    assert n_ingest == 1, f"expected to ingest 1, got {n_ingest}"
    assert n_moved == 1, f"expected to move 1, got {n_moved}"
    assert n_forgotten == 1, f"expected to forget 1, got {n_forgotten}"

    # Final state — should be all in_sync (3 originals minus deleted +
    # 1 newly-ingested = 3 entries, 3 disk files).
    final = await scan_vault(_VAULT)
    assert final.total_changes == 0, \
        f"post-sync expected 0 changes, got {final.total_changes}: " \
        f"new={len(final.new)} missing={len(final.missing)} moved={len(final.moved)}"
    assert final.in_sync_count == 3, \
        f"post-sync expected 3 in_sync, got {final.in_sync_count}"
    print(f"[7] final: in_sync={final.in_sync_count}, changes=0")

    # 8. Cross-folder move: pick the gamma entry (currently in
    # /research/gamma.txt) and move its disk file to /archive/old/.
    gamma_old = _VAULT / "research" / "gamma.txt"
    gamma_new_dir = _VAULT / "archive" / "old"
    gamma_new_dir.mkdir(parents=True, exist_ok=True)
    gamma_new = gamma_new_dir / "gamma.txt"
    os.rename(gamma_old, gamma_new)
    cross = await scan_vault(_VAULT)
    assert len(cross.moved) == 1, \
        f"expected 1 cross-folder moved, got {[(e.display_name, p) for e, p in cross.moved]}"
    moved_entry, moved_path = cross.moved[0]
    assert moved_entry.id == e3, \
        f"wrong moved entry: {moved_entry.id} vs {e3}"
    assert moved_path == gamma_new
    print(f"[8] cross-folder move detected: research/gamma.txt → archive/old/gamma.txt")

    # 9. Apply just the move (no need for full sync). Folder /archive/old
    # doesn't exist in db yet — apply_moved must auto-create it.
    n_moved2 = await apply_moved(cross)
    if n_moved2 != 1:
        # Diagnostic: what state is the entry actually in?
        async with get_session_factory()() as s:
            e = await s.get(FileEntry, e3)
            print(f"  [debug] e3 entry: deleted_at={e.deleted_at if e else 'GONE'}, "
                  f"display_name={e.display_name if e else None!r}, "
                  f"folder_id={e.folder_id if e else None!r}")
        raise AssertionError(f"expected 1 cross-folder move applied, got {n_moved2}")
    after_cross = await scan_vault(_VAULT)
    assert after_cross.total_changes == 0, \
        f"after cross-move sync, expected 0 changes, got {after_cross.total_changes}"
    # Verify db now points at the new folder.
    factory = get_session_factory()
    async with factory() as s:
        e = await s.get(FileEntry, e3)
        assert e is not None and e.folder_id is not None
        # Folder name should be "old" (the leaf).
        from marginalia.db.models import Folder
        f = await s.get(Folder, e.folder_id)
        assert f is not None and f.name == "old", \
            f"expected gamma to live in folder 'old', got {f.name if f else None!r}"
    print(f"[9] move applied: db folder updated, auto-created /archive/old")

    print("\nALL SCAN_SYNC E2E CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(_main())
