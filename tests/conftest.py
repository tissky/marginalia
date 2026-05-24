"""pytest hook: e2e modules historically were script-style (run with
`python tests/test_xxx.py`). Their `if __name__ == "__main__":` block
calls `_create_schema()` before driving the test functions. When pytest
collects them instead, that bootstrap never runs and DB-touching tests
fail with `no such table: sessions`.

This autouse module-scoped fixture invokes the module's own
`_create_schema()` if it defines one, so the same files work under both
runners. Modules that don't need a DB (e.g. CLI-only tests) simply omit
the helper and this is a no-op.
"""
from __future__ import annotations

import asyncio

import pytest


@pytest.fixture(autouse=True, scope="module")
def _bootstrap_e2e_schema(request: pytest.FixtureRequest) -> None:
    fn = getattr(request.module, "_create_schema", None)
    if fn is None:
        return
    asyncio.run(fn())
