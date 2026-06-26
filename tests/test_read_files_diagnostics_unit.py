from __future__ import annotations

from marginalia.agent.tools.read_files import (
    _error_diagnostic,
    _locator_diagnostic,
    _segment_diagnostic,
)


def test_read_files_locator_diagnostic_does_not_log_content_values() -> None:
    diagnostic = _locator_diagnostic({
        "heading": "Confidential Customer Roadmap",
        "pattern": "secret-token-123",
        "member_path": "customers/acme/contracts/q4.pdf",
        "offset": 120,
        "max_chars": 800,
        "patterns": ["alpha", "beta"],
    })

    assert diagnostic == {
        "offset": 120,
        "max_chars": 800,
        "has_heading": True,
        "has_pattern": True,
        "has_member_path": True,
        "patterns_count": 2,
    }
    assert "Confidential Customer Roadmap" not in repr(diagnostic)
    assert "secret-token-123" not in repr(diagnostic)
    assert "customers/acme" not in repr(diagnostic)


def test_read_files_segment_diagnostic_counts_available_values() -> None:
    diagnostic = _segment_diagnostic({
        "available": ["customers/acme/contracts/q4.pdf"],
        "available_sheets": ["Payroll"],
        "hits": [{"context": "private context"}],
        "offset": 0,
        "total_matches": 3,
    })

    assert diagnostic == {
        "offset": 0,
        "total_matches": 3,
        "available_sheets_count": 1,
        "available_members_count": 1,
    }
    assert "customers/acme" not in repr(diagnostic)
    assert "Payroll" not in repr(diagnostic)
    assert "private context" not in repr(diagnostic)


def test_read_files_error_diagnostic_returns_category_not_raw_error() -> None:
    assert (
        _error_diagnostic("member not found: 'customers/acme/contracts/q4.pdf'")
        == "not found"
    )
    assert _error_diagnostic("unexpected private failure") == "error"
