# The runner

The runner runs code the model writes. Each run is a fresh Node.js child
process that imports one ES module, calls its default export, and is killed,
along with everything it spawned, as soon as the result is back. A run has all
of Node and any npm package. **There is no permission model.** The process
boundary contains crashes, runaway loops, memory growth and leftover handles; it
does not contain authority. Seven's isolation is its container (`docker.md`).

## A run

```text
 source (TS/JS)
     │  scan imports; npm install missing packages into $SEVEN_HOME/node_modules
     ▼
 file under $SEVEN_HOME (tool source, or a temporary file for run_js)
     │  spawn node (own process group, cwd = workspace)
     ▼
 ┌──────────── child process ──────────────┐
 │ import(file) → await default(args)      │── stdout/stderr ──► logs
 │ seven.llm.chat(...) ──── IPC ────► parent host function
 │ result ───────────────── IPC ────► parent
 └─────────────────────────────────────────┘
     │  SIGKILL the process group
     ▼
 { ok, value | error, logs, durationMs }
```

| Step | What happens |
|------|--------------|
| Install | Every bare import that is not a Node built-in is an npm package. A missing one is installed with `npm install --ignore-scripts` into `$SEVEN_HOME/node_modules`; a syntax error is reported here, before any process starts. |
| Spawn | `node --experimental-transform-types` starts in its own process group, with the workspace as its working directory, seven's environment, and a V8 heap cap. |
| Call | The module is imported. A default export that is a function is called with the run's arguments and awaited; any other default export is the result; no default export gives `null`. |
| Result | The result is JSON round-tripped back to the parent. A thrown error becomes `error`, with its stack. |
| Teardown | The whole process group is killed with `SIGKILL` once the result arrives, so open timers, sockets, servers and child processes end with the run. |

Run files live under `$SEVEN_HOME`, which holds a `package.json` with
`"type": "module"`, so `.ts` files are ES modules and resolve packages from
`$SEVEN_HOME/node_modules`. TypeScript is transformed by Node itself, so syntax
that is not just type annotations (enums, namespaces) works.

A run's result:

| Field | Meaning |
|-------|---------|
| `ok` | `true` when the default export returned or resolved. |
| `value` | The result, JSON round-tripped; `undefined` becomes `null`. |
| `error` | The thrown error's stack, or a runner failure: syntax error, failed install, timeout, or a process that exited before returning. |
| `logs` | stdout lines verbatim and stderr lines prefixed `[stderr] `, in arrival order, up to 1,000,000 characters. |
| `durationMs` | Wall-clock time of the run, installs excluded. |

## Limits per run

| Limit | Default | Behavior when hit |
|-------|---------|-------------------|
| Wall-clock time | 60 s (`SEVEN_RUN_TIMEOUT_MS`) | The process group is killed; the run fails with `timed out after Nms`. |
| V8 heap | 1024 MiB (`SEVEN_RUN_MEMORY_MB`) | V8 aborts the process; the run fails with `process exited (signal SIGABRT)`, and the logs hold V8's `heap out of memory` report. |
| Early exit | — | A process that exits or crashes before sending a result fails the run with `process exited (code N)` and the last 20 stderr lines. |

## Host functions

One global is added to Node's own: `seven`. `seven.<module>.<fn>(...args)`
sends a call over the IPC channel to a function in the seven process and
returns a promise for its result. Arguments and results cross as JSON. A
failure rejects with an `Error` whose message starts `seven.<module>.<fn>: `.

| Function | Present | Does |
|----------|---------|------|
| `seven.llm.chat(prompt, system?)` → string | Agent runs | One call to the model the agent runs on, without tools |

A program embedding the runner adds modules through the `host` option of
`createRunner`: `{ name: { fn } }` becomes `seven.name.fn`.

## Dependencies

Versions come from the `deps` map passed with the code (`{"lodash": "^4"}`); an
import not listed there installs at `latest`, and an import already installed
is not reinstalled. All runs share one `node_modules`. Imports found by the
scan are static imports, re-exports, and dynamic `import()` or `require()` with
a literal specifier.

## Limits

| Limit | Detail |
|-------|--------|
| No permission model | Deliberate. A run can do anything the seven process can; run seven in its container. |
| One version per package | All tools share one `node_modules`; requesting a new range for a package changes it for every tool, including saved ones. |
| Computed imports are not installed | `import(name)` with a non-literal specifier fails with `ERR_MODULE_NOT_FOUND` unless the package is already installed. |
| Process startup per run | Each run starts a Node process, about 90 ms before the module's own load time. |
| Escaping the process group | A grandchild that starts its own session (`setsid`, `detached: true`) survives the run. |
| Concurrent npm installs queue | Installs are serialised within one seven process; two processes sharing one `$SEVEN_HOME` can race. |
