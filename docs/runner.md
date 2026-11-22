# The runner

The runner runs code the model writes. Each run is a fresh Python child process
(`python -m seven.execution.child`) that imports one module file, calls its `default`
export, and is killed, along with everything it spawned, as soon as the result
is back. A run has all of Python's standard library and any pip package. **There
is no permission model.** The process boundary contains crashes, runaway loops,
memory growth and leftover handles; it does not contain authority. Seven's
isolation is its container.

## A run

```text
 source (Python)
     │  scan imports; pip install missing packages into <workspace>/.seven/site-packages
     ▼
 file under <workspace>/.seven (tool source, or a temporary file for run_python)
     │  spawn python (own process group, cwd = workspace, RLIMIT_AS = memory cap)
     ▼
 ┌──────────────────── child process ─────────────────────┐
 │ import the module → await default(args)                │─ stdout/stderr ─▶ logs
 │ seven.llm.chat(...) ── RPC on a passed fd ────────────▶│ parent host function
 │ result ── RPC on the fd ──────────────────────────────▶│ parent
 └────────────────────────────────────────────────────────┘
     │  SIGKILL the process group
     ▼
 { ok, value | error, logs, duration_ms }
```

| Step | What happens |
|------|--------------|
| Install | Every top-level import that is not stdlib is a pip package. A missing one is installed with `pip install --target <workspace>/.seven/site-packages` (serialised within one seven process); a syntax error is reported here, before any process starts. |
| Spawn | `python -u -m seven.execution.child` starts in its own process group, with the workspace as its working directory, seven's environment, and an address-space cap (`SEVEN_RUN_MEMORY_MB`, via `RLIMIT_AS`). |
| Call | The module is imported with a `seven` global injected. `default` that is callable is called once with the run's arguments (default `{}`) and awaited if it returns an awaitable; any other `default` is awaited and is the result; no `default` gives `null`. |
| Result | The result is JSON round-tripped back to the parent. A thrown error becomes `error`, with its traceback. A value `json.dumps` rejects fails the run with that error. |
| Teardown | The whole process group is killed with `SIGKILL` once the result arrives, so open timers, sockets, servers and child processes end with the run. |

The protocol: the request (file, args, limits, the RPC fd) is one JSON line on
the child's stdin; host-function calls and the final result are JSON lines on a
pipe fd passed to the child. stdout and stderr stay free for the run's own
output, which the parent captures as logs.

A run's result:

| Field | Meaning |
|-------|---------|
| `ok` | `true` when `default` returned or resolved. |
| `value` | The result, JSON round-tripped. |
| `error` | The traceback, or a runner failure: syntax error, failed install, timeout, killed, or a process that exited before returning. |
| `logs` | stdout lines verbatim and stderr lines prefixed `[stderr] `, in arrival order, up to 1,000,000 characters (a final line counts the lines dropped). |
| `duration_ms` | Wall-clock time of the run, installs excluded. |

## Run handles

Starting a run returns a handle at once; the result arrives later. The agent
uses handles for both kinds of tool call: a synchronous call awaits the
handle's result, a background run keeps the handle in the run table.

| Handle member | Meaning |
|---------------|---------|
| `done` | A future that resolves with the result when the run ends, however it ends. |
| `state()` | `installing` (packages), `running` (the process), or `done`. |
| `logs()` | The complete output lines so far. |
| `kill()` | Kills the process group; the run fails with `killed`. A kill during installation cancels the run before a process starts. No effect once the result is in. |
| `started_at` | When the run was started. |

When the seven process exits, every live run's process group is killed.

## Limits per run

| Limit | Default | Behavior when hit |
|-------|---------|-------------------|
| Wall-clock time | 60 s (`SEVEN_RUN_TIMEOUT_MS`) | The process group is killed; the run fails with `timed out after Nms`. |
| Address space | 1024 MiB (`SEVEN_RUN_MEMORY_MB`) | The child's `RLIMIT_AS` aborts it; the run fails with `process exited (signal SIGABRT)` and the logs hold the allocation failure. |
| Early exit | — | A process that exits or crashes before sending a result fails the run with `process exited (code N)` / `(signal S)`, plus the last 20 stderr lines. |

## Host functions

One global is added to the run module: `seven`. `seven.<module>.<fn>(...args)`
sends a call over the RPC channel to a function in the seven process and returns
its result. Arguments and results cross as JSON. A failure, or a missing
function, raises an error whose message starts `seven.<module>.<fn>: `.

| Function | Does |
|----------|------|
| `seven.llm.chat(prompt, system=None) -> str` | One call to the model the agent runs on, without tools |
| `seven.db(path) -> sqlite3.Connection` | Runs in the child: a connection to a database file in the workspace, created if needed (`data.md`) |

A program embedding the runner adds modules through the `host` option of
`Runner`: `{name: {fn: …}}` becomes `seven.name.fn`.

## Dependencies

Versions come from the `deps` map passed with the code (`{"requests": ">=2"}`);
an import not listed there installs at `latest`, and an import already
installed is not reinstalled. All runs share one `site-packages`. Imports found
by the scan are static imports, `from` imports, and literal
`importlib.import_module("…")` calls.

## Limits

| Limit | Detail |
|-------|--------|
| No permission model | Deliberate. A run can do anything the seven process can; run seven in its container. |
| One version per package | All runs share one `site-packages`; a new range for a package changes it for every run, including saved ones. |
| Computed imports are not installed | `importlib.import_module(name)` with a non-literal name is not scanned; it fails unless the package is already installed. |
| Process startup per run | Each run starts a Python process, tens of milliseconds before the module's own load time. |
| Escaping the process group | A grandchild that starts its own session (`os.setsid`) survives the run. |
| Concurrent pip installs queue | Installs are serialised within one seven process; two seven processes in one workspace can race. |
