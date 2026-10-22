# The VM

The VM runs code the model writes. Each run gets a fresh QuickJS interpreter,
compiled to WebAssembly, that evaluates one ES module, calls its default export,
and is destroyed when the run returns. Code reaches the outside world only
through host functions, which are imported as `seven:*` modules — and the host
functions grant everything the seven process can do. **There is no permission
model.** The wasm boundary contains crashes, runaway loops and memory growth; it
does not contain authority. Seven's isolation is its container (`docker.md`).

## A run

```text
 source (TS/JS, npm imports)
        │  bundle: strip types, npm install bare imports, inline them
        ▼
 one ESM module, imports left: seven:* only
        │  run
        ▼
 ┌──────────── fresh QuickJS runtime (wasm) ────────────┐
 │ prelude: console, fetch, timers, TextEncoder, ...    │
 │ module top-level code                                │
 │ await default(args)  ──── seven:* call ──► host fn   │
 │                      ◄─── JSON result ──── (Node)    │
 └──────────────────────────────────────────────────────┘
        │
        ▼
 { ok, value | error, logs, durationMs }
```

| Step | What happens |
|------|--------------|
| Bundle | esbuild strips TypeScript and bundles to one ESM module. Every bare import is an npm package: installed into the shared dependency cache if missing, then inlined. Install scripts never run. |
| Prelude | A script builds the globals QuickJS lacks, then removes the raw host primitives from the global object. |
| Evaluate | The module is imported; its top-level code runs, with top-level `await` allowed. |
| Call | A default export that is a function is called with the run's arguments and awaited. Any other default export is the result as-is; no default export gives `null`. |
| Settle | The result is JSON round-tripped back to the host. A thrown error becomes `error`, with its stack. |
| Teardown | The runtime is destroyed. Host calls still in flight finish on the Node side and their results are dropped. |

A run's result:

| Field | Meaning |
|-------|---------|
| `ok` | `true` when the default export returned or resolved. |
| `value` | The result, JSON round-tripped. |
| `error` | The thrown error as `Name: message` plus the stack, or a VM failure: bundle error, interrupt, timeout, deadlock. |
| `logs` | One entry per `console` call. Entries other than `console.log` are prefixed with the level, as in `[warn] …`. |
| `durationMs` | Wall-clock time of the run, bundling excluded. |

## Limits per run

| Limit | Default | Behavior when hit |
|-------|---------|-------------------|
| Wall-clock time | 60 s for agent runs (`SEVEN_RUN_TIMEOUT_MS`), 30 s otherwise | Running code is interrupted (`InternalError: interrupted`); a run waiting on the host fails with `timed out after Nms`. |
| Memory | 256 MiB | Allocation fails inside the guest (`out of memory`). |
| Stack | 4 MiB | `RangeError` / stack overflow inside the guest. |
| Deadlock | — | A run with no host call in flight and an unsettled promise fails at once with `never settled`. |

## Globals

| Global | Notes |
|--------|-------|
| `console` | `log`, `info`, `debug`, `warn`, `error`. Non-string arguments are JSON-encoded. |
| `fetch(url, init)` | Returns `{ ok, status, statusText, url, headers.get/has/entries, text(), json() }`. A non-string `body` is JSON-encoded. The body is read as text; there is no streaming and no `arrayBuffer()`. |
| `setTimeout`, `clearTimeout` | Backed by the host's timers. No `setInterval`. |
| `queueMicrotask` | |
| `TextEncoder`, `TextDecoder` | UTF-8 only. |
| `atob`, `btoa` | |

Everything else is ECMAScript as QuickJS implements it. There is no `require`,
`process`, `Buffer`, `URL` or `node:*` module.

## Host modules

Every host function is async, takes JSON-serialisable arguments and returns a
JSON-serialisable value. Binary data crosses as base64 strings. A failed host
call rejects with an `Error` whose message is prefixed by the function's name
(`fs.readFile: ENOENT …`). Relative paths resolve against the workspace.

| Module | Functions |
|--------|-----------|
| `seven:fs` | `readFile(path, "utf8" \| "base64")`, `writeFile(path, data, encoding?)` (creates parent directories), `appendFile(path, data)`, `readdir(path)` → `[{name, type}]`, `mkdir(path)` (recursive), `rm(path)` (recursive, no error if missing), `rename(from, to)`, `stat(path)` → `{size, type, mtime}`, `exists(path)` |
| `seven:shell` | `run(command, {cwd?, input?, timeoutMs?})` → `{code, stdout, stderr}`, through `/bin/sh`; 120 s default timeout, 16 MiB output cap |
| `seven:env` | `get(name)` → string or `null`, `all()`, `cwd()` |
| `seven:wasm` | `run(path \| {base64}, {args?, env?, stdin?, cwd?})` → `{code, stdout, stderr}`: runs a WASI preview1 command module on Node's own wasm engine, with `cwd` pre-opened as `/` |
| `seven:llm` | `chat(prompt, system?)` → string: one call to the model the agent runs on, without tools. Present in agent runs only. |

Each module also has a default export holding all of its functions
(`import fs from "seven:fs"`). Importing a name a module does not export fails
at evaluation, before any code runs.

A program embedding the VM adds or replaces modules through the `host` option
of `createVM`: `{ name: { fn } }` becomes `seven:name` with an export `fn`. No
change to the VM is needed.

## Dependencies

Any bare import is an npm package. Versions come from the `deps` map passed
with the code (`{"lodash-es": "^4"}`); an import not listed there installs at
`latest`. Packages live in one shared cache under `$SEVEN_HOME/deps`, installed
once and reused by every later bundle. Packages resolve with the `module`,
then `main`, entry point and the `import` / `module` / `default` export
conditions — the same as a browser bundle.

## Raw wasm

A WASI module runs through `seven:wasm` (or `runWasi` for a program embedding
the VM). It gets its arguments, environment, stdin and one pre-opened
directory, and its stdout and stderr are captured. It runs on Node's wasm
engine, not inside the QuickJS runtime, and is not subject to the run's memory
limit.

## Limits

| Limit | Detail |
|-------|--------|
| No permission model | Deliberate. Host functions can do anything the seven process can; run seven in its container. |
| Node-only packages fail | A package that imports a Node built-in is refused at bundle time; one that uses `process` or `Buffer` at run time throws `ReferenceError`. |
| One version per package | All tools share one `node_modules`; requesting a new range for a package changes it for every tool bundled afterwards. Already-saved tools keep the code they were bundled with. |
| No `URL`, `setInterval`, streams, `arrayBuffer()` | Not implemented in the prelude. A package that needs `URL` can bundle a polyfill such as `whatwg-url`. |
| JSON-only host boundary | Values that do not survive `JSON.stringify` (functions, `undefined` in arrays, `Map`, cycles) are lost or rejected at the boundary. |
| Raw wasm is unbounded | A WASI module has no time or memory limit of its own; only the run's wall-clock timeout ends the wait, and the module keeps running on the Node side until it exits. |
| Host calls outlive a timed-out run | A shell command or fetch started before a timeout runs to completion; only its result is discarded. |
| Concurrent npm installs queue | Installs into the shared cache are serialised within one seven process; two processes sharing one `$SEVEN_HOME` can race. |
