from __future__ import annotations

import os
import sys

from marginalia import server_main


def test_server_main_uses_sys_argv_when_argv_is_omitted() -> None:
    from marginalia.config import get_settings

    get_settings.cache_clear()
    captured: dict[str, object] = {}
    runtime_env: dict[str, str | None] = {}

    def _fake_run(app: str, **kwargs) -> None:
        captured["app"] = app
        captured.update(kwargs)

    real_argv = sys.argv[:]
    real_run = server_main.uvicorn.run
    old_env = {
        key: os.environ.get(key)
        for key in ("MARGINALIA_API_HOST", "MARGINALIA_API_PORT", "MARGINALIA_HTTP_SERVER")
    }
    try:
        server_main.uvicorn.run = _fake_run  # type: ignore[assignment]
        sys.argv = [
            "python -m marginalia",
            "--host",
            "0.0.0.0",
            "--port",
            "8765",
            "--log-level",
            "warning",
        ]

        rc = server_main.main(prog="python -m marginalia")
        for key in ("MARGINALIA_API_HOST", "MARGINALIA_API_PORT", "MARGINALIA_HTTP_SERVER"):
            runtime_env[key] = os.environ.get(key)
    finally:
        server_main.uvicorn.run = real_run  # type: ignore[assignment]
        sys.argv = real_argv
        get_settings.cache_clear()
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    assert rc == 0
    assert captured["app"] == "marginalia.main:app"
    assert captured["host"] == "0.0.0.0"
    assert captured["port"] == 8765
    assert captured["log_level"] == "warning"
    assert runtime_env["MARGINALIA_API_HOST"] == "0.0.0.0"
    assert runtime_env["MARGINALIA_API_PORT"] == "8765"
    assert runtime_env["MARGINALIA_HTTP_SERVER"] == "1"


def test_server_main_reads_home_env_when_cwd_has_no_env(tmp_path, monkeypatch) -> None:
    from marginalia.config import get_settings

    home = tmp_path / "home"
    work = tmp_path / "work"
    home.mkdir()
    work.mkdir()
    (home / ".env").write_text(
        "MARGINALIA_API_HOST=127.0.0.1\n"
        "MARGINALIA_API_PORT=8766\n"
        "LLM_DEFAULT_API_KEY=sk-fake\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(work)
    monkeypatch.setenv("MARGINALIA_HOME", str(home))
    monkeypatch.delenv("MARGINALIA_API_HOST", raising=False)
    monkeypatch.delenv("MARGINALIA_API_PORT", raising=False)
    monkeypatch.delenv("MARGINALIA_HTTP_SERVER", raising=False)
    get_settings.cache_clear()

    captured: dict[str, object] = {}

    def _fake_run(app: str, **kwargs) -> None:
        captured["app"] = app
        captured.update(kwargs)

    real_run = server_main.uvicorn.run
    try:
        server_main.uvicorn.run = _fake_run  # type: ignore[assignment]

        rc = server_main.main([])
    finally:
        server_main.uvicorn.run = real_run  # type: ignore[assignment]
        get_settings.cache_clear()

    assert rc == 0
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8766
