"""Pure parsing helpers for agent citation footnotes.

The model is prompted to emit a tight contract, but live answers can still
include extra `key=value` fields. The parser therefore treats `entry_id` as
the anchor field, extracts the fields the app understands, and ignores
unknown parameters so raw citation metadata does not leak into renderers.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


CITATION_FOOTNOTE_RE = re.compile(
    r"^\[\^([^\]\n]+)\]:\s*entry_id\s*=\s*`?"
    r"([0-9a-fA-F][0-9a-fA-F\-]{6,35})`?"
    r"(?P<rest>[^\n]*)$",
    re.MULTILINE,
)

_FIELD_RE = re.compile(
    r"(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"
    r"("
    r"`[^`]*`"
    r"|\"(?:[^\"\\]|\\.)*\""
    r"|'(?:[^'\\]|\\.)*'"
    r"|[^,，\n]+"
    r")",
    re.IGNORECASE,
)
_PAGE_RE = re.compile(r"^\s*`?\s*([0-9]+(?:-[0-9]+)?)")


@dataclass(frozen=True, slots=True)
class CitationFootnote:
    marker: str
    entry_id: str
    quote: str | None = None
    page: str | None = None
    section_id: str | None = None
    reason: str | None = None
    start: int = 0
    end: int = 0


def iter_citation_footnotes(text: str) -> list[CitationFootnote]:
    """Parse all raw `entry_id=...` citation footnotes in `text`."""
    return [
        parse_citation_footnote_match(match)
        for match in CITATION_FOOTNOTE_RE.finditer(text)
    ]


def parse_citation_footnote_match(match: re.Match[str]) -> CitationFootnote:
    """Parse one `CITATION_FOOTNOTE_RE` match into structured fields."""
    rest, trailer_reason = _split_reason_trailer(match.group("rest") or "")
    fields = _parse_fields(rest)
    page = _extract_page(fields.get("page"))
    reason = _clean_value(trailer_reason or fields.get("reason") or "")
    return CitationFootnote(
        marker=match.group(1),
        entry_id=match.group(2).strip(),
        quote=_none_if_empty(fields.get("quote")),
        page=page,
        section_id=_none_if_empty(fields.get("section_id")),
        reason=_none_if_empty(reason),
        start=match.start(),
        end=match.end(),
    )


def unescape_citation_quote(value: str) -> str:
    return value.replace(r"\"", '"').replace(r"\\", "\\")


def _parse_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for match in _FIELD_RE.finditer(text):
        key = match.group(1).lower()
        if key in fields:
            continue
        fields[key] = _clean_value(match.group(2))
    return fields


def _clean_value(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and text[0] == "`" and text[-1] == "`":
        text = text[1:-1].strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1]
    return text.strip()


def _none_if_empty(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def _extract_page(value: str | None) -> str | None:
    if not value:
        return None
    match = _PAGE_RE.match(value)
    return match.group(1) if match else None


def _split_reason_trailer(rest: str) -> tuple[str, str | None]:
    """Split `, page=3 - reason` while ignoring dashes inside values."""
    quote: str | None = None
    escaped = False
    in_backticks = False
    for idx, char in enumerate(rest):
        if escaped:
            escaped = False
            continue
        if quote:
            if char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char == "`":
            in_backticks = not in_backticks
            continue
        if in_backticks:
            continue
        if char in ("'", '"'):
            quote = char
            continue
        if char not in "-—–":
            continue
        before = rest[idx - 1] if idx > 0 else ""
        after = rest[idx + 1] if idx + 1 < len(rest) else ""
        if before and not before.isspace():
            continue
        if after and not after.isspace():
            continue
        reason = rest[idx + 1:].strip()
        return rest[:idx], _clean_value(reason) if reason else None
    return rest, None
