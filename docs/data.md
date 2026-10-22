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
| `.seven/tools/<name>/r<revision>.ts` | Each generated tool revision's source, the file the runner imports | Seven, from the `tools` table |
| `.seven/node_modules`, `.seven/package.json` | npm packages runs import | The runner's installs |
| `.seven/logs/seven.log`, `seven.log.1` | The structured log (`logging.md`) | Seven |
| `.seven/tmp/` | Temporary files for `run_js` and trial runs, deleted after the run | The runner |
| anything else | The agents' files and databases | Agents and tools |

## State database

`seven.db` uses WAL mode, so `seven agents` and `seven send` read and write it
while another process runs agents.

| Table | One row per |
|-------|-------------|
| `agents` | Agent: id, name, description, instructions, parent, mode, status, interval, step limit, result, error, times; the summary of its compacted messages, where its context starts, and how often it was compacted |
| `messages` | Message in an agent's conversation, in order, as sent to the model; compacted ones stay |
| `inbox` | Task or message queued for an agent, with its sender and when it was delivered |
| `tools` | Generated tool: definition, source, revision, run limit, disabled reason |
| `tool_runs` | Finished run of a generated tool: revision, calling agent, sync or async, outcome, duration, first error line; the newest 100 per tool are kept |
| `runs` | Background run: agent, tool, status, result, last 500 output lines |
| `lease` | The process running agents, and its last heartbeat |
| `meta` | Schema version and the counters behind agent and run ids |

The schema is at version 2. A database is created at version 1 and brought up
to date by migrations, in order, in one transaction when seven opens it; one
from a newer seven is refused.

## Agent and tool databases

| From | Use |
|------|-----|
| An agent | The `sql` built-in: `db` (a path relative to the workspace), `query`, and `params` (an array, for `?`) or `named` (an object, for `:name`). A query that returns rows gives up to 200 of them as JSON; any other statement gives `changes` and `lastInsertRowid`; several statements without parameters are run together. |
| A run (a tool, `run_js`) | `seven.db(path)` returns a `node:sqlite` `DatabaseSync` on that file, created with its directories if needed. |

Both resolve the path against the workspace, create the file if it is missing,
and refuse a path outside the workspace or naming `.seven/seven.db`. A run can
still open any file through `node:sqlite` directly; the refusal is a guard
against mistakes, not a permission.

## Limits

| Limit | Detail |
|-------|--------|
| No downgrade | Migrations only go forward; an older seven refuses a database a newer one migrated. |
| No pruning of conversations or inboxes | `messages` and `inbox` grow for as long as an agent lives, compacted messages included; `/reset` clears only the root agent's conversation and summary. |
| `sql` opens a connection per call | No connection is kept between calls; a transaction cannot span calls. |
