# Logging

Every component of seven writes structured log lines, one JSON object per line,
to `<workspace>/.seven/logs/seven.log`. Each line carries the context it
belongs to — the agent, the turn, the step, the tool call, the run — so one
agent's turn, or one run, can be followed from start to finish. The API reads
them at `GET /api/logs`; `seven logs` filters and prints the file; `seven serve`
also writes the lines to stderr, so `docker logs` shows them.

```bash
seven logs                          # last 100 lines, readable
seven logs --agent a2 -f            # one agent, following new lines
seven logs --level warn --tail 0    # every warning and error in the file
curl "localhost:8000/api/logs?grep=turn&tail=50"
```

## Line format

```json
{"t":"2026-10-21T14:05:09.123Z","level":"info","msg":"tool called","pid":4242,"agent":"a1","turn":"3f2a1b9c","step":2,"call":"k1","tool":"run_python","kind":"builtin","ok":true,"duration_ms":105,"result_chars":19}
```

| Field | On | Meaning |
|-------|----|---------|
| `t`, `level`, `msg` | Every line | Time (ISO 8601, UTC), level, what happened |
| `pid` | Every line | The seven process; changes across restarts |
| `component` | Lines not about one agent's turn | `supervisor`, `runs` (background runs), `runner` or `host` |
| `agent` | Everything an agent does | Agent id: `seven`, `a1`, … |
| `turn` | Everything in one turn | 8-character id, new for every turn |
| `step` | Everything in one step | 1-based step number within the turn |
| `call` | Everything one tool call does | The model's tool call id |
| `run_id` | Everything one run does | 8-character id of a child-process run, synchronous or background |
| `run` | Background runs | The run id the agent sees: `r1`, `r2`, … |
| `tool`, `revision`, `mode` | Runs of a generated tool | Its name, revision, and `sync`, `async` or `trial` |
| `duration_ms` | Anything timed | Wall-clock duration |
| `error`, `error_stack` | Failures | Message, and the exception when there is one |

## Levels

| Level | Logged |
|-------|--------|
| `error` | A compaction that failed, a model call that failed for good, a turn that ended in an error, a failed agent, a package install that failed, a run that could not start, an uncaught exception |
| `warn` | A context overflow, a compaction with nothing to fold, a retried model call, a failed tool call, a run that timed out or exited without a result, a refused spawn, a disabled tool, a turn stopped at its step limit, runs lost to a restart, a lease held by another process |
| `info` | Every turn, compaction, model reply, tool call, run, host call, message, spawn and end of an agent, tool change, and process start and stop |
| `debug` | Previews of content: the input of a turn, the last message sent to the model, the model's reply text, tool arguments and results, a new summary — each cut to 500 characters |

The default level is `info`. Content appears at `debug` only. The API key is
never logged at any level.

## Reading the log

| Where | Shows |
|-------|-------|
| `seven logs --agent <id>` / `--turn <id>` / `--run <id>` | Lines of one agent / turn / run (a background run id or a `run_id`) |
| `seven logs --level <level>` | Lines at that level or above |
| `seven logs --grep <text>` | Lines containing the text, case-insensitive |
| `seven logs --tail <n>` | The last `n` matching lines (default 100; `0` for all) |
| `seven logs -f` | Then keeps printing new matching lines until interrupted |
| `seven logs --json` | Raw JSON lines instead of the readable form |
| `GET /api/logs` | The same filters as query parameters |

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `SEVEN_LOG_LEVEL` | `info` | Lowest level written: `debug`, `info`, `warn` or `error`. |
| `SEVEN_LOG_FILE` | `.seven/logs/seven.log` | Log file, relative to the workspace; `off` writes no file. |
| `SEVEN_LOG_STDERR` | `1` for `seven serve`, else `0` | Also write the JSON lines to stderr. |

The file is appended to synchronously, so a crash loses no line already
logged. At 50 MiB it is renamed to `seven.log.1`, replacing the previous one,
and a new file is started; both readers read both files.

## Limits

| Limit | Detail |
|-------|--------|
| One rotated file | Only `seven.log` and `seven.log.1` are kept, so at most about 100 MiB of history. |
| No log of what runs print | A run's stdout and stderr are returned to the agent and stored with background runs, not written to the log; the log has only their line count. |
| No metrics | Durations and token counts are in the lines, but nothing aggregates them. |
| Content previews are cut | `debug` previews stop at 500 characters; the full conversation is in the state database's `messages` table. |
