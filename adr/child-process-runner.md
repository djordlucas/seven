# Child-process runner

**Status:** Implemented — **Date:** 2026-10-21
**Scope:** `src/runner/` (replaces `src/vm/`) — **Supersedes:** `adr/vm-runtime.md`

Seven stopped running model-written code in QuickJS compiled to wasm, and runs
each piece as a module in its own Node.js child process instead. The deciding
fact was npm compatibility: inside QuickJS, 9 of 20 popular packages worked
unmodified, and making most of the rest work meant reimplementing Node's
built-ins on a JSON bridge. A child process runs all 20, and the runner shrank
from about 700 lines to about 450.

## Probe

On 2026-10-21, 20 packages were bundled and called once inside the QuickJS VM,
three ways: as the VM stood; with Node built-ins aliased to npm polyfills
(`buffer`, `events`, `path-browserify`, `util`, `readable-stream`, `url`,
`os-browserify`, `assert`, …) and `process`/`Buffer`/`crypto` injected as
globals; and the same plus the `browser` field and export condition.

| Configuration | Worked |
|---------------|--------|
| VM as shipped | 9 / 20 |
| With Node polyfills | 15 / 20 |
| Polyfills + browser builds | 16 / 20 |

The four that still failed were fs-extra and glob (both need a full synchronous
`fs`), axios (`http2`) and js-yaml (a default-import interop error). Servers,
sockets, native add-ons and synchronous networking could not be made to work in
that design at all. The cost of the polyfills was about 70 KB per bundle.

## Decision

| Option | Compatibility | Isolation | Chosen |
|--------|---------------|-----------|--------|
| QuickJS + a Node compatibility layer | Most pure-JS packages; no servers, sockets or add-ons | wasm heap and interrupts | No |
| `worker_threads` | All of Node except `process.chdir` | Shares the process: a native crash, an add-on, or `process.abort()` takes seven down; `cwd` cannot differ | No |
| Child process | All of Node | Separate process and heap; the process group is killed at the end of each run | Yes |

The VM's isolation was already deliberately not a security boundary (no
permission model), so moving from wasm to a process gave up nothing the design
relied on. What it kept — a fresh environment per run, a deadline, a memory
cap — the child process provides with `SIGKILL` on the process group and
`--max-old-space-size`.

## What changed

| Before (VM) | After (runner) |
|-------------|----------------|
| QuickJS via `quickjs-emscripten`, prelude for `console`/`fetch`/timers/`TextEncoder` | Node itself |
| esbuild bundled every tool into `bundle.js`, frozen at save time | Tools run from `source.ts`; esbuild only scans imports for installation |
| Dependency cache at `$SEVEN_HOME/deps` | `$SEVEN_HOME/node_modules`, resolved because run files live under `$SEVEN_HOME` |
| Host modules `seven:fs`, `seven:shell`, `seven:env`, `seven:wasm`, `seven:llm` | Node's own modules; only `seven.llm.chat` remains, as a global over IPC |
| `seven:wasm` ran WASI modules | Dropped: `node:wasi` is available to every run |
| Node built-in imports refused | Allowed |
| Interrupt handler + wall-clock deadline | `SIGKILL` to the process group at the deadline |

Two properties were lost. Saved tools are no longer frozen: they import from the
shared `node_modules`, so upgrading a package changes every tool that uses it.
And each run pays Node's startup, about 90 ms, where a QuickJS runtime took
about 2 ms.

## Limits

This record describes the switch as of its commit. Present behavior is in
`docs/runner.md` and `spec/contracts/runner.md`.
