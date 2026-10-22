# VM contract

Requirements `R-VM.*` define what the VM guarantees to the code it runs and to
the program embedding it. `docs/vm.md` describes the same behavior for users;
this document is the version tests are written against.

## Requirements

| ID | Requirement |
|----|-------------|
| R-VM.1 | Each run executes in a new QuickJS runtime and context, disposed before `runModule` resolves. No global, module or heap state survives from one run to another. |
| R-VM.2 | The prelude runs before any module code, so `console`, `fetch`, timers, `TextEncoder`/`TextDecoder` and `atob`/`btoa` exist during the module's top-level evaluation. |
| R-VM.3 | After the prelude, the global object exposes none of the host primitives (`__seven_call`, `__seven_log`, `__seven_settle`, `__seven_args`). |
| R-VM.4 | A default export that is a function is called once with the run's arguments (default `{}`) and awaited; any other default export is the result; no default export yields `null`. |
| R-VM.5 | The result is the JSON round-trip of the returned value; `undefined` becomes `null`. |
| R-VM.6 | A thrown or rejected error yields `ok: false` and `error` = `Name: message`, followed by the stack when one exists. |
| R-VM.7 | Module resolution serves only `seven:entry`, `seven:harness`, and `seven:<m>` for each configured host module `m`. Any other specifier fails with `module not found`. |
| R-VM.8 | `seven:<m>` exports one async function per host function of `m`, plus a default export object holding all of them. |
| R-VM.9 | A host function's arguments and return value cross as JSON. A host function that throws or rejects makes the guest's call reject with an `Error` whose message starts `<m>.<fn>: `. |
| R-VM.10 | Running code is interrupted at the run's deadline. A run waiting on host calls at the deadline fails with `timed out after <N>ms`. |
| R-VM.11 | A run whose result promise is unsettled while no host call is in flight fails immediately, without waiting for the deadline. |
| R-VM.12 | Guest memory is capped (default 256 MiB); exceeding it fails the run and does not affect the host process. |
| R-VM.13 | `console` calls are captured in order; `log` entries are verbatim, other levels are prefixed `[<level>] `. |
| R-VM.14 | Host calls still in flight at teardown complete on the host; their results are discarded and never touch a disposed runtime. |
| R-VM.15 | Bundling turns TypeScript or JavaScript into one ESM module whose only imports are `seven:*`. Bare imports are installed into the dependency cache with install scripts disabled, then inlined. Imports of Node built-ins are refused. |
| R-VM.16 | The host modules are given in full to every run. The VM performs no permission checks. |

## Limits

R-VM.12 bounds QuickJS's heap only. A WASI module run through `seven:wasm`
executes on the host's wasm engine, outside that cap and outside R-VM.10's
interrupt.
