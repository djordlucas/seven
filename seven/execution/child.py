"""The child process of one run: load a module file, call its default export, report back.

The request arrives as one JSON line on stdin; host-function calls and the
final result go back on the rpc fd (a pipe passed by the parent). stdout and
stderr stay free for the run's own output, which the parent captures.
"""

from __future__ import annotations

import contextlib
import importlib.util
import inspect
import json
import os
import sqlite3
import sys
import traceback
from pathlib import Path


def _set_memory_cap(memory_mb: int) -> None:
    import resource
    with contextlib.suppress(OSError, ValueError, OverflowError):
        limit = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


class _Rpc:
    def __init__(self, out_fd: int, stdin):
        self.out = os.fdopen(out_fd, "w", encoding="utf-8")
        self.stdin = stdin
        self.n = 0

    def call(self, module: str, fn: str, args: list):
        self.n += 1
        self.out.write(json.dumps({"rpc": {"id": self.n, "module": module, "fn": fn, "args": args}}) + "\n")
        self.out.flush()
        line = self.stdin.readline()
        if not line:
            raise RuntimeError(f"seven.{module}.{fn}: the runner closed the channel")
        resp = json.loads(line)["rpc_result"]
        if not resp.get("ok"):
            raise RuntimeError(f"seven.{module}.{fn}: {resp.get('error')}")
        return resp.get("value")


class _Llm:
    def __init__(self, rpc: _Rpc):
        self._rpc = rpc

    def chat(self, prompt: str, system: str | None = None) -> str:
        return self._rpc.call("llm", "chat", [prompt, system])


class _Seven:
    def __init__(self, rpc: _Rpc, workspace: str):
        self.llm = _Llm(rpc)
        self._workspace = str(Path(workspace).resolve())

    def db(self, path: str) -> sqlite3.Connection:
        target = (Path(self._workspace) / path).resolve()
        target.relative_to(self._workspace)
        target.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(target))
        conn.row_factory = sqlite3.Row
        return conn


def _send(rpc_out, payload: dict) -> None:
    rpc_out.write(json.dumps(payload) + "\n")
    rpc_out.flush()


def main() -> None:
    req = json.loads(sys.stdin.buffer.readline())
    rpc = _Rpc(req["rpc_fd"], sys.stdin.buffer)
    if req.get("memory_mb"):
        _set_memory_cap(int(req["memory_mb"]))
    site = req.get("site_packages")
    if site:
        sys.path.insert(0, site)
    seven = _Seven(rpc, req["workspace"])
    spec = importlib.util.spec_from_file_location("seven_run_module", req["file"])
    mod = importlib.util.module_from_spec(spec)
    mod.__dict__["seven"] = seven
    try:
        spec.loader.exec_module(mod)
    except BaseException:
        _send(rpc.out, {"result": {"ok": False, "error": traceback.format_exc()}})
        return
    default = getattr(mod, "default", None)
    try:
        if callable(default):
            value = default(req.get("args") or {})
        else:
            value = default
        if inspect.isawaitable(value):
            import asyncio
            value = asyncio.run(_await(value))
        payload = json.loads(json.dumps(value))
        _send(rpc.out, {"result": {"ok": True, "value": payload}})
    except BaseException:
        err = traceback.format_exc()
        _send(rpc.out, {"result": {"ok": False, "error": err or "error"}})


async def _await(value):
    return await value


if __name__ == "__main__":
    main()
