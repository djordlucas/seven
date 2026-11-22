# Seven — working agreement

## Branching & pull requests

**Every change goes on a feature branch with a pull request. Never commit
directly to `main`.**

1. **Branch first:** `git checkout -b <type>/<slug>` — `fix/…`, `feat/…`,
   `chore/…`, `docs/…`. (`git checkout -b` carries any uncommitted work over, so
   it is safe to branch after you have started editing.)
2. **Commit on the branch**, not on `main`. Commit subjects follow
   `<type>(<scope>): <summary>` — `feat(agent): …`, `fix(api): …`, `docs: …`.
3. **Push and open a PR:** `git push -u origin HEAD && gh pr create --fill`.
   Work reaches `main` by merging the PR, never by a local commit to `main`.

A `PreToolUse` hook (`.claude/hooks/branch-guard.sh`, wired in
`.claude/settings.json`) enforces this by **blocking `git commit` while HEAD is
on `main`**. If you hit that block, you are on `main` — branch and retry.

## Architecture at a glance

Seven is one Python process — a FastAPI app — running many agents, with all
state in one SQLite file:

- **The API** (`seven/api.py`) is the way in: REST under `/api/…` (agents,
  messages, tools, runs, logs, config, exec, events), SSE at `/api/events`, and
  the companion UI (`seven/ui/`, vanilla JS, no build) served at `/`. The CLI
  (`seven/__main__.py`) holds the workspace **lease** for `serve`; the other
  commands read the state database or the log directly, so they work while a
  server runs.
- **The supervisor** (`seven/supervisor.py`) runs every **agent**'s loop
  (`seven/agent.py`) concurrently, driving them from their **inboxes**.
  `docs/agents.md` has the modes and messaging.
- Every agent calls **Mistral** (`seven/llm.py`) through one client capped at
  `SEVEN_LLM_CONCURRENCY` calls, with the built-ins (`seven/builtins/`) plus
  every **generated tool** in the **tool store** (`seven/tools.py`). The store
  is read every model step, so a tool any agent defines is callable by all on
  their next step.
- **State** — agents, conversations, inboxes, tools, runs, the lease — is
  `<workspace>/.seven/seven.db` (`seven/state.py`, `sqlite3`, WAL). All data
  lives in the workspace (`docs/data.md`).
- Built-in and generated code runs in the **runner** (`seven/runner.py` +
  `seven/_child.py`): one Python child process per run, killed with its process
  group when the result is back, pip packages installed on demand. The runner
  has **no permission model** by design (`docs/runner.md`).

## Changes that cross layers

- **Adding a host function** (`seven.<module>.<fn>` in a run) touches four
  places in lockstep: the `host` map in `seven/app.py` passed to the runner, a
  test in `tests/test_runner.py` that calls it from a run, the system prompt
  (`seven/prompt.py`) — the model only uses what it is told exists — and the
  host function table in `docs/runner.md`. Most capabilities need none of this:
  a run already has all of Python.
- **Adding a built-in tool** touches `seven/builtins/` (one entry), the
  built-in table in `docs/architecture.md`, the system prompt in
  `seven/prompt.py`, and a test in `tests/test_builtins.py` or
  `tests/test_agent.py`. The API mirrors built-ins where it makes sense
  (`/api/tools/{name}/call`, `/api/exec`); keep `docs/api.md` in step.
- **Adding an API route** means a UI surface for it in `seven/ui/app.js` and a
  row in `docs/api.md` — the UI is feature-complete by agreement.
- **Logging is part of a component.** Take a `Logger` (`seven/log.py`), narrow
  it with `child()` to what you are working on (agent, turn, run…), log each
  state change at `info`, failures at `warn`/`error`, and content only at
  `debug` through `preview()`. Never log the API key. A new `msg` goes in the
  catalogue in `docs/logging.md`.
- **`docs/` is the source of truth.** It holds the intended behavior; treat a
  code/doc mismatch as a bug to reconcile, not a doc to quietly follow.
- **`docs/` describes the present; `adr/` records how it got there.** Design
  notes and decisions live in `adr/`, which may cite code freely. When a plan
  in `adr/` ships, its behavior is absorbed into `docs/` and the plan stays
  put as the record.

## Documentation style

**`DOCS_STYLE.md` governs every Markdown file in this repo. Read it before
writing or editing one.** A `PreToolUse` hook
(`.claude/hooks/docs-style-guard.sh`) surfaces its rules on every `.md` read or
edit. In short: conclusion first, every sentence carries a fact, headings name
their subject, tables for anything with more than one attribute, a `## Limits`
section last, and no superseded content.

## Commit discipline

**Always verify before committing: `make ci`.** It runs ruff, the tests
(`pytest`) and the eval suite (`evals/run.py`), so the result does not depend
on the machine. The suites script the model (`tests/fake_model.py`) and run
real child processes; nothing in them calls Mistral or the network. A change
that does not pass is not ready to commit.

GitHub Actions is not set up for this repository; the local gate is the only
gate.

## Python

- Python **3.11+** (`pyproject.toml`); the package is `seven/`, tests in
  `tests/` with `pytest` + `pytest-asyncio` (`asyncio_mode = "auto"` in
  `pyproject.toml`).
- One `sqlite3` connection per process, WAL mode, guarded by a lock; all API
  handlers are `async def` so they share the one event loop with the agents.
- The runner spawns `python -m seven._child` per run; the request crosses on
  stdin, host calls and the result on a passed fd, stdout/stderr are the run's
  captured output.
- Configuration comes from the environment (`seven/config.py`); a `.env` file
  in the current directory is also read, without overriding variables already
  set in the environment (compose passes `.env` through `env_file` as well).

## Docker

`Dockerfile` builds one `python:3.12-slim` image that serves on 8000;
`compose.yaml` mounts `./workspace` and reads `.env`.
