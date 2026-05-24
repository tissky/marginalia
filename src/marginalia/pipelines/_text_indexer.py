"""Shared LLM-indexing helper for text-shaped pipelines.

`text.py` was the first pipeline; docx / spreadsheet / log / code all
follow the same pattern: extract plain text, then ask the LLM to
produce the same structured index. This module pulls out the LLM call
so each parser only has to handle its own extraction.

The schema is identical to `text.py`'s but with the `kind` enum widened
to include the caller's kind. Anchors stay heading-or-lines; sheet- and
slide-aware variants can introduce custom anchor units later if needed.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from marginalia.llm import ChatMessage, ChatRequest, TextBlock, get_chat_client
from marginalia.pipelines.base import PipelineContext, PipelineResult, TagSuggestion

log = logging.getLogger(__name__)

INDEXER_SYSTEM = """You are Marginalia's document indexer.

Your job: read a single document and produce a structured index that
lets a downstream agent decide whether to retrieve it, and once
retrieved, jump to the relevant section by anchor.

Rules:
- Output ONLY one JSON object matching the provided schema. No prose,
  no fences.
- `summary`: 2-4 sentences in the document's own language,
  content-focused.
- `description.sections`: array of every meaningful heading or logical
  chunk. For each section: a stable id (s1, s2, …), the heading title,
  an anchor (`unit`: "heading" with `path` like "1.2.3", or "lines"
  with [start,end]), a 1-2 sentence summary, and 3-7 key terms.
- `kind`: matches the document type the user uploaded.
- `extra`: at most 1 paragraph of cross-cutting content insight.
- `entry_extra`: at most 1 paragraph of position-aware insight.
- `entry_catalog_path`: best-guess classification path as a list.
- `entry_tags`: 3-10 tags. Each `{name, facet}`. Facets are exactly:
  topic | form | time | source | language | extra. Reuse names from
  the current vocabulary when they fit.
"""


def make_schema(kind: str) -> dict[str, Any]:
    """Build the indexer schema with `kind` constrained to one value."""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "summary", "description", "kind", "extra",
            "entry_extra", "entry_catalog_path", "entry_tags",
        ],
        "properties": {
            "summary": {"type": "string"},
            "description": {
                "type": "object",
                "additionalProperties": False,
                "required": ["sections"],
                "properties": {
                    "sections": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["id", "title", "anchor", "summary",
                                         "key_terms"],
                            "properties": {
                                "id": {"type": "string"},
                                "title": {"type": "string"},
                                "anchor": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "required": ["unit", "value"],
                                    "properties": {
                                        "unit": {
                                            "type": "string",
                                            "enum": ["heading", "lines"],
                                        },
                                        "value": {"type": "string"},
                                    },
                                },
                                "summary": {"type": "string"},
                                "key_terms": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
            "kind": {"type": "string", "enum": [kind]},
            "extra": {"type": "string"},
            "entry_extra": {"type": "string"},
            "entry_catalog_path": {"type": "array", "items": {"type": "string"}},
            "entry_tags": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["name", "facet"],
                    "properties": {
                        "name": {"type": "string"},
                        "facet": {
                            "type": "string",
                            "enum": ["topic", "form", "time", "source",
                                     "language", "extra"],
                        },
                    },
                },
            },
        },
    }


async def index_extracted_text(
    body: str, ctx: PipelineContext, kind: str
) -> PipelineResult:
    """Run the indexing LLM call and return a PipelineResult."""
    user_payload = {
        "folder_path": ctx.folder_path,
        "sibling_names": ctx.sibling_names,
        "catalog_sketch": ctx.catalog_sketch,
        "tag_vocabulary": ctx.tag_vocabulary,
    }
    user_text = (
        f"Index the {kind} document below. Hints are advisory — the "
        "document's actual content takes precedence.\n\n"
        f"<context>\n{json.dumps(user_payload, ensure_ascii=False)}\n"
        "</context>\n\n"
        f"<document>\n{body}\n</document>"
    )

    client = get_chat_client("ingest")
    max_out = min(4096, max(1024, len(body) // 10))

    resp = await client.complete(ChatRequest(
        system=INDEXER_SYSTEM,
        messages=[ChatMessage(
            role="user", content=[TextBlock(text=user_text)],
        )],
        max_tokens=max_out,
        json_schema=make_schema(kind),
        temperature=0.2,
    ))

    if resp.parsed_json is None:
        log.warning(
            "%s pipeline: model did not return parseable JSON. text=%r",
            kind, (resp.text or "")[:300],
        )
        raise ValueError(f"{kind} pipeline produced non-JSON output")

    data = resp.parsed_json
    return PipelineResult(
        summary=str(data["summary"]),
        description={"sections": data["description"]["sections"]},
        kind=kind,
        extra=(data.get("extra") or "") or None,
        entry_extra=(data.get("entry_extra") or "") or None,
        entry_catalog_path=list(data.get("entry_catalog_path") or []) or None,
        entry_tags=[
            TagSuggestion(name=str(t["name"]), facet=str(t["facet"]))
            for t in (data.get("entry_tags") or [])
        ],
    )
