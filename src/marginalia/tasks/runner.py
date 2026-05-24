from __future__ import annotations

import asyncio
import logging
import os
import socket
from datetime import datetime, timedelta, timezone
from typing import Iterable

from marginalia.config import Settings, get_settings
from marginalia.db.session import session_scope
from marginalia.repositories import tasks as tasks_repo
from marginalia.tasks import handlers as _handlers_pkg  # noqa: F401  (register)
from marginalia.tasks.kinds import get_handler

log = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _backoff(attempts: int) -> timedelta:
    base = min(60 * (2 ** max(0, attempts - 1)), 60 * 60)
    return timedelta(seconds=base)


class TaskRunner:
    """In-process async worker. Polls `tasks` table, claims rows, runs handlers."""

    def __init__(self, settings: Settings | None = None, worker_id: str | None = None) -> None:
        self.settings = settings or get_settings()
        self.worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}"
        self._stop = asyncio.Event()
        self._loop_task: asyncio.Task[None] | None = None
        self._inflight: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        if self._loop_task is not None:
            return
        from marginalia.tasks.handlers.periodic_tick import bootstrap_periodic_tick
        await bootstrap_periodic_tick()
        self._stop.clear()
        self._loop_task = asyncio.create_task(self._run(), name="marginalia.task_runner")

    async def stop(self) -> None:
        self._stop.set()
        if self._loop_task:
            await self._loop_task
            self._loop_task = None
        if self._inflight:
            await asyncio.gather(*self._inflight, return_exceptions=True)

    async def _run(self) -> None:
        log.info("TaskRunner %s starting", self.worker_id)
        while not self._stop.is_set():
            try:
                claimed = await self._claim_batch(self.settings.worker_batch_size)
            except Exception:
                log.exception("claim batch failed")
                claimed = []
            if not claimed:
                try:
                    await asyncio.wait_for(
                        self._stop.wait(), timeout=self.settings.worker_poll_interval_seconds
                    )
                except asyncio.TimeoutError:
                    pass
                continue
            for task_id in claimed:
                t = asyncio.create_task(self._process(task_id))
                self._inflight.add(t)
                t.add_done_callback(self._inflight.discard)
        log.info("TaskRunner %s stopped", self.worker_id)

    async def _claim_batch(self, limit: int) -> list[str]:
        now = _now()
        lease_until = now + timedelta(seconds=self.settings.worker_lease_seconds)
        async with session_scope() as session:
            rows = await tasks_repo.claim_pending_ids(
                session,
                now=now,
                limit=limit,
                use_skip_locked=self.settings.db_backend == "postgres",
            )
            if not rows:
                await session.commit()
                return []
            await tasks_repo.mark_running(
                session,
                ids=rows,
                now=now,
                lease_until=lease_until,
                worker_id=self.worker_id,
            )
            await session.commit()
            return list(rows)

    async def _process(self, task_id: str) -> None:
        async with session_scope() as session:
            task = await tasks_repo.get(session, task_id)
            if task is None or task.status != "running":
                return
            handler = get_handler(task.kind)
            payload = dict(task.payload or {})
            attempts = task.attempts
            max_attempts = task.max_attempts
            kind = task.kind

        if handler is None:
            await self._fail(task_id, attempts, max_attempts, f"no handler registered for {kind!r}")
            return

        heartbeat = asyncio.create_task(self._heartbeat(task_id))
        try:
            await handler(payload)
        except Exception as exc:
            heartbeat.cancel()
            log.exception("task %s (%s) failed", task_id, kind)
            await self._fail(task_id, attempts, max_attempts, repr(exc))
            return
        finally:
            heartbeat.cancel()

        async with session_scope() as session:
            await tasks_repo.mark_done(session, task_id=task_id, now=_now())
            await session.commit()

    async def _heartbeat(self, task_id: str) -> None:
        interval = self.settings.worker_heartbeat_seconds
        try:
            while True:
                await asyncio.sleep(interval)
                async with session_scope() as session:
                    await tasks_repo.heartbeat(
                        session,
                        task_id=task_id,
                        lease_until=_now() + timedelta(
                            seconds=self.settings.worker_lease_seconds,
                        ),
                    )
                    await session.commit()
        except asyncio.CancelledError:
            return

    async def _fail(
        self, task_id: str, attempts: int, max_attempts: int, error: str
    ) -> None:
        async with session_scope() as session:
            if attempts >= max_attempts:
                await tasks_repo.mark_dead(
                    session, task_id=task_id, now=_now(), error=error,
                )
            else:
                await tasks_repo.reschedule_for_retry(
                    session,
                    task_id=task_id,
                    error=error,
                    next_run_at=_now() + _backoff(attempts),
                )
            await session.commit()


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    runner = TaskRunner()
    await runner.start()
    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        await runner.stop()


def _try_recover_stale(unused_iterable: Iterable[None] = ()) -> None:
    """Reserved for future: rescue running rows whose lease expired before their
    worker could finish (worker crashed). Implementation deferred."""
    return None


if __name__ == "__main__":
    asyncio.run(main())
