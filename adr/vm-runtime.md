# VM runtime

**Status:** Implemented — **Date:** 2026-10-21
**Scope:** `src/vm/` — **Derived from:** nine's `internal/toolvm` (QuickJS + wazero)

Seven's VM was built as a simpler equivalent of nine's tool VM. It kept nine's
execution model — QuickJS compiled to wasm, one fresh instance per call, the
author's default export as the entry point, npm dependencies bundled with
esbuild before the code runs — and dropped nine's capability model, its custom
C shim and its hand-rolled registry client. The result is about 700 lines of
TypeScript against nine's roughly 25,000 lines of Go, C and JavaScript.

## What was kept from nine

| Nine | Seven | Why it was kept |
|------|-------|-----------------|
| QuickJS compiled to wasm, one instance per call | One `QuickJSRuntime` per run, disposed on return | No state leaks between runs (R-VM.1); a runaway or crashed guest takes nothing with it. |
| Default export `async (args) => result`, wrapped by a harness module | The same, in `HARNESS_SOURCE` | The contract a model already writes naturally. |
| Harness imports the tool after the platform layer exists | Prelude script evaluated before the entry module | Nine found module-level `console.log` failing when the tool was imported first; the prelude avoids the same bug. |
| Web-platform layer in JS (console, TextEncoder, crypto, timers) | The same in `PRELUDE`, smaller | QuickJS implements ECMAScript only. |
| esbuild bundling of npm dependencies at write time, install scripts never run | `bundle.ts`, via `npm install --ignore-scripts` | Code arrives at the guest with no imports to resolve but `seven:*`. |
| Host primitives removed from `globalThis` after capture | The same (R-VM.3) | Author code cannot bind to internals. |

## What was dropped, and the reason

| Nine | Seven | Reason |
|------|-------|--------|
| wazero host in Go | Node's wasm engine, via quickjs-emscripten | Seven is a Node program; the interpreter, its build and its JS API come prebuilt. |
| Custom `qjs_host.c` shim, pinned wasi-sdk build, committed `qjs.wasm` + sha256 | The `@jitl/quickjs-wasmfile-release-sync` package, version-pinned in `package-lock.json` | No C toolchain, no binary under review in the repo. The trust moves to an npm package. |
| A two-export ABI (`nine_alloc`, `nine_run`) and a JSON envelope | One async primitive, `__seven_call(name, argsJSON)`, returning a JSON envelope | Every host function is generic: adding one is a map entry, with no ABI change. |
| Capability grants: `[tools]` ceilings, per-tool requested capabilities, an operator approval flow, SSRF filtering, workspace path confinement | None: every host function is given to every run (R-VM.16) | The user asked for a VM with no permissions. Seven's isolation is its container. |
| Developer / generated / ephemeral / shipped trust tiers | One tier | Tiers exist to scope capabilities; with none, they have nothing to scope. |
| Registry client with integrity verification, allowlist, depth and package caps | `npm install` into one shared cache | npm already verifies integrity against the registry; the allowlist and caps were policy, and policy was out of scope. |
| Curated `nine:*` standard library (csv, date, diff, html, sql, state, job) | Host modules `fs`, `shell`, `env`, `wasm`, `llm` plus any npm package | The agent can install or write what the curated library provided. |
| `wasm` tool kind: a raw module exporting the ABI | `seven:wasm.run`: any WASI preview1 command module, stdio captured | Standard WASI rather than a seven-specific ABI, so existing toolchains' output runs unmodified. |
| Work budget in interrupt checks, durable cursors, standing tools | A wall-clock deadline per run | Not needed for a first agent; nothing prevents adding them later. |

## Choices made along the way

- **Sync QuickJS variant, promise-based host calls, not asyncify.** The
  asyncify variant lets a host function block the guest, but only one call may
  be suspended at a time. Returning a QuickJS promise from every host call and
  pumping `executePendingJobs` when it settles lets a guest have many host
  calls in flight (`Promise.all` over fetches) and keeps the faster, smaller
  build.
- **Deadlock detection.** A run whose promise is pending with no host call in
  flight can never progress, so it fails at once (R-VM.11) rather than waiting
  for the deadline. Nine's synchronous ABI did not have this case.
- **Interrupts surface through the module's evaluation promise.** An interrupt
  inside the default export rejects the entry module's top-level-await promise
  rather than throwing from `executePendingJobs`; the run inspects that promise
  when nothing else is pending.
- **One shared `node_modules`.** Nine linked each package from a
  content-addressed cache into a per-bundle tree. Seven installs into one
  directory, which allows one version per package across all tools; the bundle
  is frozen at save time, so this affects only later bundles.
- **TypeScript in the guest.** esbuild's `ts` loader is used for all source, so
  the model may write TypeScript. A side effect: unused imports are elided, so
  an unused `import fs from "node:fs"` is not an error.

## Limits

The record above reflects the bootstrap commit. The VM's present behavior is in
`docs/vm.md` and `spec/contracts/vm.md`.
