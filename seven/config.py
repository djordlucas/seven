"""Configuration from the environment only."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_ENDPOINT = "https://api.mistral.ai/v1"

LEVELS = ("debug", "info", "warn", "error")


def parse_level(v: str | None, fallback: str) -> str:
    return v.lower() if v and v.lower() in LEVELS else fallback


def _int(v: str | None, fallback: int) -> int:
    if v is None:
        return fallback
    try:
        n = int(v)
    except ValueError:
        return fallback
    return n if n > 0 else fallback


@dataclass
class Config:
    api_key: str
    model: str
    endpoint: str
    workspace: Path
    max_steps: int
    context_tokens: int
    run_timeout_ms: int
    run_memory_mb: int
    max_agents: int
    llm_concurrency: int
    log_level: str
    log_file: Path | None
    log_stderr: bool | None
    extra: dict = field(default_factory=dict)

    @property
    def home(self) -> Path:
        return self.workspace / ".seven"

    @property
    def state_db(self) -> Path:
        return self.home / "seven.db"

    @property
    def tools_dir(self) -> Path:
        return self.home / "tools"

    @property
    def tmp_dir(self) -> Path:
        return self.home / "tmp"

    @property
    def site_packages(self) -> Path:
        return self.home / "site-packages"

    def public(self) -> dict:
        return {
            "model": self.model,
            "endpoint": self.endpoint,
            "workspace": str(self.workspace),
            "home": str(self.home),
            "max_steps": self.max_steps,
            "context_tokens": self.context_tokens,
            "run_timeout_ms": self.run_timeout_ms,
            "run_memory_mb": self.run_memory_mb,
            "max_agents": self.max_agents,
            "llm_concurrency": self.llm_concurrency,
            "log_level": self.log_level,
            "log_file": str(self.log_file) if self.log_file else None,
            "log_stderr": self.log_stderr,
            "api_key_set": bool(self.api_key),
        }


def _load_dotenv(path: Path, env: dict) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in env:
            env[key] = value


def load_config(env: dict | None = None) -> Config:
    env = dict(os.environ) if env is None else dict(env)
    _load_dotenv(Path.cwd() / ".env", env)
    workspace = Path(env.get("SEVEN_WORKSPACE") or os.getcwd()).resolve()
    log_file_env = env.get("SEVEN_LOG_FILE")
    log_file = None if log_file_env == "off" else (workspace / (log_file_env or ".seven/logs/seven.log")).resolve()
    stderr_env = env.get("SEVEN_LOG_STDERR")
    return Config(
        api_key=env.get("SEVEN_LLM_API_KEY") or env.get("MISTRAL_API_KEY") or "",
        model=env.get("SEVEN_LLM_MODEL") or "mistral-medium-latest",
        endpoint=env.get("SEVEN_LLM_ENDPOINT") or DEFAULT_ENDPOINT,
        workspace=workspace,
        max_steps=_int(env.get("SEVEN_MAX_STEPS"), 40),
        context_tokens=_int(env.get("SEVEN_CONTEXT_TOKENS"), 128_000),
        run_timeout_ms=_int(env.get("SEVEN_RUN_TIMEOUT_MS"), 60_000),
        run_memory_mb=_int(env.get("SEVEN_RUN_MEMORY_MB"), 1024),
        max_agents=_int(env.get("SEVEN_MAX_AGENTS"), 16),
        llm_concurrency=_int(env.get("SEVEN_LLM_CONCURRENCY"), 4),
        log_level=parse_level(env.get("SEVEN_LOG_LEVEL"), "info"),
        log_file=log_file,
        log_stderr=None if stderr_env is None else stderr_env == "1",
    )
