"""Slash command registry for the Marginalia CLI.

Style: Claude Code-like. The user types `/<name> <args>` to invoke a
command; anything else is forwarded to the agent as chat.

Adding a command: write `async def cmd_xxx(ctx, args_str)` and register it
via the @command decorator. Help text is its docstring's first line.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, MutableMapping

from marginalia.cli.client import CliHttpError, MarginaliaClient
from marginalia.cli.render import Spinner, print_markdown, render_markdown


@dataclass
class CliContext:
    """Mutable per-REPL state."""
    client: MarginaliaClient
    session_id: str | None = None
    on_conflict: str = "rename"
    cwd_remote: str = "/"  # for resolving relative remote paths
    history: list[dict] = field(default_factory=list)


CommandHandler = Callable[[CliContext, str], Awaitable[None]]
COMMANDS: MutableMapping[str, CommandHandler] = {}
DOCS: MutableMapping[str, str] = {}


def command(name: str) -> Callable[[CommandHandler], CommandHandler]:
    def deco(fn: CommandHandler) -> CommandHandler:
        if name in COMMANDS:
            raise RuntimeError(f"command {name!r} already registered")
        COMMANDS[name] = fn
        DOCS[name] = (fn.__doc__ or "").strip().splitlines()[0] if fn.__doc__ else ""
        return fn
    return deco


def list_commands() -> list[tuple[str, str]]:
    return sorted(((f"/{n}", DOCS.get(n, "")) for n in COMMANDS))


# ---- helpers --------------------------------------------------------------

def _resolve_remote(ctx: CliContext, raw: str) -> str:
    """Resolve a remote path relative to ctx.cwd_remote.

    Absolute paths (starting with `/`) bypass cwd. Relative paths are
    appended to cwd. Trailing slash is preserved (it carries semantic
    meaning in the upload API)."""
    if raw.startswith("/"):
        return raw
    base = ctx.cwd_remote.rstrip("/")
    if not base:
        base = ""
    trailing = "/" if raw.endswith("/") else ""
    return f"{base}/{raw.rstrip('/')}{trailing}"


def _split_first(arg_str: str) -> tuple[str, str]:
    arg_str = arg_str.strip()
    if not arg_str:
        return "", ""
    parts = arg_str.split(None, 1)
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[1].strip()


# ---- command implementations ----------------------------------------------

@command("help")
async def cmd_help(ctx: CliContext, args: str) -> None:
    """List available slash commands."""
    print("\nAvailable slash commands:")
    for name, doc in list_commands():
        print(f"  {name:<20} {doc}")
    print("\nAnything not starting with '/' is treated as chat with the agent.")
    print(f"current cwd: {ctx.cwd_remote!r}\n")


@command("quit")
async def cmd_quit(ctx: CliContext, args: str) -> None:
    """Exit the CLI."""
    raise _ExitREPL()


@command("exit")
async def cmd_exit(ctx: CliContext, args: str) -> None:
    """Exit the CLI (alias of /quit)."""
    raise _ExitREPL()


@command("clear")
async def cmd_clear(ctx: CliContext, args: str) -> None:
    """End the current chat session and start a fresh one."""
    if ctx.session_id is not None:
        try:
            await ctx.client.close_session(ctx.session_id)
        except Exception as e:  # noqa: BLE001
            print(f"  (close failed: {e})")
        ctx.session_id = None
        ctx.history.clear()
    print("session cleared. next chat will open a new session.")


@command("new")
async def cmd_new(ctx: CliContext, args: str) -> None:
    """Open a new chat session explicitly (chat does this lazily)."""
    if ctx.session_id is not None:
        await cmd_clear(ctx, "")
    out = await ctx.client.create_session(initiating_user_message=args or None)
    ctx.session_id = out["session_id"]
    print(f"session: {ctx.session_id} (started_at: {out.get('started_at')})")


@command("cd")
async def cmd_cd(ctx: CliContext, args: str) -> None:
    """Change the working remote path (used to resolve relative paths)."""
    target = (args or "/").strip()
    if not target.startswith("/"):
        target = _resolve_remote(ctx, target)
    if not target.endswith("/"):
        target = target + "/"
    ctx.cwd_remote = target
    print(f"cwd: {ctx.cwd_remote}")


@command("ls")
async def cmd_ls(ctx: CliContext, args: str) -> None:
    """List folders + entries at root or under a folder id."""
    parent_id = args.strip() or None
    out = await ctx.client.list_folders(parent_id=parent_id)
    folders = out.get("folders") or []
    if not folders:
        print("(no folders)")
        return
    print(f"\n{'NAME':<30} {'ID':<38}")
    print("-" * 70)
    for f in folders:
        print(f"{f['name']:<30} {f['id']:<38}")
    print()


@command("tree")
async def cmd_tree(ctx: CliContext, args: str) -> None:
    """Show the folder tree (depth-limited)."""
    max_depth = 4
    if args.strip().isdigit():
        max_depth = int(args.strip())

    async def _walk(parent_id: str | None, depth: int, prefix: str) -> None:
        if depth > max_depth:
            return
        out = await ctx.client.list_folders(parent_id=parent_id)
        folders = out.get("folders") or []
        for i, f in enumerate(folders):
            last = i == len(folders) - 1
            connector = "└── " if last else "├── "
            print(f"{prefix}{connector}{f['name']}  ({f['id'][:8]}…)")
            await _walk(f["id"], depth + 1, prefix + ("    " if last else "│   "))

    print()
    await _walk(None, 0, "")
    print()


@command("upload")
async def cmd_upload(ctx: CliContext, args: str) -> None:
    """/upload <local_path> <remote_path>  — upload a single file.

    remote_path:
      - trailing '/'         folder; display_name = local basename
      - includes a '.' (ext) folder + filename (display_name = last segment)
    Quote any path containing spaces (both local and remote)."""
    local, remote = _split_first(args)
    if not local or not remote:
        print('usage: /upload <local_path> <remote_path>')
        print('  remote_path: trailing "/" = folder; with extension = filename')
        print('  quote paths with spaces:  /upload "~/My docs/x.pdf" "/papers/Y Z.pdf"')
        return

    full_remote = _resolve_remote(ctx, remote)

    # In mirror mode, reject local paths that already live inside the
    # vault — those should go through /ingest, which adopts in place.
    # Without this, /upload would re-write the bytes (collision-renaming
    # the existing on-disk file).
    from marginalia.config import get_settings
    from marginalia.storage import MirrorStorage, get_storage
    storage = get_storage()
    if isinstance(storage, MirrorStorage):
        from pathlib import Path as _P
        vault_root = _P(get_settings().mirror_vault_root).resolve()
        try:
            _P(local).resolve().relative_to(vault_root)
        except ValueError:
            pass  # outside vault → fine, proceed
        else:
            print(
                f"{local!r} is inside the vault.\n"
                f"  → /upload is for copying files INTO the vault. "
                f"Use /ingest {_P(local).resolve().relative_to(vault_root).as_posix()!r} "
                f"to register an existing vault file."
            )
            return

    try:
        out = await ctx.client.upload_file(
            local_path=local,
            remote_path=full_remote,
            on_conflict=ctx.on_conflict,
        )
    except CliHttpError as e:
        print(f"upload failed: HTTP {e.status} {e.payload}")
        return
    print(
        f"uploaded {Path(local).name} -> {full_remote}\n"
        f"  entry={out['entry_id']}  display={out['display_name']}"
        + ("  (deduped)" if out.get("deduped") else "")
        + ("  (auto-renamed)" if out.get("auto_renamed") else "")
        + ("  (skipped)" if out.get("skipped") else "")
    )


@command("on-conflict")
async def cmd_on_conflict(ctx: CliContext, args: str) -> None:
    """Set name-conflict policy (rename/error/skip)."""
    arg = args.strip().lower()
    if arg not in ("rename", "error", "skip"):
        print(f"current: {ctx.on_conflict}. usage: /on-conflict rename|error|skip")
        return
    ctx.on_conflict = arg
    print(f"on_conflict = {arg}")


@command("search")
async def cmd_search(ctx: CliContext, args: str) -> None:
    """/search <query>  — find files by name or content summary."""
    q = args.strip()
    if not q:
        print("usage: /search <query>")
        return
    out = await ctx.client.search(q, limit=25)
    entries = out.get("entries") or []
    if not entries:
        print(f"no matches for {q!r}")
        return
    print(f"\n{len(entries)} result(s):\n")
    print(f"  {'NAME':<36} {'PATH':<32} {'ENTRY':<12}")
    print("  " + "-" * 80)
    for e in entries:
        eid_short = e["entry_id"][:8] + "…"
        name = e["display_name"]
        if len(name) > 35:
            name = name[:32] + "…"
        path = e["folder_path"]
        if len(path) > 31:
            path = "…" + path[-30:]
        print(f"  {name:<36} {path:<32} {eid_short:<12}")
    print()


@command("info")
async def cmd_info(ctx: CliContext, args: str) -> None:
    """/info <entry_id>  — show user-visible metadata for an entry."""
    eid = args.strip()
    if not eid:
        print("usage: /info <entry_id>")
        return
    try:
        meta = await ctx.client.get_entry_metadata(eid)
    except CliHttpError as e:
        print(f"info failed: HTTP {e.status} {e.payload}")
        return
    summary = meta.get("summary") or "(not yet indexed)"
    size = meta.get("size_bytes") or 0
    print(f"""
  entry:    {meta['entry_id']}
  name:     {meta['display_name']}
  folder:   {meta['folder_path']}
  size:     {size:,} bytes
  type:     {meta.get('mime_type') or '?'}
  ext:      {meta.get('original_ext') or '?'}
  sha256:   {meta.get('sha256', '')[:16]}…
  state:    {meta['lifecycle']}  (ingest={meta.get('ingest_status')})
  created:  {meta.get('created_at') or '?'}
  updated:  {meta.get('updated_at') or '?'}

  summary:
  {summary}
