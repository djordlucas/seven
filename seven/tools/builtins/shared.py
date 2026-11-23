"""What every built-in gets: the calling agent and the shared machinery."""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from ...core.llm import ToolDef
from ...core.log import Logger
from ...core.state import State, now_iso
from ...execution.runner import RunHandle, Runner, RunResult
from ...execution.runs import RunTable
from ..store import LibStore, ToolStore

if TYPE_CHECKING:
    from ...agent.supervisor import Supervisor


@dataclass
class Builtin(ToolDef):
    run: Callable[[dict, BuiltinContext], Awaitable[str]]


@dataclass
class BuiltinContext:
    agent_id: str
    runner: Runner
    store: ToolStore
    runs: RunTable
    supervisor: Supervisor
    state: State
    workspace: str
    state_db: str
    abort: asyncio.Event | None = None
    log: Logger = field(default_factory=Logger)
    libstore: LibStore | None = None


DEPS_SCHEMA = {
    "type": "object",
    "description": 'pip packages and version ranges, e.g. {"requests": ">=2"}. Imports not listed install at latest.',
    "additionalProperties": {"type": "string"},
}


def start_generated(ctx: BuiltinContext, tool: dict, args: object, mode: str, timeout_ms: int | None = None) -> RunHandle:
    meta = tool["meta"]
    log = ctx.log.child(tool=meta["name"], revision=meta["revision"], mode=mode)
    pins = meta.get("libs") or []
    libs = None
    if pins:
        if ctx.libstore is None:
            raise RuntimeError("no library store: cannot resolve pinned libs " + ", ".join(p["name"] for p in pins))
        try:
            libs = ctx.libstore.libs_map(pins)
        except KeyError as e:
            raise RuntimeError(f"pinned library revision missing: {e.args[0]}") from e
    handle = ctx.runner.start_file(tool["file"], args, timeout_ms if timeout_ms is not None else meta.get("timeout_ms"), log, libs=libs)

    def rec(fut: asyncio.Future) -> None:
        r = fut.result()
        if ctx.store.is_open:
            ctx.store.record_run(meta["name"], {
                "at": now_iso(), "revision": meta["revision"], "agent": ctx.agent_id, "mode": mode,
                "ok": r.ok, "duration_ms": r.duration_ms,
                **({} if r.ok else {"error": (r.error or "").split("\n")[0]}),
            })

    handle.done.add_done_callback(rec)
    return handle


async def await_run(handle: RunHandle, abort: asyncio.Event | None = None) -> RunResult:
    if abort is not None and abort.is_set():
        handle.kill()
    done = asyncio.ensure_future(handle.done)
    ab = asyncio.ensure_future(abort.wait()) if abort is not None else None
    try:
        await asyncio.wait({done} | ({ab} if ab else set()), return_when=asyncio.FIRST_COMPLETED)
    finally:
        if ab is not None:
            ab.cancel()
    if abort is not None and abort.is_set():
        handle.kill()
    return await handle.done


def disabled_error(tool: dict) -> str:
    d = tool["meta"].get("disabled") or {}
    return f'error: tool "{tool["meta"]["name"]}" is disabled ({d.get("reason")}). Fix it with define_tool, or enable_tool to use it as is.'


def format_run(r: RunResult) -> str:
    parts = []
    if r.ok:
        parts.append(r.value if isinstance(r.value, str) else json.dumps(r.value, indent=2, default=str))
    else:
        parts.append(f"error: {r.error}")
    if r.logs:
        parts.append("--- output ---\n" + "\n".join(r.logs))
    return "\n".join(parts)


def positive(v: object, fallback: int) -> int:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0 else fallback


def as_deps(v: object) -> dict[str, str] | None:
    if not isinstance(v, dict):
        return None
    return {str(k): str(x) for k, x in v.items()}


def secs(ms: float) -> str:
    return f"{ms / 1000:.1f}s"


async def sleep(ms: float, abort: asyncio.Event | None = None) -> None:
    try:
        if abort is None:
            await asyncio.sleep(ms / 1000)
        else:
            await asyncio.wait_for(abort.wait(), timeout=ms / 1000)
    except TimeoutError:
        return
