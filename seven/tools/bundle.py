"""Bundling generated libraries into tools.

A tool's `libs` manifest pins the exact library revisions it was defined and
trial-tested against. Runs load those revision files through the child's
import hook, so redefining a library never changes what an existing tool
imports. `rebundle` is the safe way to adopt a newer library revision: it
re-resolves the pins, trial-runs the tool against the new bundle, and only
then updates the manifest.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .builtins.shared import BuiltinContext


async def trial_with_libs(ctx: BuiltinContext, name: str, source: str, args: object,
                          timeout_ms: int | None, libs: dict[str, str] | None):
    dir_ = Path(tempfile.mkdtemp(prefix=f"trial-{name}-", dir=ctx.runner.tmp))
    file = dir_ / "source.py"
    file.write_text(source, encoding="utf-8")
    try:
        return await ctx.runner.run_file(file, args, timeout_ms, ctx.log.child(tool=name, mode="trial"), libs=libs)
    finally:
        shutil.rmtree(dir_, ignore_errors=True)


async def rebundle(ctx: BuiltinContext, tool_name: str, specs: list[str] | None = None) -> dict:
    """Re-pin a tool's bundled libraries (default: latest revision of each current
    pin). When the tool was defined with test_args, it is trial-run against the
    new bundle first; the manifest is updated only if the trial passes."""
    t = ctx.store.get(tool_name)
    if not t:
        raise ValueError(f'no tool named "{tool_name}"')
    meta = t["meta"]
    current = meta.get("libs") or []
    new_pins = ctx.libstore.resolve(specs if specs is not None else [p["name"] for p in current])
    report = {"tool": tool_name, "from": current, "to": new_pins,
              "changed": new_pins != current, "trial": None, "updated": False}
    if not report["changed"]:
        return report
    libs = ctx.libstore.libs_map(new_pins)
    if meta.get("test_args") is not None:
        r = await trial_with_libs(ctx, tool_name, t["source"], meta["test_args"], meta.get("timeout_ms"), libs)
        report["trial"] = {"ok": r.ok, "error": r.error, "duration_ms": r.duration_ms, "logs": r.logs[-5:]}
        if not r.ok:
            ctx.log.warning("rebundle refused: trial failed", tool=tool_name, error=(r.error or "").split("\n")[0])
            return report
    ctx.store.set_libs(tool_name, new_pins)
    report["updated"] = True
    ctx.log.info("tool rebundled", tool=tool_name, libs=[f'{p["name"]}@r{p["revision"]}' for p in new_pins])
    return report


def format_report(report: dict) -> str:
    pins = lambda ps: ", ".join(f'{p["name"]}@r{p["revision"]}' for p in ps) or "none"
    lines = [f'{report["tool"]}: libs {pins(report["from"])} -> {pins(report["to"])}']
    if not report["changed"]:
        lines.append("already up to date")
    elif report["updated"]:
        lines.append("rebundled" + (f'\ntrial run:\n{format_run_type(report["trial"])}' if report["trial"] else ""))
    else:
        lines.append("NOT updated: the trial run against the new bundle failed")
        if report["trial"]:
            lines.append(f'trial error: {(report["trial"].get("error") or "").splitlines()[0] if report["trial"].get("error") else "?"}')
    return "\n".join(lines)


def format_run_type(trial: dict | None) -> str:
    if not trial:
        return ""
    from ..execution.runner import RunResult
    from .builtins.shared import format_run
    r = RunResult(ok=trial["ok"], error=trial.get("error"), logs=trial.get("logs") or [], duration_ms=trial.get("duration_ms") or 0)
    return format_run(r)
