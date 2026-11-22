"""The tools every agent is born with: running code, managing tools, controlling
background runs, working with other agents, and SQL."""

from __future__ import annotations

from .agents import agent_builtins
from .code import code_builtins
from .discovery import discovery_builtins
from .jobs import job_builtins
from .mail import mail_builtins
from .memory import memory_builtins
from .runs import run_builtins
from .shared import Builtin, BuiltinContext
from .skills import skill_builtins
from .sql import sql_builtins

_cache: dict[str, Builtin] | None = None


def builtins() -> dict[str, Builtin]:
    global _cache
    if _cache is None:
        names: set[str] = set()

        def is_builtin(name: str) -> bool:
            return name in names

        blist = [
            *code_builtins(is_builtin), *run_builtins(is_builtin), *agent_builtins(), *sql_builtins(),
            *mail_builtins(), *job_builtins(), *skill_builtins(), *memory_builtins(), *discovery_builtins(),
        ]
        names.update(b.name for b in blist)
        _cache = {b.name: b for b in blist}
    return _cache


__all__ = ["Builtin", "BuiltinContext", "builtins"]
