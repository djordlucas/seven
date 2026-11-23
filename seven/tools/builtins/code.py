"""Running code and managing generated tools."""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from ..bundle import format_report, rebundle, trial_with_libs
from ..store import TOOL_NAME
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
                    "libs": {"type": "array", "items": {"type": "string"},
                             "description": 'Generated libraries to bundle with this tool: "name" (its latest revision) or "name@rev" to pin an exact one. The pins are recorded in the tool and used for every run, so later library changes cannot break this tool. Imports of these names come from the bundle, not pip.'},
                    "test_args": {"type": "object", "description": "Arguments for a trial run before saving. Stored, so rebundle_tool can re-trial later."},
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
        Builtin(
            name="define_library",
            description="Create or replace a generated library: a shared Python module that tools bundle and import by name "
                        "(`import <name>` works inside tool code). Each definition is a new revision; tools keep the revision "
                        "they pinned, so redefining a library never breaks them — use rebundle_tool to adopt a new revision.",
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": f"snake_case, matching {TOOL_NAME.pattern}."},
                    "description": {"type": "string", "description": "What the library provides; shown to every agent."},
                    "code": {"type": "string", "description": "Python module source; its top-level names are the library's API."},
                },
                "required": ["name", "description", "code"],
            },
            run=_define_library,
        ),
        Builtin(
            name="read_library",
            description="Show a library: its definition, current revision and source, plus which tools bundle it (and at which revision).",
            parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            run=_read_library,
        ),
        Builtin(
            name="delete_library",
            description="Delete a library. Refused while any tool bundles it — rebundle those tools without it first, or force.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}, "force": {"type": "boolean"}}, "required": ["name"]},
            run=_delete_library,
        ),
        Builtin(
            name="rebundle_tool",
            description="Re-pin a tool's bundled libraries to their latest revisions (or to the given \"name@rev\" specs) and trial-run "
                        "the tool against the new bundle. The new pins are kept only if the trial succeeds — this is how a tool safely "
                        "adopts a changed library.",
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "The tool to rebundle."},
                    "libs": {"type": "array", "items": {"type": "string"}, "description": 'Optional explicit pins, e.g. ["mathx@3"]. Default: latest revision of each library the tool already bundles.'},
                },
                "required": ["name"],
            },
            run=_rebundle_tool,
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
        lib_specs = a.get("libs") or []
        pins = []
        if lib_specs:
            if ctx.libstore is None:
                return "error: no library store on this agent"
            try:
                pins = ctx.libstore.resolve([str(x) for x in lib_specs])
            except ValueError as e:
                return f"error: {e}"
        try:
            packages = await ctx.runner.install(source, deps, ctx.log, skip={p["name"] for p in pins})
        except Exception as err:
            return f"error: {err}"
        trial = ""
        if a.get("test_args") is not None:
            lmap = ctx.libstore.libs_map(pins) if pins and ctx.libstore else None
            r = await trial_with_libs(ctx, name, source, a["test_args"], timeout_ms, lmap)
            if not r.ok:
                ctx.log.info("tool not saved: trial run failed", tool=name, error=(r.error or "").split("\n")[0])
                return f"not saved: the trial run failed\n{format_run(r)}"
            trial = f"\ntrial run:\n{format_run(r)}"
        meta = ctx.store.save(
            name=name, description=str(a.get("description", "")),
            parameters=a.get("parameters") if isinstance(a.get("parameters"), dict) else {"type": "object"},
            deps=deps, packages=packages, source=source, timeout_ms=timeout_ms,
            libs=pins, test_args=a.get("test_args"),
        )
        bundled = f"\nbundled libs: " + ", ".join(f'{p["name"]}@r{p["revision"]}' for p in pins) if pins else ""
        ctx.log.info("tool saved", tool=name, revision=meta["revision"], packages=[p["name"] for p in packages],
                     libs=[p["name"] for p in pins])
        return f"saved {name} (revision {meta['revision']}){bundled}{trial}"
    return run


async def _trial_run(ctx: BuiltinContext, name: str, source: str, args: object, timeout_ms: int | None,
                     libs: dict[str, str] | None = None):
    return await trial_with_libs(ctx, name, source, args, timeout_ms, libs)


async def _define_library(a: dict, ctx: BuiltinContext) -> str:
    if ctx.libstore is None:
        return "error: no library store on this agent"
    name = str(a.get("name", ""))
    try:
        meta = ctx.libstore.save(name=name, description=str(a.get("description", "")), source=str(a.get("code", "")))
    except ValueError as e:
        return f"error: {e}"
    except SyntaxError as e:
        return f"error: syntax error: {e}"
    ctx.log.info("library saved", lib=name, revision=meta["revision"])
    return f'saved library {name} (revision {meta["revision"]})'


async def _read_library(a: dict, ctx: BuiltinContext) -> str:
    if ctx.libstore is None:
        return "error: no library store on this agent"
    name = str(a.get("name", ""))
    lib = ctx.libstore.get(name)
    if not lib:
        return f'error: no library named "{name}"'
    deps = ctx.libstore.dependents(name) if ctx.libstore.tools else []
    dep_line = ", ".join(f'{d["tool"]} (lib r{d["lib_revision"]})' for d in deps) or "none"
    return f"{json.dumps(lib['meta'], indent=2, default=str)}\nbundled by: {dep_line}\n\n--- source ---\n{lib['source']}"


async def _delete_library(a: dict, ctx: BuiltinContext) -> str:
    if ctx.libstore is None:
        return "error: no library store on this agent"
    from ..store import LibInUseError
    name = str(a.get("name", ""))
    try:
        removed = ctx.libstore.remove(name, force=bool(a.get("force")))
    except LibInUseError as err:
        return f"error: {err}"
    if not removed:
        return f'error: no library named "{name}"'
    ctx.log.info("library deleted", lib=name)
    return f"deleted library {name}"


async def _rebundle_tool(a: dict, ctx: BuiltinContext) -> str:
    name = str(a.get("name", ""))
    specs = [str(x) for x in a["libs"]] if a.get("libs") else None
    try:
        report = await rebundle(ctx, name, specs)
    except ValueError as e:
        return f"error: {e}"
    return format_report(report)


async def _read_tool(a: dict, ctx: BuiltinContext) -> str:
    t = ctx.store.get(str(a.get("name", "")))
    if not t:
        return f'error: no tool named "{a.get("name")}"'
    return f"{json.dumps(t['meta'], indent=2, default=str)}\n\n--- source ---\n{t['source']}"


async def _delete_tool(a: dict, ctx: BuiltinContext) -> str:
    from ..store import ToolInUseError
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