""")


@command("discover")
async def cmd_discover(ctx: CliContext, args: str) -> None:
    """/discover <entry_id> [N]  — show entries the corpus has linked to it.

    Backed by random-walk-with-restart over the entry_relations graph
    (cooccurrence + tag overlap + citation co-citation). Use it when you
    want to see what to read next from a known starting point — the same
    signal the agent uses via the find_related tool to skip an extra
    search loop."""
    parts = args.strip().split()
    if not parts:
        print("usage: /discover <entry_id> [top_k=8]")
        return
    entry_id = parts[0]
    top_k = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 8
    try:
        out = await ctx.client.discover(entry_id, top_k=top_k)
    except CliHttpError as e:
        print(f"discover failed: HTTP {e.status} {e.payload}")
        return
    results = out.get("results") or []
    if not results:
        print(f"no relations recorded for {entry_id[:8]} yet "
              f"(run /tend to populate signals).")
        return
    print(f"\n  seed: {entry_id[:8]}…")
    for r in results:
        bar = "█" * max(1, int(round(r["score"] * 50)))
        direct = "*" if r.get("direct_edge_weight") else " "
        print(
            f"  {direct} {r['score']:.3f}  {bar:<50s}  "
            f"{r['entry_id'][:8]}…  {r['display_name']}"
        )
    print(
        f"\n  {len(results)} related entries  "
        f"(* = direct edge from seed)"
    )


@command("export")
async def cmd_export(ctx: CliContext, args: str) -> None:
    """/export [<conv_id>] [<dest.zip>]  — export a conversation report + cited files.

    Resolution order when conv_id is omitted:
      1. ctx.history's last conversation (this CLI's most recent chat)
      2. server's GET /conversations/latest (most recent ended conversation)
      3. error message if neither exists
    """
    parts = args.strip().split()
    conv_id: str | None = None
    dest_str: str | None = None
    if parts:
        conv_id = parts[0]
        if len(parts) > 1:
            dest_str = parts[1]
    if conv_id is None:
        if ctx.history:
            conv_id = ctx.history[-1]["conversation_id"]
        else:
            try:
                latest = await ctx.client.latest_conversation()
            except CliHttpError as e:
                print(f"could not look up latest conversation: HTTP {e.status} {e.payload}")
                return
            if latest is None:
                print("no ended conversation found on the server.")
                print("usage: /export <conv_id> [<dest.zip>]")
                return
            conv_id = latest["conversation_id"]
            preview = latest.get("user_message_preview") or ""
            print(f"(no id given; using server's most recent conversation: "
                  f"{conv_id[:8]}… \"{preview}\")")

    dest = Path(dest_str) if dest_str else (
        Path.cwd() / f"conversation-{conv_id[:8]}.zip"
    )
    try:
        out = await ctx.client.export_conversation(conv_id, dest=dest)
    except CliHttpError as e:
        print(f"export failed: HTTP {e.status} {e.payload}")
        return
    print(
        f"exported {out['bytes_written']:,} bytes -> {out['saved_to']}\n"
        f"  citations: {out['citation_count']} "
        f"(missing: {out['missing_count']})"
    )


@command("download")
async def cmd_download(ctx: CliContext, args: str) -> None:
    """/download <entry_id|folder_id> [<local_path>]  — file → bytes; folder → zip."""
    parts = args.strip().split()
    if not parts:
        print("usage: /download <entry_id|folder_id> [<local_path>] [--folder]")
        return

    force_folder = False
    if "--folder" in parts:
        force_folder = True
        parts = [p for p in parts if p != "--folder"]
    if not parts:
        print("missing id")
        return
    target_id = parts[0]
    dest_str = parts[1] if len(parts) > 1 else None

    if not force_folder:
        try:
            meta = await ctx.client.get_entry_metadata(target_id)
        except CliHttpError as e:
            meta = None
            if e.status != 404:
                print(f"download failed: HTTP {e.status} {e.payload}")
                return
        if meta is not None:
            dest = Path(dest_str) if dest_str else Path.cwd() / meta["display_name"]
            try:
                out = await ctx.client.download_entry(target_id, dest=dest)
            except CliHttpError as e:
                print(f"download failed: HTTP {e.status} {e.payload}")
                return
            print(f"saved {out['bytes_written']:,} bytes -> {out['saved_to']}")
            return

    dest = Path(dest_str) if dest_str else Path.cwd() / f"{target_id[:8]}.zip"
    if dest.is_dir():
        dest = dest / f"{target_id[:8]}.zip"
    try:
        out = await ctx.client.download_folder(target_id, dest=dest)
    except CliHttpError as e:
        print(f"folder download failed: HTTP {e.status} {e.payload}")
        return
    print(
        f"saved zip ({out['member_count']} files, "
        f"{out['bytes_written']:,} bytes) -> {out['saved_to']}"
    )
    """/download <entry_id|folder_id> [<local_path>]  — file → bytes; folder → zip.

    The id is tried as an entry first; on 404 we fall back to folder
    download (zip). Pass `--folder` to skip the entry attempt and force
    folder mode.
    """
    parts = args.strip().split()
    if not parts:
        print("usage: /download <entry_id|folder_id> [<local_path>] [--folder]")
        return

    force_folder = False
    if "--folder" in parts:
        force_folder = True
        parts = [p for p in parts if p != "--folder"]
    if not parts:
        print("missing id")
        return

    target_id = parts[0]
    dest_str = parts[1] if len(parts) > 1 else None

    # Try entry first unless --folder was passed
    if not force_folder:
        try:
            meta = await ctx.client.get_entry_metadata(target_id)
        except CliHttpError as e:
            meta = None
            if e.status != 404:
                print(f"download failed: HTTP {e.status} {e.payload}")
                return
        if meta is not None:
            dest = Path(dest_str) if dest_str else Path.cwd() / meta["display_name"]
            try:
                out = await ctx.client.download_entry(target_id, dest=dest)
            except CliHttpError as e:
                print(f"download failed: HTTP {e.status} {e.payload}")
                return
            print(f"saved {out['bytes_written']:,} bytes -> {out['saved_to']}")
            return

    # Fall back to folder zip
    dest = Path(dest_str) if dest_str else Path.cwd() / f"{target_id[:8]}.zip"
    if dest.is_dir():
        dest = dest / f"{target_id[:8]}.zip"
    try:
        out = await ctx.client.download_folder(target_id, dest=dest)
    except CliHttpError as e:
        print(f"folder download failed: HTTP {e.status} {e.payload}")
        return
    print(
        f"saved zip ({out['member_count']} files, "
        f"{out['bytes_written']:,} bytes) -> {out['saved_to']}"
    )


@command("tend")
async def cmd_tend(ctx: CliContext, args: str) -> None:
    """Run a maintenance pass — `tend [run_id]` to check status, no args to start."""
    arg = args.strip()
    if arg:
        try:
            status = await ctx.client.tend_status(arg)
        except CliHttpError as e:
            print(f"tend status failed: HTTP {e.status} {e.payload}")
            return
        _print_tend_status(status)
        return

    try:
        out = await ctx.client.tend_start()
    except CliHttpError as e:
        print(f"tend failed: HTTP {e.status} {e.payload}")
        return
    run_id = out["tend_run_id"]
    print(f"tend run started: {run_id}")
    print(f"  {len(out['tasks'])} task(s) dispatched along the maintenance chain.")
    skipped = [t for t in out["tasks"] if t.get("skipped")]
    if skipped:
        print(
            f"  ({len(skipped)} reused an existing pending/running task — "
            "no duplicate work)"
        )
    for t in out["tasks"]:
        marker = "↺" if t.get("skipped") else "→"
        print(f"  {marker} {t['kind']}")
    print(
        f"\nthe librarian will work in the background. "
        f"check progress with `/tend {run_id}`."
    )


def _print_tend_status(status: dict) -> None:
    total = status.get("total", 0)
    settled = status.get("settled", 0)
    print(
        f"tend run {status['tend_run_id']}: "
        f"{settled}/{total} settled"
        + ("  ✓ all done" if status.get("all_settled") else "")
    )
    counts = status.get("state_counts") or {}
    parts = [f"{k}={v}" for k, v in counts.items() if v]
    if parts:
        print("  " + "  ".join(parts))
    for p in status.get("progress") or []:
        kind = p.get("kind", "?")
        st = p.get("status", "?")
        ts = p.get("finished_at") or p.get("started_at") or ""
        ts_short = ts[:19] if ts else ""
        err = f"  err: {p.get('last_error')[:80]}" if p.get("last_error") else ""
        print(f"  [{st:8}] {kind}  {ts_short}{err}")


# ---- chat fallback --------------------------------------------------------

_TOOL_LABELS = {
    "list_catalogs": "浏览目录",
    "read_catalog": "读取目录",
    "resolve_tag": "解析标签",
    "materialize_view": "实体化视图",
    "search_metadata": "检索元数据",
    "read_entries_metadata": "读取条目元数据",
    "read_files": "阅读原文",
    "search_journal": "翻阅日志",
}


def _format_tool_call(name: str, arguments: dict) -> str:
    label = _TOOL_LABELS.get(name, name)
    if not arguments:
        return f"调用 {label}"
    # one-line preview: "name(k=v, k=v)" truncated
    parts = []
    for k, v in arguments.items():
        s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
        if len(s) > 24:
            s = s[:21] + "..."
        parts.append(f"{k}={s}")
    inner = ", ".join(parts)
    if len(inner) > 60:
        inner = inner[:57] + "..."
    return f"调用 {label}({inner})"


async def chat(ctx: CliContext, message: str) -> None:
    """Forward a non-slash message to the agent and render the SSE stream."""
    if ctx.session_id is None:
        out = await ctx.client.create_session(initiating_user_message=message)
        ctx.session_id = out["session_id"]
        print(f"(opened session {ctx.session_id})")

    sp = Spinner("调查员准备中...").start()
    conversation_id: str | None = None
    plan_text: str = ""
    answer: str = ""
    done_payload: dict = {}
    error_msg: str | None = None
    tool_count = 0

    try:
        async for ev in ctx.client.stream_chat(ctx.session_id, message):
            if ev.event_type == "conversation":
                conversation_id = ev.data
            elif ev.event_type == "planning":
                sp.update("制定调查计划...")
            elif ev.event_type == "plan":
                plan_text = ev.data
                sp.finish("计划已就绪")
                if plan_text.strip():
                    print()
                    print_markdown(plan_text)
                    print()
                sp = Spinner("调查员开始工作...").start()
            elif ev.event_type == "thinking":
                sp.update("调查员思考中...")
            elif ev.event_type == "tool_call":
                tool_count += 1
                try:
                    payload = json.loads(ev.data)
                except (ValueError, TypeError):
                    payload = {}
                sp.update(_format_tool_call(
                    payload.get("name", "?"),
                    payload.get("arguments") or {},
                ))
            elif ev.event_type == "tool_result":
                # keep label briefly; next thinking/tool_call event will replace it
                try:
                    payload = json.loads(ev.data)
                except (ValueError, TypeError):
                    payload = {}
                if not payload.get("ok", True):
                    sp.update(f"工具失败: {payload.get('error', '')[:40]}")
            elif ev.event_type == "answer":
                answer = ev.data
            elif ev.event_type == "error":
                error_msg = ev.data
            elif ev.event_type == "done":
                try:
                    done_payload = json.loads(ev.data)
                except (ValueError, TypeError):
                    done_payload = {}
    except CliHttpError as e:
        sp.fail(f"HTTP {e.status}")
        print(f"chat failed: {e.payload}")
        return

    if error_msg is not None:
        sp.fail(error_msg)
        return

    sp.finish("回答已就绪")
    print()
    print_markdown(answer)
    print()
    truncated = bool(done_payload.get("truncated"))
    print(
        f"  [tokens in={done_payload.get('tokens_in', 0)} "
        f"out={done_payload.get('tokens_out', 0)} "
        f"tools={done_payload.get('tool_calls', tool_count)} "
        f"llm_calls={done_payload.get('llm_calls', 0)} "
        f"{done_payload.get('duration_ms', 0)}ms]"
        + ("  ⚠ truncated" if truncated else "")
    )
    if conversation_id:
        ctx.history.append({
            "user": message,
            "assistant": answer,
            "conversation_id": conversation_id,
        })


# ---- dispatch -------------------------------------------------------------

class _ExitREPL(Exception):
    """Raised by /quit to break out of the REPL loop."""


# ---- /check, /sync, /ingest --all, /forget --all-missing -----------------

@command("check")
async def cmd_check(ctx: CliContext, args: str) -> None:
    """/check  — diff the mirror vault against db (no writes).

    Walks <vault>, hashes each file, and reports new / modified / moved /
    missing entries vs the db. Read-only — apply with /ingest.
    """
    report = await _load_scan_report()
    if report is None:
        return
    from marginalia.services.scan import render_report
    print(render_report(report))


@command("ingest")
async def cmd_ingest(ctx: CliContext, args: str) -> None:
    """/ingest <vault_path> | --all  — make db match disk.

    Like `git add`: bring db in sync with the actual state of the file
    on disk. Handles four cases at once:
      - file is new on disk        → create entry + queue ingest
      - file content changed       → re-queue ingest (entry kept)
      - file moved/renamed         → update folder + display_name
      - file gone from disk        → soft-delete entry

    Single-path form acts on whatever category that path falls in.
    --all form applies every change /check reports. /upload is for
    copying a file from OUTSIDE the vault into it; /ingest is the
    in-vault counterpart.
    """
    from pathlib import Path
    from marginalia.config import get_settings
    from marginalia.storage import MirrorStorage, get_storage

    storage = get_storage()
    if not isinstance(storage, MirrorStorage):
        print(
            "/ingest only works with STORAGE_BACKEND=mirror.\n"
            "(local backend keeps files at UUID paths; nothing for the "
            "user to drop into a vault.)"
        )
        return

    parts = args.split()
    if not parts:
        print(
            "usage: /ingest <vault_path>   sync a single file\n"
            "       /ingest --all          sync the entire vault\n"
            "  copy a file from outside the vault → /upload"
        )
        return

    vault_root = Path(get_settings().mirror_vault_root).resolve()

    if "--all" in parts:
        report = await _load_scan_report()
        if report is None:
            return
        if report.total_changes == 0:
            print("nothing to do — vault is in sync with db.")
            return
        from marginalia.services.scan import render_report
        from marginalia.services.sync import apply_all
        print(render_report(report))
        if "--yes" not in parts:
            print(
                f"\napply {report.total_changes} changes? [y/N] ",
                end="",
            )
            try:
                confirm = input().strip().lower()
            except EOFError:
                confirm = ""
            if confirm not in ("y", "yes"):
                print("cancelled.")
                return
        out = await apply_all(report)
        print(
            f"applied: ingested={out['ingested']} "
            f"modified={out['modified']} moved={out['moved']} "
            f"forgotten={out['forgotten']}"
        )
        return

    # Single-path form. Resolve, validate vault membership, route to
    # the right per-category handler.
    target_arg = parts[0]
    target = Path(target_arg)
    if not target.is_absolute():
        target = (vault_root / target_arg).resolve()
    else:
        target = target.resolve()
    try:
        target.relative_to(vault_root)
    except ValueError:
        print(
            f"{target_arg!r} is outside the vault ({vault_root}).\n"
            f"  → use /upload <local> <remote> to copy a file into the vault."
        )
        return
    if not target.is_file():
        print(
            f"not a file: {target}\n"
            f"  (single-path /ingest expects an existing vault file. "
            f"To clean up entries whose disk file is gone, run /ingest --all.)"
        )
        return

    # Route by classifying this one path. Cheap: hash the file, check db.
    from marginalia.services.sync import (
        adopt_disk_file, apply_modified, apply_moved,
    )
    from marginalia.services.scan import scan_vault, ScanReport
    full_report = await scan_vault(vault_root)
    rel = target.relative_to(vault_root).as_posix()

    # Match this path against each category in the full scan.
    new_match = next((p for p in full_report.new
                      if p.relative_to(vault_root).as_posix() == rel), None)
    mod_match = next(((e, p) for e, p in full_report.modified
                      if p.relative_to(vault_root).as_posix() == rel), None)
    moved_match = next(((e, p) for e, p in full_report.moved
                        if p.relative_to(vault_root).as_posix() == rel), None)

    if new_match is not None:
        eid = await adopt_disk_file(new_match, vault_root)
        print(f"ingested {rel} → entry={eid[:8] if eid else '?'}")
        return
    if mod_match is not None:
        # apply_modified expects a ScanReport — build a minimal one.
        sub = ScanReport(vault_root=vault_root,
                         modified=[mod_match])
        n = await apply_modified(sub)
        print(f"refreshed {rel} (entry stays, ingest re-queued; n={n})")
        return
    if moved_match is not None:
        sub = ScanReport(vault_root=vault_root,
                         moved=[moved_match])
        n = await apply_moved(sub)
        print(f"updated db to match disk path {rel} (n={n})")
        return
    print(f"{rel} is already in sync.")


async def _load_scan_report():
    """Resolve vault root, walk it, return ScanReport. Mirror-only."""
    from marginalia.config import get_settings
    from marginalia.services.scan import scan_vault
    from marginalia.storage import MirrorStorage, get_storage
    from pathlib import Path

    storage = get_storage()
    if not isinstance(storage, MirrorStorage):
        print(
            "/check + /sync only work with STORAGE_BACKEND=mirror.\n"
            "(local backend keeps files at UUID paths — there's nothing "
            "for the user to scan in Finder.)"
        )
        return None
    settings = get_settings()
    return await scan_vault(Path(settings.mirror_vault_root))


async def dispatch(ctx: CliContext, line: str) -> None:
    """Dispatch one input line. Slash command or chat."""
    line = line.strip()
    if not line:
        return
    if line.startswith("/"):
        rest = line[1:]
        name, args = _split_first(rest)
        handler = COMMANDS.get(name)
        if handler is None:
            print(f"unknown command: /{name}. try /help")
            return
        await handler(ctx, args)
    else:
        await chat(ctx, line)
