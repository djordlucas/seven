# Runner contract

Requirements `R-RUN.*` define what the runner guarantees to the code it runs and
to the program embedding it. `docs/runner.md` describes the same behavior for
users; this document is the version tests are written against.

## Requirements

| ID | Requirement |
|----|-------------|
| R-RUN.1 | Each run executes in a new Node.js child process. No in-memory state survives from one run to another. |
| R-RUN.2 | The child's working directory is the runner's `cwd`, and its environment is the seven process's environment. |
| R-RUN.3 | The run file is under `home`, and `home` has a `package.json` with `"type": "module"`, so the file is an ES module that resolves packages from `home/node_modules`. |
| R-RUN.4 | TypeScript is accepted, including syntax that requires transformation (enums, namespaces). |
| R-RUN.5 | A default export that is a function is called once with the run's arguments (default `{}`) and awaited; any other default export is awaited and is the result; no default export yields `null`. |
| R-RUN.6 | The result is the JSON round-trip of the returned value; `undefined` becomes `null`. A value `JSON.stringify` rejects fails the run with that error. |
| R-RUN.7 | A thrown or rejected error yields `ok: false` and `error` = the error's stack, or `Name: message` when there is none. |
| R-RUN.8 | Before spawning, every bare, non-built-in import found statically or as a literal dynamic `import()`/`require()` is installed if missing, with install scripts disabled. A syntax error fails the run without spawning. |
| R-RUN.9 | When the result arrives, the child's whole process group is killed. Open handles do not extend a run. |
| R-RUN.10 | At the run's deadline the process group is killed and the run fails with `timed out after <N>ms`. |
| R-RUN.11 | A child that exits before sending a result fails the run with `process exited (code <N>)` or `(signal <S>)`, followed by up to the last 20 stderr lines. |
| R-RUN.12 | The child's V8 heap is capped at `memoryMb` (default 1024). |
| R-RUN.13 | stdout and stderr are captured as lines in arrival order; stderr lines are prefixed `[stderr] `. Capture stops at 1,000,000 characters and a final line counts the lines dropped. |
| R-RUN.14 | `seven.<m>.<f>(...args)` in the child calls host function `<m>.<f>` in the parent with JSON arguments and resolves with its JSON result. A failure, or a missing function, rejects with an `Error` whose message starts `seven.<m>.<f>: `. Neither `seven` nor `seven.<m>` is thenable. |
| R-RUN.15 | The runner performs no permission checks. |
| R-RUN.16 | Starting a run returns a handle before installation or spawning completes. `handle.logs()` returns the complete output lines captured so far. |
| R-RUN.17 | `handle.kill()` before the result arrives kills the process group, or cancels the run before spawning if it is still installing; the run's result is `ok: false`, `error: "killed"`. After the result arrives it has no effect. |
| R-RUN.18 | When the seven process exits, the process group of every run still alive is killed. |

## Limits

R-RUN.9 and R-RUN.10 reach only processes in the child's process group; a
descendant that starts a new session is not killed.
