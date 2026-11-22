"""Async tool calls: starting a tool in the background and controlling the run."""

from __future__ import annotations

import asyncio

from ..runs import describe, summarize
from .shared import (
    Builtin,
    BuiltinContext,
    as_deps,
    disabled_error,
    positive,
    sleep,
    start_generated,
)

MAX_WAIT_MS = 300_000


def run_builtins(is_builtin) -> list:
    return [
        Builtin(
            name="start_tool",
            description="Start a tool in the background and return a run id at once, instead of waiting for its result. "
                        "Works for any generated tool and for run_python. Use it for anything slow, long-running or that might "
                        "hang; then check it with run_status or wait_run, and stop it with kill_run.",
            parameters={
                "type": "object",
                "properties": {
                    "tool": {"type": "string", "description": "A generated tool, or run_python."},
                    "args": {"type": "object", "description": "The tool's arguments (for run_python: code, args, deps)."},
                    "timeout_ms": {"type": "integer", "description": "Kill the run after this long. Defaults to the tool's own limit, or the normal run limit."},
                },
                "required": ["tool"],
            },
            run=_start_tool(is_builtin),
        ),
        Builtin(
            name="run_status",
            description="Show a background run: whether it is still going, its result once finished, and its latest output.",
            parameters={"type": "object", "properties": {"id": {"type": "string", "description": "The run id from start_tool, e.g. r3."}, "tail": {"type": "integer", "description": "Output lines to show, from the end. Default 50."}}, "required": ["id"]},
            run=_run_status,
        ),
        Builtin(
            name="wait_run",
            description="Wait for a background run to finish, up to timeout_ms, then show its status as run_status does. Waiting does not stop the run.",
            parameters={"type": "object", "properties": {"id": {"type": "string"}, "timeout_ms": {"type": "integer", "description": f"How long to wait. Default 30000, at most {MAX_WAIT_MS}."}, "tail": {"type": "integer", "description": "Output lines to show, from the end. Default 50."}}, "required": ["id"]},
            run=_wait_run,
        ),
        Builtin(
            name="kill_run",
            description="Stop a background run and everything it started.",
            parameters={"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
            run=_kill_run,
        ),
        Builtin(
            name="list_runs",
            description="List your background runs: running ones and recently finished ones.",
            parameters={"type": "object", "properties": {}},
            run=_list_runs,
        ),
    ]


def _start_tool(is_builtin):
    async def run(a: dict, ctx: BuiltinContext) -> str:
        tool = str(a.get("tool", ""))
        args = a.get("args") if isinstance(a.get("args"), dict) else {}
        timeout_ms = positive(a.get("timeout_ms"), 0) or None
        if tool == "run_python":
            handle = ctx.runner.start_eval(str(args.get("code", "")), args=args.get("args"), deps=as_deps(args.get("deps")), timeout_ms=timeout_ms)
        else:
            own = ctx.store.get(tool)
            if not own:
                suffix = " that can run in the background" if is_builtin(tool) else ""
                return f'error: no tool named "{tool}"{suffix}'
            if own["meta"].get("disabled"):
                return disabled_error(own)
            handle = start_generated(ctx, own, args, "async", timeout_ms)
        return f"started {ctx.runs.add(ctx.agent_id, tool, handle)} ({tool})"
    return run


async def _run_status(a: dict, ctx: BuiltinContext) -> str:
    return describe(ctx.runs, str(a.get("id", "")), positive(a.get("tail"), 50)) or f'error: no run "{a.get("id")}"'


async def _wait_run(a: dict, ctx: BuiltinContext) -> str:
    rid = str(a.get("id", ""))
    if not ctx.runs.get(rid):
        return f'error: no run "{rid}"'
    wait = min(positive(a.get("timeout_ms"), 30_000), MAX_WAIT_MS)
    abort = asyncio.Event()
    race = [asyncio.ensure_future(ctx.runs.settled(rid)), asyncio.ensure_future(sleep(wait, abort))]
    if ctx.abort is not None:
        race.append(asyncio.ensure_future(ctx.abort.wait()))
    await asyncio.wait(race, return_when=asyncio.FIRST_COMPLETED)
    abort.set()
    for t in race:
        t.cancel()
    return describe(ctx.runs, rid, positive(a.get("tail"), 50))


async def _kill_run(a: dict, ctx: BuiltinContext) -> str:
    rid = str(a.get("id", ""))
    run = ctx.runs.get(rid)
    if not run:
        return f'error: no run "{rid}"'
    live = ctx.runs.handle(rid)
    if not live:
        return f"{rid} is not running\n{describe(ctx.runs, rid, 20)}"
    live.kill()
    await ctx.runs.settled(rid)
    return f"killed {rid}\n{describe(ctx.runs, rid, 20)}"


async def _list_runs(a: dict, ctx: BuiltinContext) -> str:
    all_runs = ctx.runs.list(ctx.agent_id)
    if not all_runs:
        return "no background runs"
    return "\n".join(summarize(r, ctx.runs.handle(r["id"])) for r in all_runs)
