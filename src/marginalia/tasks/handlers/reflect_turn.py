"""reflect_turn handler — single responsibility: write one journal row.

Identity: [🔍 investigator]. Reads one finished conversation and asks the
`reflect` LLM profile to produce ≤1 short field note for the journal.

Scope (intentionally narrow as of 2026-05-24):
  - The ONLY write this handler performs is INSERT INTO journal.
  - Per-conversation increments to entry_relations / entry_tags / *_extra
    were removed — those signals are weaker per-conversation than the
    cross-corpus miners (`mine_*`, `enrich_tags`, `refresh_entry_extra`,
    `propose_views`) that already cover the same ground.
  - Cross-session synthesis (the "big summary" tier) lives in
    `summarize_session`, which reads many reflect_turn rows and writes
    `source_kind='insight'` journal rows — see [[journal-tiers]].

Inputs:
  payload = {"conversation_id": "..."}

Flow:
  1. Idempotence: short-circuit on existing task_outcomes row.
  2. Pull the conversation; require it to be ended.
  3. Resolve involved entry_ids from tool_calls payload (read trail).
  4. Call the `reflect` LLM profile with strict JSON schema.
  5. INSERT 0..1 journal rows; record_outcome.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Mapping

from marginalia.db.models import (
    Conversation,
    File,
    Journal,
)
from marginalia.db.session import session_scope
from marginalia.llm import (
    ChatMessage,
    ChatRequest,
    TextBlock,
    get_chat_client,
)
from marginalia.repositories import entries as entries_repo
from marginalia.repositories import entry_tags as entry_tags_repo
from marginalia.repositories.task_outcomes import has_outcome, record_outcome
from marginalia.tasks.kinds import task_handler
from marginalia.utils.ids import new_id

log = logging.getLogger(__name__)

KIND_REFLECT_TURN = "reflect_turn"

ENTRY_LIMIT = 30  # cap how many entries we feed the model context for


REFLECT_SYSTEM = """You are Marginalia's reflection investigator.

You read one finished conversation between the user and the Marginalia
agent, plus current metadata of the file_entries the agent touched, and
write ONE short field note for the agent's journal — the per-turn bullet
in a notebook that a later "session summary" pass will distill.

Write the note for your future self skimming this session: what was the
useful path, which entries paid off, what dead-end is worth remembering?
Tie it to specific entry_ids if the insight is about them. Keep it terse.

If nothing in this conversation is worth remembering, return an empty
journal_entries list — the framework will skip the write.

Output ONLY one JSON object matching the supplied schema. No prose, no
fences.
"""


REFLECT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["journal_entries"],
    "properties": {
        "journal_entries": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["note", "entry_ids", "tags"],
                "properties": {
                    "note": {"type": "string"},
                    "entry_ids": {"type": "array", "items": {"type": "string"}},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    },
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@task_handler(KIND_REFLECT_TURN)
async def handle_reflect_turn(payload: Mapping[str, Any]) -> None:
    conversation_id = payload.get("conversation_id")
    if not conversation_id:
        raise ValueError("reflect_turn payload missing conversation_id")

    async with session_scope() as session:
        already = await has_outcome(
            session,
            task_kind="reflect_turn",
            object_kind="conversation",
            object_id=conversation_id,
        )
        if already:
            log.info("reflect_turn already completed for %s; skipping",
                     conversation_id)
            await session.commit()
            return

        conversation = await session.get(Conversation, conversation_id)
        if conversation is None:
            raise ValueError(f"conversation {conversation_id!r} not found")
        if conversation.ended_at is None:
            raise ValueError(
                f"conversation {conversation_id!r} not yet ended; cannot reflect"
            )

        involved_entry_ids = _collect_involved_entry_ids(conversation)
        entry_metadata = await _fetch_entry_metadata(session, involved_entry_ids)
        await session.commit()

    payload_for_llm = {
        "conversation": {
            "user_message": conversation.user_message,
            "agent_response": conversation.agent_response,
            "tool_calls": conversation.tool_calls or [],
            "llm_calls": conversation.llm_calls or [],
        },
        "involved_entries": entry_metadata,
    }
    user_text = (
        "Below is one finished conversation along with the current "
        "metadata of the file_entries the agent touched. Decide whether "
        "to write one short journal note (or skip).\n\n"
        f"<conversation_and_context>\n"
        f"{json.dumps(payload_for_llm, ensure_ascii=False)}\n"
        "</conversation_and_context>"
    )

    client = get_chat_client("reflect")
    resp = await client.complete(ChatRequest(
        system=REFLECT_SYSTEM,
        messages=[ChatMessage(role="user", content=[TextBlock(text=user_text)])],
        max_tokens=1024,
        json_schema=REFLECT_SCHEMA,
        temperature=0.3,
    ))
    if resp.parsed_json is None:
        raise ValueError("reflect_turn: model did not return parseable JSON")

    data = resp.parsed_json

    async with session_scope() as session:
        await _persist_reflection(
            session, conversation_id=conversation_id, data=data,
        )
        await session.commit()


def _collect_involved_entry_ids(conv: Conversation) -> list[str]:
    """Pull entry_ids out of tool_calls payloads.

    Convention: tool_calls is a JSON array of `{name, arguments, result, ...}`
    where `arguments` and `result` are dicts. Any string value at any depth
    that looks like a uuid7 we accept as a candidate (cheap; the metadata
    fetch will quietly drop unknowns).
    """
    seen: list[str] = []
    seen_set: set[str] = set()
    for call in (conv.tool_calls or []):
        for blob in (call.get("arguments"), call.get("result")):
            for v in _walk_strings(blob):
                if _looks_like_id(v) and v not in seen_set:
                    seen_set.add(v)
                    seen.append(v)
                    if len(seen) >= ENTRY_LIMIT:
                        return seen
    return seen


def _walk_strings(obj: Any):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_strings(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _walk_strings(v)


def _looks_like_id(s: str) -> bool:
    return len(s) == 36 and s.count("-") == 4


async def _fetch_entry_metadata(session, entry_ids: list[str]) -> list[dict[str, Any]]:
    if not entry_ids:
        return []
    rows = await entries_repo.list_by_ids_any(session, entry_ids)
    out: list[dict[str, Any]] = []
    for e in rows:
        file_row = await session.get(File, e.file_id)
        tag_rows = await entry_tags_repo.list_name_facet_for_entry(session, e.id)
        out.append({
            "entry_id": e.id,
            "display_name": e.display_name,
            "lifecycle": e.lifecycle,
            "extra": e.extra,
            "file": {
                "kind": file_row.kind if file_row else None,
                "summary": file_row.summary if file_row else None,
            },
            "tags": [{"name": n, "facet": f} for n, f in tag_rows],
        })
    return out


async def _persist_reflection(
    session,
    *,
    conversation_id: str,
    data: dict[str, Any],
) -> None:
    now = _utcnow()
    journal_count = 0

    for j in data.get("journal_entries") or []:
        note = (j.get("note") or "").strip()
        if not note:
            continue
        session.add(Journal(
            id=new_id(),
            conversation_id=conversation_id,
            note=note,
            entry_ids=list(j.get("entry_ids") or []),
            tags=list(j.get("tags") or []),
            source_kind="reflect_turn",
            created_at=now,
        ))
        journal_count += 1

    await record_outcome(
        session,
        task_kind="reflect_turn",
        object_kind="conversation",
        object_id=conversation_id,
        outcome="applied" if journal_count else "noop",
        detail={"journal_entries": journal_count},
    )
