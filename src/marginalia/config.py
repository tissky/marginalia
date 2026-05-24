from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


LlmProvider = Literal["openai", "anthropic"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_env: str = "dev"

    # Single root for all on-disk state (db, library, caches). Default
    # is ~/Marginalia. Per-component overrides below take precedence
    # when set; otherwise everything sits under marginalia_home/.
    marginalia_home: str = ""  # resolved to ~/Marginalia at runtime

    db_backend: Literal["sqlite", "postgres"] = "sqlite"
    sqlite_path: str = ""  # default: <home>/marginalia.db
    postgres_dsn: str = "postgresql+asyncpg://marginalia:marginalia@localhost:5432/marginalia"

    # mirror = folder-tree on disk matching the user's intent; default.
    # local  = UUID-flat object pool; faster, dedup-on, less human-friendly.
    # s3     = remote object storage for multi-host deployments.
    storage_backend: Literal["mirror", "local", "s3"] = "mirror"
    # Used only by local backend. Default: <home>/objects/.
    local_storage_root: str = ""
    # Used only by mirror backend. Default: <home>/library/.
    mirror_vault_root: str = ""
    s3_endpoint_url: str | None = None
    s3_bucket: str = "marginalia"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"

    worker_enabled: bool = True
    worker_poll_interval_seconds: float = 2.0
    worker_batch_size: int = 4
    worker_lease_seconds: int = 60
    worker_heartbeat_seconds: int = 20

    # Default policy when an upload / rename / move would collide with an
    # existing display_name in the same folder. `rename` suffixes ` (1)`,
    # `error` raises 409, `skip` returns the existing entry. Per-call
    # overrides on `/v1/upload` and the file-entry endpoints win when set.
    default_on_conflict: Literal["rename", "error", "skip"] = "rename"

    # --- LLM defaults (used when a profile leaves a field blank) ------------
    llm_default_provider: LlmProvider = "openai"
    llm_default_api_key: str | None = None
    llm_default_base_url: str | None = None
    llm_default_model: str = "gpt-4o-mini"

    # --- Per-profile overrides (chat / reflect / ingest / vision / audio) ---
    # Any field left blank inherits the corresponding `llm_default_*` value.
    # `audio` is text-transcription only (Whisper et al.) — provider must be
    # OpenAI-compatible since Anthropic has no transcription API.
    llm_chat_provider: LlmProvider | None = None
    llm_chat_api_key: str | None = None
    llm_chat_base_url: str | None = None
    llm_chat_model: str | None = None

    llm_reflect_provider: LlmProvider | None = None
    llm_reflect_api_key: str | None = None
    llm_reflect_base_url: str | None = None
    llm_reflect_model: str | None = None

    llm_ingest_provider: LlmProvider | None = None
    llm_ingest_api_key: str | None = None
    llm_ingest_base_url: str | None = None
    llm_ingest_model: str | None = None

    llm_vision_provider: LlmProvider | None = None
    llm_vision_api_key: str | None = None
    llm_vision_base_url: str | None = None
    llm_vision_model: str | None = None

    llm_audio_provider: LlmProvider | None = None  # only "openai" makes sense
    llm_audio_api_key: str | None = None
    llm_audio_base_url: str | None = None
    llm_audio_model: str | None = None

    @property
    def database_url(self) -> str:
        if self.db_backend == "sqlite":
            return f"sqlite+aiosqlite:///{self.sqlite_path}"
        return self.postgres_dsn


@dataclass(slots=True, frozen=True)
class LlmProfile:
    name: str
    provider: LlmProvider
    api_key: str | None
    base_url: str | None
    model: str


LLM_PROFILES: tuple[str, ...] = ("chat", "reflect", "ingest", "vision", "audio")
# Profiles users actually rely on out of the box. `audio` is opt-in (only used
# when a media pipeline calls transcription) so we don't require it.
_REQUIRED_PROFILES: tuple[str, ...] = ("chat", "reflect", "ingest", "vision")


def _profile_field(settings: Settings, profile: str, field: str) -> object:
    """Read a per-profile override, falling back to the matching default."""
    override = getattr(settings, f"llm_{profile}_{field}")
    return override if override is not None else getattr(settings, f"llm_default_{field}")


def resolve_profile(settings: Settings, profile: str) -> LlmProfile:
    """Resolve `profile` (one of LLM_PROFILES) against `LLM_<PROFILE>_*`
    overrides, falling back to `LLM_DEFAULT_*` per-field."""
    if profile not in LLM_PROFILES:
        raise ValueError(f"unknown LLM profile: {profile!r}")
    return LlmProfile(
        name=profile,
        provider=_profile_field(settings, profile, "provider"),  # type: ignore[arg-type]
        api_key=_profile_field(settings, profile, "api_key"),  # type: ignore[arg-type]
        base_url=_profile_field(settings, profile, "base_url"),  # type: ignore[arg-type]
        model=_profile_field(settings, profile, "model"),  # type: ignore[arg-type]
    )


class LlmConfigError(RuntimeError):
    """Startup-time LLM configuration is incomplete or inconsistent."""


def validate_llm_config(settings: Settings) -> None:
    """Fail fast at startup if required LLM credentials are missing.

    Without this, a freshly-installed Marginalia accepts `/upload` and `/chat`
    requests but every task quietly errors when it first tries to call the
    provider — the failure shows up in `task_outcomes`, not in the foreground.

    Rule: each required profile must resolve to a non-empty api_key. A profile
    can satisfy this either via its own `LLM_<PROFILE>_API_KEY` or by inheriting
    `LLM_DEFAULT_API_KEY`.
    """
    missing = [p for p in _REQUIRED_PROFILES if not _profile_field(settings, p, "api_key")]
    if missing:
        raise LlmConfigError(
            "LLM api_key is not configured for required profile(s): "
            f"{', '.join(missing)}. Set LLM_DEFAULT_API_KEY in .env, or set "
            "the per-profile override LLM_<PROFILE>_API_KEY for each."
        )


def _default_home() -> str:
    """`~/Marginalia` cross-platform. Used when MARGINALIA_HOME is unset."""
    from pathlib import Path
    return str(Path.home() / "Marginalia")


def _resolve_paths(settings: "Settings") -> None:
    """In-place: fill blank path fields from marginalia_home so the
    user only needs to set MARGINALIA_HOME (or nothing) to relocate the
    whole on-disk footprint."""
    from pathlib import Path
    home = settings.marginalia_home or _default_home()
    home_path = Path(home).expanduser()
    settings.marginalia_home = str(home_path)
    if not settings.sqlite_path:
        settings.sqlite_path = str(home_path / "marginalia.db")
    if not settings.local_storage_root:
        settings.local_storage_root = str(home_path / "objects")
    if not settings.mirror_vault_root:
        settings.mirror_vault_root = str(home_path / "library")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    s = Settings()
    _resolve_paths(s)
    return s
