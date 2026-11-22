"""Running code and managing generated tools."""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from ..tools import TOOL_NAME
from .shared import (
    DEPS_SCHEMA,
    Builtin,
    BuiltinContext,
    as_deps,
    await_run,
    format_run,
    positive,
    secs,
)


def code_builtins(is_builtin) -> list:
    return [
        Builtin(
            name="run_python",
            description="Run Python once, in a fresh Python process, and return its result and output. "
                        "The module's `default` export (a value, or a function called with `args`) is the result.",
            parameters={
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python module source."},
                    "args": {"type": "object", "description": "Passed to `default` when it is a function."},
                    "deps": DEPS_SCHEMA,
                },
                "required": ["code"],
            },
            run=_run_python,
        ),
        Builtin(
            name="define_tool",
            description="Create or replace a tool. It becomes callable by `name` from your next step — by you and by every "
                        "other agent — and persists across sessions. The source's `default` export is `def default(args)` "
                        "(async works too). When test_args is given the tool is run once first, and it is only saved if that run succeeds.",
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": f"snake_case, matching {TOOL_NAME.pattern}."},
                    "description": {"type": "string", "description": "What the tool does and returns; this is all a future caller sees."},
                    "parameters": {"type": "object", "description": "JSON Schema for the arguments object."},
                    "code": {"type": "string", "description": "Python module source."},
                    "deps": DEPS_SCHEMA,
                    "test_args": {"type": "object", "description": "Arguments for a trial run before saving."},
                    "timeout_ms": {"type": "integer", "description": "Run limit for this tool, for one that is meant to be slow. Defaults to the normal run limit."},
                },
                "required": ["name", "description", "parameters", "code"],
            },
            run=_define_tool(is_builtin),
        ),
        Builtin(
            name="read_tool",
            description="Show a tool: its definition and source. Use it before revising a tool.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            run=_read_tool,
        ),
        Builtin(
            name="delete_tool",
            description="Delete a tool, for every agent.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            run=_delete_tool,
        ),
        Builtin(
            name="tool_health",
            description="Show how a tool has been behaving: whether it is disabled, its run limit, and its recent runs with "
                        "their caller, outcome, duration and errors. Use it to decide whether to fix, disable or delete a tool.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}, "last": {"type": "integer", "description": "Runs to show, newest first. Default 10."}}, "required": ["name"]},
            run=_tool_health,
        ),
        Builtin(
            name="disable_tool",
            description="Disable a tool that misbehaves: it disappears from every agent's tool list and calls to it are refused, "
                        "but it is kept. Redefining it with define_tool, or enable_tool, brings it back.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}, "reason": {"type": "string", "description": "What is wrong with it; shown to every agent while it is disabled."}}, "required": ["name", "reason"]},
            run=_disable_tool,
        ),
        Builtin(
            name="enable_tool",
            description="Re-enable a disabled tool as it is.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            run=_enable_tool,
        ),
    ]


async def _run_python(a: dict, ctx: BuiltinContext) -> str:
    handle = ctx.runner.start_eval(str(a.get("code", "")), args=a.get("args"), deps=as_deps(a.get("deps")), log=ctx.log)
    return format_run(await await_run(handle, ctx.abort))


def _define_tool(is_builtin):
    async def run(a: dict, ctx: BuiltinContext) -> str:
        name = str(a.get("name", ""))
        if not TOOL_NAME.match(name):
            return f"error: name must match {TOOL_NAME.pattern}"
        if is_builtin(name):
            return f'error: "{name}" is a built-in tool and cannot be replaced'
        source = str(a.get("code", ""))
        deps = as_deps(a.get("deps")) or {}
        timeout_ms = positive(a.get("timeout_ms"), 0) or None
        try:
            packages = await ctx.runner.install(source, deps, ctx.log)
        except Exception as err:
            return f"error: {err}"
        trial = ""
        if a.get("test_args") is not None:
            r = await _trial_run(ctx, name, source, a["test_args"], timeout_ms)
            if not r.ok:
                ctx.log.info("tool not saved: trial run failed", tool=name, error=(r.error or "").split("\n")[0])
                return f"not saved: the trial run failed\n{format_run(r)}"
            trial = f"\ntrial run:\n{format_run(r)}"
        meta = ctx.store.save(
            name=name, description=str(a.get("description", "")),
            parameters=a.get("parameters") if isinstance(a.get("parameters"), dict) else {"type": "object"},
            deps=deps, packages=packages, source=source, timeout_ms=timeout_ms,
        )
        ctx.log.info("tool saved", tool=name, revision=meta["revision"], packages=[p["name"] for p in packages])
        return f"saved {name} (revision {meta['revision']}){trial}"
    return run


