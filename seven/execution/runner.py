"""The runner: one fresh Python child process per run.

A run imports one module file, calls its `default` export (a value, or a
callable called with the run's args), and is killed — process group and all —
as soon as the result is back. There is no permission model. Host functions
(`seven.llm.chat`, and `seven.db` locally) cross an RPC channel on a passed fd.
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import json
import os
import signal
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from ..core.log import Logger, noop_logger, preview

MAX_LOG_CHARS = 1_000_000


@dataclass
class RunResult:
    ok: bool
    value: object = None
    error: str | None = None
    logs: list[str] = field(default_factory=list)
    duration_ms: int = 0


class RunHandle:
    def __init__(self, log: Logger):
        self.id = uuid.uuid4().hex[:8]
        self.done: asyncio.Future = asyncio.get_running_loop().create_future()
        self.started_at = time.time()
        self._state = "installing"
        self._logs: list[str] = []
        self._proc: asyncio.subprocess.Process | None = None
        self._killed = False
        self.log = log

    def state(self) -> str:
        return self._state

    def logs(self) -> list[str]:
        return list(self._logs)

    def kill(self) -> None:
        if self.done.done():
            return
        self._killed = True
        proc = self._proc
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(OSError):
                os.killpg(proc.pid, signal.SIGKILL)


def scan_imports(source: str) -> set[str]:
    tree = ast.parse(source)
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                names.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "import_module"
              and isinstance(node.func.value, ast.Name) and node.func.value.id == "importlib"
              and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
            names.add(node.args[0].value.split(".")[0])
    return names


class Runner:
    def __init__(self, *, home: str | Path, cwd: str | Path, timeout_ms: int, memory_mb: int,
                 host: dict | None = None, log: Logger = noop_logger):
        self.home = Path(home)
        self.cwd = str(cwd)
        self.timeout_ms = timeout_ms
        self.memory_mb = memory_mb
        self.host = host or {}
        self.log = log.child(component="runner")
        self.site_packages = self.home / "site-packages"
        self.tmp = self.home / "tmp"
        self.tmp.mkdir(parents=True, exist_ok=True)
        self._install_lock = asyncio.Lock()
        self._live: set[asyncio.Task] = set()

    async def install(self, source: str, deps: dict[str, str] | None, log: Logger) -> list[dict]:
        try:
            compile(source, "<tool>", "exec")
        except SyntaxError as err:
            raise RuntimeError(f"syntax error: {err}") from err
        wanted = scan_imports(source)
        stdlib = getattr(sys, "stdlib_module_names", frozenset())
        specs: list[str] = []
        for name in sorted(wanted):
            if name in stdlib or name == "seven":
                continue
            spec = (deps or {}).get(name, "latest")
            if spec and spec != "latest" and not any(c in spec for c in "<>=!~"):
                spec = f"{name}=={spec}" if spec[0].isdigit() else f"{name}{spec}"
            elif spec and spec != "latest":
                spec = f"{name}{spec}"
            specs.append(spec or name)
            if not self._available(name):
                specs[-1] = spec or name
        missing = [s for s, n in zip(specs, sorted(wanted)) if n not in stdlib and n != "seven" and not self._available(n)]
        installed: list[dict] = []
        if missing:
            async with self._install_lock:
                still = [s for s, n in zip(specs, sorted(wanted)) if n not in stdlib and n != "seven" and not self._available(n)]
                if still:
                    self.site_packages.mkdir(parents=True, exist_ok=True)
                    proc = await asyncio.create_subprocess_exec(
                        sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
                        "--no-input", "--target", str(self.site_packages), *still,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    )
                    _, stderr = await proc.communicate()
                    if proc.returncode != 0:
                        log.error("package install failed", packages=still, error=stderr.decode(errors="replace")[-500:])
                        raise RuntimeError(f"pip install failed for {', '.join(still)}: {stderr.decode(errors='replace')[-300:]}")
                    log.info("packages installed", packages=still)
                    installed = [{"name": s.split("==")[0].split(">")[0].split("<")[0].split("=")[0].split("!")[0].split("~")[0], "spec": s} for s in still]
        return installed

    def _available(self, name: str) -> bool:
        from importlib.machinery import PathFinder
        if PathFinder.find_spec(name, [str(self.site_packages)]) is not None:
            return True
        try:
            import importlib.util
            return importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            return False

    def start_file(self, file: str | Path, args: object = None, timeout_ms: int | None = None,
                   log: Logger = noop_logger) -> RunHandle:
        handle = RunHandle(log)
        task = asyncio.create_task(self._execute(handle, str(file), args, timeout_ms or self.timeout_ms, log))
        self._live.add(task)
        task.add_done_callback(self._live.discard)
        return handle

    def start_eval(self, code: str, *, args: object = None, deps: dict[str, str] | None = None,
                   timeout_ms: int | None = None, log: Logger = noop_logger) -> RunHandle:
        handle = RunHandle(log)
        task = asyncio.create_task(self._eval(handle, code, args, deps, timeout_ms or self.timeout_ms, log))
        self._live.add(task)
        task.add_done_callback(self._live.discard)
        return handle

    async def run_file(self, file: str | Path, args: object = None, timeout_ms: int | None = None,
                       log: Logger = noop_logger) -> RunResult:
        handle = self.start_file(file, args, timeout_ms, log)
        return await handle.done

    async def _eval(self, handle: RunHandle, code: str, args, deps, timeout_ms: int, log: Logger) -> None:
        try:
            await self.install(code, deps, log)
        except Exception as err:
            handle._state = "done"
            handle.done.set_result(RunResult(ok=False, error=str(err), logs=[], duration_ms=0))
            log.warning("run not started", run_id=handle.id, error=preview(str(err), 300))
            return
        fd, path = tempfile.mkstemp(prefix="eval-", suffix=".py", dir=self.tmp)
        try:
            with os.fdopen(fd, "w") as f:
                f.write(code)
            await self._execute(handle, path, args, timeout_ms, log)
        finally:
            with contextlib.suppress(OSError):
                os.unlink(path)

    async def _execute(self, handle: RunHandle, file: str, args: object, timeout_ms: int, log: Logger) -> None:
        started = time.time()
        proc: asyncio.subprocess.Process | None = None
        rpc_w = -1
        logs: list[str] = handle._logs
        log_chars = 0
        dropped = 0
        result: RunResult | None = None
        if handle._killed:
            _finish(handle, RunResult(ok=False, error="killed", logs=[], duration_ms=0))
            handle._state = "done"
            log.warning("run finished", run_id=handle.id, outcome="killed", duration_ms=0, output_lines=0)
            return
        try:
            rpc_r, rpc_w = os.pipe()
            req = {"file": file, "args": args, "workspace": self.cwd, "home": str(self.home),
                   "site_packages": str(self.site_packages), "memory_mb": self.memory_mb, "rpc_fd": rpc_w}
            env = dict(os.environ)
            env["PYTHONPATH"] = os.pathsep.join([str(Path(__file__).resolve().parent.parent), env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-u", "-m", "seven.execution.child",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                cwd=self.cwd, env=env, start_new_session=True, pass_fds=(rpc_w,),
            )
            handle._proc = proc
            os.close(rpc_w)
            rpc_w = -1
            if handle._killed:
                with contextlib.suppress(OSError):
                    os.killpg(proc.pid, signal.SIGKILL)
            handle._state = "running"
            log.info("run started", run_id=handle.id, file=file, pid=proc.pid, timeout_ms=timeout_ms, memory_mb=self.memory_mb)
            proc.stdin.write(json.dumps(req).encode() + b"\n")
            await proc.stdin.drain()

            loop = asyncio.get_running_loop()
            rpc_reader = asyncio.StreamReader()
            rpc_file = os.fdopen(rpc_r, "rb", buffering=0)
            await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(rpc_reader), rpc_file)

            async def read_stream(stream, prefix: str) -> None:
                nonlocal log_chars, dropped
                while True:
                    line = await stream.readline()
                    if not line:
                        return
                    text = line.decode(errors="replace").rstrip("\n")
                    entry = prefix + text
                    if log_chars < MAX_LOG_CHARS:
                        logs.append(entry)
                        log_chars += len(entry) + 1
                    else:
                        dropped += 1

            async def rpc_loop() -> None:
                while True:
                    line = await rpc_reader.readline()
                    if not line:
                        return
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if "rpc" in msg:
                        call = msg["rpc"]
                        log.debug("host call", run_id=handle.id, fn=f"seven.{call['module']}.{call['fn']}")
                        try:
                            fn = self.host[call["module"]][call["fn"]]
                            value = fn(*call["args"])
                            if asyncio.iscoroutine(value):
                                value = await value
                            resp = {"rpc_result": {"id": call["id"], "ok": True, "value": value}}
                        except Exception as err:
                            resp = {"rpc_result": {"id": call["id"], "ok": False, "error": str(err)}}
                        proc.stdin.write(json.dumps(resp).encode() + b"\n")
                        await proc.stdin.drain()
                    elif "result" in msg:
                        raw_result.set_result(msg["result"])
                        return

            raw_result: asyncio.Future = asyncio.get_running_loop().create_future()
            out_task = asyncio.create_task(read_stream(proc.stdout, ""))
            err_task = asyncio.create_task(read_stream(proc.stderr, "[stderr] "))
            rpc_task = asyncio.create_task(rpc_loop())
            exit_task = asyncio.create_task(proc.wait())
            timed_out = False
            try:
                await asyncio.wait_for(asyncio.wait({raw_result, exit_task}, return_when=asyncio.FIRST_COMPLETED), timeout=timeout_ms / 1000)
            except TimeoutError:
                timed_out = True
                handle.kill()
            rpc_task.cancel()
            with contextlib.suppress(OSError):
                os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()
            await asyncio.gather(out_task, err_task, return_exceptions=True)
            all_logs = list(logs) + ([f"… [{dropped} lines dropped]"] if dropped else [])
            duration_ms = round((time.time() - started) * 1000)
            if raw_result.done() and not timed_out:
                result = _mk_result(raw_result.result(), all_logs, 0, started)
            elif timed_out:
                result = RunResult(ok=False, error=f"timed out after {timeout_ms}ms", logs=all_logs, duration_ms=duration_ms)
            else:
                code = exit_task.result()
                err_tail = [l for l in all_logs if l.startswith("[stderr] ")][-20:]
                if handle._killed:
                    result = RunResult(ok=False, error="killed", logs=all_logs, duration_ms=duration_ms)
                else:
                    sig = f"signal {signal.Signals(-code).name}" if code and code < 0 else f"code {code}"
                    result = RunResult(ok=False, error=f"process exited ({sig})" + ("\n" + "\n".join(err_tail) if err_tail else ""), logs=all_logs, duration_ms=duration_ms)
            _finish(handle, result)
        except Exception as err:
            log.error("run could not start", run_id=handle.id, error=err)
            result = RunResult(ok=False, error=str(err), logs=list(logs), duration_ms=round((time.time() - started) * 1000))
            if not handle.done.done():
                handle.done.set_result(result)
        finally:
            if rpc_w >= 0:
                with contextlib.suppress(OSError):
                    os.close(rpc_w)
            if not handle.done.done():
                _finish(handle, RunResult(ok=False, error="killed", logs=list(logs), duration_ms=round((time.time() - started) * 1000)))
            handle._state = "done"
            result = handle.done.result()
            outcome = "ok" if result.ok else ("killed" if result.error == "killed" else ("timeout" if str(result.error or "").startswith("timed out") else "error"))
            log.log("warn" if not result.ok else "info", "run finished", run_id=handle.id, outcome=outcome,
                    duration_ms=result.duration_ms, output_lines=len(result.logs),
                    **({} if result.ok else {"error": preview(result.error, 300)}))

    async def shutdown(self) -> None:
        for task in list(self._live):
            task.cancel()
        await asyncio.gather(*self._live, return_exceptions=True)


def _mk_result(raw: dict, logs: list[str], dropped: int, started: float) -> RunResult:
    all_logs = list(logs) + ([f"… [{dropped} lines dropped]"] if dropped else [])
    return RunResult(ok=bool(raw.get("ok")), value=raw.get("value"), error=raw.get("error"),
                     logs=all_logs, duration_ms=round((time.time() - started) * 1000))


def _finish(handle: RunHandle, result: RunResult) -> None:
    if not handle.done.done():
        handle.done.set_result(result)
