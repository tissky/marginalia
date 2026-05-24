"""Interactive REPL loop for the Marginalia CLI.

Backed by prompt_toolkit when stdin is a TTY:
  - Tab-completion on `/<command>` (slash completer)
  - Persisted history (`~/.marginalia_history`)
  - Smart Ctrl-C: cancels current line if any input typed, exits at empty prompt
  - Multi-line via Esc+Enter or Alt+Enter

When stdin is not a TTY (pipes / tests), falls back to the original
`sys.stdin.readline` loop so e2e tests and shell scripts keep working.

## Embedded vs remote mode

Default is **embedded**: the FastAPI app is mounted in-process and the
TaskRunner is started inside the CLI's own asyncio loop. No HTTP socket
is opened — `httpx.ASGITransport` invokes the ASGI app directly.

When `--server <URL>` is passed (or `MARGINALIA_SERVER` env is set), the
CLI runs in **remote** mode: a normal HTTP client targeting the URL.
Use this when running the server on a different machine or when sharing
one knowledge base across multiple CLIs.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import sys
from pathlib import Path
from typing import AsyncIterator, Optional

import httpx

from marginalia.cli.client import CliHttpError, MarginaliaClient
from marginalia.cli.commands import (
    CliContext,
    _ExitREPL,
    dispatch,
    list_commands,
)

PROMPT = "marginalia> "
HISTORY_PATH = Path.home() / ".marginalia_history"
EMBEDDED_BASE_URL = "http://embedded"
EMBEDDED_MARKER = "embedded"
ENV_SERVER = "MARGINALIA_SERVER"


def _print_banner(ctx: CliContext, mode: str) -> None:
    print()
    print("Marginalia CLI")
    if mode == EMBEDDED_MARKER:
        print(f"  mode: embedded (server runs in this process)")
    else:
        print(f"  server: {ctx.client.base_url}")
    print(f"  cwd:    {ctx.cwd_remote}")
    print(f"  on_conflict: {ctx.on_conflict}")
    print()
    print("type /help for commands, or just type a question.")
    print("  Tab        — complete /<command>")
    print("  Ctrl-C     — cancel current line (or quit when empty)")
    print("  Ctrl-D     — exit")
    print("  Alt+Enter  — newline (multi-line input)")
    print()


# ---- prompt_toolkit-based reader (interactive TTY) ------------------------

def _make_slash_completer():
    """Build a Completer that suggests `/<command>` names from the registry.

    Factored out so tests can exercise completion without spinning up a
    full PromptSession (which on Windows requires a real console buffer)."""
    from prompt_toolkit.completion import Completer, Completion

    completion_strs = [name for name, _ in list_commands()]

    class SlashCompleter(Completer):
        def get_completions(self, document, complete_event):
            text = document.text_before_cursor
            if not text.startswith("/"):
                return
            for c in completion_strs:
                if c.startswith(text):
                    yield Completion(c, start_position=-len(text))

    return SlashCompleter()


def _build_pt_session():
    """Lazy-build a prompt_toolkit PromptSession with completion + history."""
    from prompt_toolkit import PromptSession
    from prompt_toolkit.history import FileHistory
    from prompt_toolkit.key_binding import KeyBindings

    bindings = KeyBindings()

    @bindings.add("escape", "enter")
    def _(event):
        """Alt+Enter inserts a newline (so users can submit multi-line text)."""
        event.app.current_buffer.newline()

    history_path = HISTORY_PATH
    try:
        history_path.parent.mkdir(parents=True, exist_ok=True)
        history_path.touch(exist_ok=True)
    except Exception:
        history_path = None  # fall back to in-memory

    return PromptSession(
        message=PROMPT,
        completer=_make_slash_completer(),
        history=FileHistory(str(history_path)) if history_path else None,
        key_bindings=bindings,
        complete_while_typing=False,
    )


async def _read_with_pt(session) -> Optional[str]:
    """Returns None on EOF / Ctrl-C-at-empty, str otherwise."""
    from prompt_toolkit.patch_stdout import patch_stdout

    try:
        with patch_stdout():
            line = await session.prompt_async()
    except (EOFError, KeyboardInterrupt):
        return None
    return line


# ---- fallback reader (non-TTY: pipes, ASGI tests) ------------------------

async def _read_via_stdin() -> Optional[str]:
    loop = asyncio.get_running_loop()
    try:
        line = await loop.run_in_executor(None, sys.stdin.readline)
    except (EOFError, KeyboardInterrupt):
        return None
    if not line:
        return None
    return line.rstrip("\n")


# ---- transport selection -------------------------------------------------

@contextlib.asynccontextmanager
async def _embedded_lifespan() -> AsyncIterator[httpx.AsyncBaseTransport]:
    """Yield an in-process ASGI transport with FastAPI lifespan running.

    LifespanManager fires startup (TaskRunner.start) on enter and
    shutdown (TaskRunner.stop, dispose_engine) on exit, the same way
    uvicorn would. Until shutdown completes, in-flight ingest tasks keep
    progressing.
    """
    from asgi_lifespan import LifespanManager

    from marginalia.main import app

    async with LifespanManager(app) as manager:
        yield httpx.ASGITransport(app=manager.app)


async def _flush_pending_tasks_prompt(
    client: MarginaliaClient, *, mode: str
) -> None:
    """Embedded mode only: if tasks are still on the queue, ask the user
    whether to wait for them or quit now.

    Wait path = poll running-count every 1s until it hits zero.
    Quit-now path = return; lifespan shutdown will tear down TaskRunner;
    `recover_stuck_tasks` resumes them on next launch.
    """
    if mode != EMBEDDED_MARKER:
        return
    try:
        counts = await client.running_task_count()
    except Exception:
        return
    total = counts.get("running", 0) + counts.get("pending", 0)
    if total <= 0:
        return

    print(
        f"\n{total} background task(s) still queued "
        f"({counts.get('running', 0)} running, {counts.get('pending', 0)} pending)."
    )
    print("[w]ait for them, or [q]uit now (next launch will resume)? ", end="")
    sys.stdout.flush()
    try:
        choice = (await _read_via_stdin()) or ""
    except (EOFError, KeyboardInterrupt):
        choice = ""
    if choice.strip().lower() not in ("w", "wait", ""):
        return  # quit now

    print("waiting for tasks to finish (Ctrl-C to abandon)...")
    try:
        last = total
        while True:
            await asyncio.sleep(1.0)
            counts = await client.running_task_count()
            now = counts.get("running", 0) + counts.get("pending", 0)
            if now <= 0:
                print("all tasks done.")
                return
            if now != last:
                print(
                    f"  {now} task(s) remaining "
                    f"({counts.get('running', 0)} running, "
                    f"{counts.get('pending', 0)} pending)"
                )
                last = now
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("(abandoning wait — tasks will resume on next launch)")


# ---- main loop ------------------------------------------------------------

async def run_repl(
    *,
    base_url: str = "http://127.0.0.1:8000",
    transport: httpx.AsyncBaseTransport | None = None,
    mode: str = "remote",
) -> int:
    """Run the REPL.

    Parameters
    ----------
    base_url
        For remote mode: server URL. For embedded mode: a sentinel
        ``http://embedded`` is used (httpx requires a base URL even with
        a custom transport).
    transport
        Optional httpx transport. Set when embedded mode prepares an
        ASGITransport in advance, or when tests inject a fake.
    mode
        ``"embedded"`` or ``"remote"`` — affects only the banner.
    """
    client = MarginaliaClient(base_url=base_url, transport=transport)
    ctx = CliContext(client=client)

    use_pt = sys.stdin.isatty() and sys.stdout.isatty()
    pt_session = _build_pt_session() if use_pt else None

    try:
        try:
            await client.health()
        except Exception as exc:  # noqa: BLE001
            target = "embedded server" if mode == EMBEDDED_MARKER else base_url
            print(f"cannot reach {target}: {exc}")
            return 2

        _print_banner(ctx, mode)

        while True:
            if pt_session is not None:
                line = await _read_with_pt(pt_session)
                if line is None:
                    print()
                    break
            else:
                sys.stdout.write(PROMPT)
                sys.stdout.flush()
                line = await _read_via_stdin()
                if line is None:
                    print()
                    break

            try:
                await dispatch(ctx, line)
            except _ExitREPL:
                break
            except KeyboardInterrupt:
                print("\n(interrupted)")
                continue
            except CliHttpError as e:
                print(f"server error: HTTP {e.status} {e.payload}")
            except Exception as e:  # noqa: BLE001
                print(f"client error: {e!r}")

        if ctx.session_id is not None:
            try:
                await client.close_session(ctx.session_id)
            except Exception:
                pass
        await _flush_pending_tasks_prompt(client, mode=mode)
        return 0
    finally:
        await client.aclose()


async def _run_embedded() -> int:
    async with _embedded_lifespan() as transport:
        return await run_repl(
            base_url=EMBEDDED_BASE_URL,
            transport=transport,
            mode=EMBEDDED_MARKER,
        )


def main() -> int:
    import argparse

    argv = sys.argv[1:]
    # Detect subcommand BEFORE argparse to avoid clashing with REPL's --server.
    if argv and argv[0] == "init":
        from marginalia.cli.init_cmd import cmd_init_main
        return cmd_init_main(argv[1:])
    if argv and argv[0] == "storage":
        from marginalia.cli.storage_cmd import cmd_storage_main
        return cmd_storage_main(argv[1:])

    parser = argparse.ArgumentParser(
        prog="marginalia",
        description=(
            "Marginalia CLI. Run with no args for the embedded REPL, "
            "`--server URL` (or MARGINALIA_SERVER env) for remote mode, "
            "or `marginalia init` to bootstrap a project."
        ),
    )
    parser.add_argument(
        "--server", default=None,
        help="Server URL for remote mode. If omitted, runs in-process "
             "(reads MARGINALIA_SERVER env as fallback).",
    )
    args = parser.parse_args(argv)
    server_url = args.server or os.environ.get(ENV_SERVER) or None

    try:
        if server_url:
            return asyncio.run(run_repl(base_url=server_url, mode="remote"))
        return asyncio.run(_run_embedded())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
