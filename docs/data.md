# Data

All of seven's data lives in the workspace (`SEVEN_WORKSPACE`, default the
current directory). Seven's own state is one SQLite database,
`<workspace>/.seven/seven.db`. Agents and tools keep their data in SQLite
databases of their own, any number of them, as files elsewhere in the
workspace; seven's database is not open to them.

## Layout

| Path | Holds | Written by |
|------|-------|------------|
| `.seven/seven.db` | Seven's state (below) | Seven |
| `.seven/tools/<name>/r<revision>.py` | Each generated tool revision's source, the file the runner imports | Seven, from the `tools` table |
| `.seven/site-packages` | pip packages runs import | The runner's installs |
| `.seven/logs/seven.log`, `seven.log.1` | The structured log (`logging.md`) | Seven |
| `.seven/tmp/` | Temporary files for `run_python` and trial runs, deleted after the run | The runner |
| `.seven/memory/` (`SEVEN_MEMORY_DIR`) | Spilled tool/run output, one `<id>.out` file per spilled result | The agent loop and the run table |
| anything else | The agents' files and databases | Agents and tools |

## State database

`seven.db` uses WAL mode, so `seven agents` and `seven send` read and write it
while the server process runs agents.

| Table | One row per |
|-------|-------------|
| `agents` | Peer: id, name, description, instructions, parent, mode (incl. `supervisor`), status, interval, step limit, result, error, times; the summary of its compacted messages, where its context starts, how often it was compacted, plus its loaded skills and revealed tools (JSON). The `supervisor` row is the supervisor peer |
| `messages` | Message in an agent's conversation, in order, as sent to the model; compacted ones stay |
| `inbox` | Task or message queued for a peer, with its sender and when it was delivered |
| `outbox` | Sent item: sender, recipient, kind, text, when, and the inbox row it landed in |
| `jobs` | Job: kind (`task`/`goal`/`periodic`), spec, agent, status (`running`/`paused`/`done`/`failed`/`stopped`), result or error, turns, queued flag, last turn, next run, creator, times |
| `skills` | Skill: name, description, instructions, tools (JSON array) |
| `tools` | Generated tool: definition, source, revision, run limit, disabled reason |
| `tool_runs` | Finished run of a generated tool: revision, calling agent, sync or async, outcome, duration, first error line; the newest 100 per tool are kept |
| `runs` | Background run: agent, tool, status, result, last 500 output lines (longer output is spilled to `.seven/memory/`) |
| `outputs` | Spilled output: id (tool call id or run id), agent, tool, file path, chars, lines, when |
| `kv` | Per-agent key/value memory (`remember`/`recall`/`forget`): agent, key, value (64 KB cap), chars, when updated |
| `lease` | The process running agents, and its last heartbeat |
| `meta` | Schema version and the counters behind agent, run and job ids |

## Agent and tool databases

| From | Use |
|------|-----|
| An agent | The `sql` built-in: `db` (a path relative to the workspace), `query`, and `params` (a list, for `?`) or `named` (an object, for `:name`). A query that returns rows gives up to 200 of them as JSON; any other statement gives `changes` and `lastInsertRowid`; several statements without parameters are run together. |
| A run (a tool, `run_python`) | `seven.db(path)` returns a `sqlite3.Connection` on that file, created with its directories if needed. |

Both resolve the path against the workspace, create the file if it is missing,
and refuse a path outside the workspace or naming `.seven/seven.db`. A run can
still open any file through `sqlite3` directly; the refusal is a guard against
mistakes, not a permission.

## Limits

| Limit | Detail |
|-------|--------|
| No pruning of conversations or inboxes | `messages` and `inbox` grow for as long as an agent lives, compacted messages included; `DELETE /api/agents/{id}/conversation` clears one agent's conversation and summary. |
| `sql` opens a connection per call | No connection is kept between calls; a transaction cannot span calls. |
