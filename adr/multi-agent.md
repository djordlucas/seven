# Multi-agent seven and SQLite state

**Status:** Implemented — **Date:** 2026-10-21
**Scope:** `src/agent/supervisor.ts`, `src/agent/builtins/agents.ts`, `src/state/db.ts`, `src/agent/builtins/sql.ts`

Seven went from one in-memory conversation per process to any number of
agents running concurrently, each with a persisted conversation and inbox, all
in one SQLite database in the workspace. The requirements were: agents spawn
agents for concurrent and parallel work; an agent's loop runs for a request, a
sequence, or continuously; agents list, find and message one another; seven
persists in SQLite; agents and tools use SQLite in separate, arbitrary
databases; and all data lives in the workspace.

## Decisions

| Decision | Chosen | Alternatives and why not |
|----------|--------|--------------------------|
| Where agents run | All in the seven process, as concurrent async loops | A process per agent would isolate crashes, but every agent's work is already a model call (I/O) or a child-process run; one process keeps the shared tool store, model rate limit and state database simple. |
| SQLite library | `node:sqlite` (built into Node 24) | `better-sqlite3` is a native add-on and another dependency; `node:sqlite` is synchronous, supports WAL, and emits only an ExperimentalWarning. |
| How messages reach agents | Inbox rows, polled every 250 ms | An in-process event bus would be instant but would not see `seven send` from another process; polling one indexed query per agent covers both. |
| When a message is read | At the start of every step, and as the input of an idle continuous agent's turn | Interrupting a model call or a tool run mid-flight would lose work; a step boundary is the earliest safe point. |
| Request/sequence results | Sent to the parent as a message automatically | Requiring the child to call `send_message` would lose results whenever a model forgot to. |
| Tool storage | Rows in the state database; each revision's source written to `.seven/tools/<name>/r<rev>.ts` | The runner imports a file, so a file must exist; keeping the database as the record satisfies "seven persists in SQLite". |
| One process per workspace | A lease row with a 5 s heartbeat | Two processes driving the same inboxes would run turns twice. |
| `SEVEN_HOME` | Removed; seven's data is `<workspace>/.seven` | "All data lives in the workspace"; the runtime image's separate `/data` volume went with it. |
| Agent databases | `sql` built-in and `seven.db(path)` in runs, any file in the workspace except the state database | Exposing seven's own database to agents would let a tool corrupt the supervisor's state. |
| Doc name | `docs/multi-agent.md`, not `docs/agents.md` | macOS filesystems are case-insensitive, and tooling loads a file named `AGENTS.md` as agent instructions. |

## Limits

This record describes the change as of its commit. Present behavior is in
`docs/multi-agent.md`, `docs/data.md` and `spec/contracts/agents.md`.