async def _trial_run(ctx: BuiltinContext, name: str, source: str, args: object, timeout_ms: int | None):
    dir_ = Path(tempfile.mkdtemp(prefix=f"trial-{name}-", dir=ctx.runner.tmp))
    file = dir_ / "source.py"
    file.write_text(source, encoding="utf-8")
    try:
        return await ctx.runner.run_file(file, args, timeout_ms, ctx.log.child(tool=name, mode="trial"))
    finally:
        shutil.rmtree(dir_, ignore_errors=True)


async def _read_tool(a: dict, ctx: BuiltinContext) -> str:
    t = ctx.store.get(str(a.get("name", "")))
    if not t:
        return f'error: no tool named "{a.get("name")}"'
    return f"{json.dumps(t['meta'], indent=2, default=str)}\n\n--- source ---\n{t['source']}"


async def _delete_tool(a: dict, ctx: BuiltinContext) -> str:
    from ..tools import ToolInUseError
    name = str(a.get("name", ""))
    try:
        removed = ctx.store.remove(name)
    except ToolInUseError as err:
        return f"error: {err}"
    if not removed:
        return f'error: no tool named "{name}"'
    ctx.log.info("tool deleted", tool=name)
    return f"deleted {name}"


async def _tool_health(a: dict, ctx: BuiltinContext) -> str:
    t = ctx.store.get(str(a.get("name", "")))
    if not t:
        return f'error: no tool named "{a.get("name")}"'
    return _health(t, ctx.store, positive(a.get("last"), 10))


async def _disable_tool(a: dict, ctx: BuiltinContext) -> str:
    name = str(a.get("name", ""))
    if not ctx.store.set_disabled(name, str(a.get("reason", ""))):
        return f'error: no tool named "{name}"'
    ctx.log.warning("tool disabled", tool=name, reason=str(a.get("reason", "")))
    return f"disabled {name}"


async def _enable_tool(a: dict, ctx: BuiltinContext) -> str:
    name = str(a.get("name", ""))
    if not ctx.store.set_disabled(name, None):
        return f'error: no tool named "{name}"'
    ctx.log.info("tool enabled", tool=name)
    return f"enabled {name}"


def _health(tool: dict, store, last: int) -> str:
    meta = tool["meta"]
    runs = store.history(meta["name"])
    state = f"disabled since {meta['disabled']['at']}: {meta['disabled']['reason']}" if meta.get("disabled") else "enabled"
    lines = [f"{meta['name']} (revision {meta['revision']}): {state}",
             f"run limit: {meta['timeout_ms']}ms" if meta.get("timeout_ms") else "run limit: default"]
    if not runs:
        return "\n".join(lines + ["no runs recorded"])
    ok = sum(1 for r in runs if r["ok"])
    durations = sorted(r["duration_ms"] for r in runs)
    median = durations[len(durations) // 2]
    lines.append(f"last {len(runs)} runs: {ok} ok, {len(runs) - ok} failed; median {secs(median)}, slowest {secs(durations[-1])}")
    lines.append("recent runs, newest first:")
    lines.extend(f"- {r['at']} r{r['revision']} {r['agent']} {r['mode']} {secs(r['duration_ms'])} " + ("ok" if r["ok"] else f"failed: {r.get('error')}")
                 for r in reversed(runs[-last:]))
    return "\n".join(lines)
