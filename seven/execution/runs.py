"""Background runs: tool calls an agent started with start_tool and controls by id.

Each is a row in the state database, so its result and output outlive the
process; the live handle exists only in the process that started it. A run
still going when that process exits is marked lost at the next start.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime
from pathlib import Path

from ..core.log import Logger, noop_logger
from ..core.state import State
from .runner import RunHandle

KEEP_LOG_LINES = 500


class RunTable:
    def __init__(self, state: State, log: Logger = noop_logger, spill_chars: int = 2000, memory_dir: Path | None = None):
        self.state = state
        self.handles: dict[str, RunHandle] = {}
        self.closed = False
        self.spill_chars = spill_chars
        self.memory_dir = Path(memory_dir) if memory_dir else None
        self.log = log.child(component="runs")

    def add(self, agent: str, tool: str, handle: RunHandle) -> str:
        rid = self.state.insert_run(agent, tool)
        self.handles[rid] = handle
        self.log.info("background run started", run=rid, run_id=handle.id, agent=agent, tool=tool)

        def on_done(_fut):
            self.handles.pop(rid, None)
            if not self.closed:
                r = handle.done.result()
                self.log.info("background run finished", run=rid, run_id=handle.id, agent=agent, tool=tool,
                              ok=r.ok, duration_ms=r.duration_ms)
            if not self.closed and self.state.is_open:
                r = handle.done.result()
                logs = r.logs[-KEEP_LOG_LINES:]
                if self.spill_chars > 0 and self.memory_dir is not None and sum(len(l) for l in r.logs) > self.spill_chars:
                    logs = self._spill(rid, agent, r)
                self.state.finish_run(rid, {"ok": r.ok, "value": r.value, "error": r.error,
                                             "logs": logs, "duration_ms": r.duration_ms})

        handle.done.add_done_callback(on_done)
        return rid

    def get(self, rid: str) -> dict | None:
        return self.state.get_run(rid)

    def handle(self, rid: str) -> RunHandle | None:
        return self.handles.get(rid)

    def list(self, agent: str, limit: int = 50) -> list[dict]:
        return self.state.list_runs(agent, limit)

    def kill_all(self, agent: str) -> None:
        for run in self.list(agent, 1000):
            h = self.handles.get(run["id"])
            if h:
                h.kill()

    async def settled(self, rid: str) -> None:
        h = self.handles.get(rid)
        if h is None:
            return
        await h.done
        await asyncio.sleep(0)

    async def shutdown(self) -> None:
        self.closed = True
        live = list(self.handles.values())
        if live:
            self.log.warning("killing background runs at shutdown", count=len(live))
        for h in live:
            h.kill()
        self.state.mark_lost_runs()
        await asyncio.gather(*(h.done for h in live), return_exceptions=True)

    def mark_checked(self, rid: str) -> None:
        self.state.mark_run_checked(rid)

    def _spill(self, rid: str, agent: str, r) -> list[str]:
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        path = self.memory_dir / f"{rid}.out"
        text = "\n".join(r.logs)
        path.write_text(text, encoding="utf-8")
        self.state.record_output(oid=rid, agent=agent, tool=rid, path=str(path), chars=len(text), lines=len(r.logs))
        ref = (f"[full output spilled to memory {rid} ({len(text)} chars, {len(r.logs)} lines); "
               f'read chunks with read_memory("{rid}", from, to)]')
        return [ref, *r.logs[-50:]]


def _seconds(ms: float) -> str:
    return f"{ms / 1000:.1f}s"


def _first_line(s: str | None) -> str:
    return (s or "").split("\n")[0]


def _parse_iso(s: str) -> float:
    return datetime.fromisoformat(s).timestamp()


def summarize(run: dict, live: RunHandle | None = None, now: float | None = None) -> str:
    now = now if now is not None else time.time()
    head = f"{run['id']} {run['tool']}"
    if run["status"] == "running":
        state = live.state() if live else "running"
        return f"{head}: {state} for {_seconds((now - _parse_iso(run['started_at'])) * 1000)}"
    if run["status"] == "lost":
        return f"{head}: {run['error']}"
    outcome = "ok" if run["ok"] else f"failed: {_first_line(run['error'])}"
    return f"{head}: finished in {_seconds(run['duration_ms'] or 0)}, {outcome}{'' if run['checked'] else ' (not checked yet)'}"


def describe(runs: RunTable, rid: str, tail: int) -> str | None:
    before = runs.get(rid)
    if before is None:
        return None
    live = runs.handle(rid)
    if before["status"] != "running":
        runs.mark_checked(rid)
    run = runs.get(rid)
    lines = (live.logs() if live else []) if run["status"] == "running" else run["logs"]
    parts = [summarize(run, live)]
    if run["status"] == "done":
        if run["ok"]:
            v = run["value"]
            parts.append(v if isinstance(v, str) else json.dumps(v, indent=2, default=str))
        else:
            parts.append(f"error: {run['error']}")
    if lines:
        shown = lines[-tail:]
        label = f"last {len(shown)} of {len(lines)} lines" if len(shown) < len(lines) else f"{len(lines)} lines"
        parts.append(f"--- output ({label}) ---\n" + "\n".join(shown))
    return "\n".join(parts)
