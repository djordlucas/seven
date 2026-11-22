# 0001: Python + FastAPI reset

Seven was reset from a Node.js/TypeScript CLI program to a Python package that
runs as a FastAPI app: the agent, the API that controls it, and a companion
feature-complete UI in one process.

## Decision

- **Language and process model:** Python 3.11+, one process, asyncio. The CLI
  (`seven serve`) starts uvicorn; the FastAPI lifespan starts the supervisor and
  takes the workspace lease.
- **Control surface:** REST under `/api/…` plus SSE at `/api/events`, and a
  static single-page UI at `/` (vanilla JS, no build). The old interactive CLI
  is gone; `seven agents` / `send` / `tools` / `logs` remain as read-only
  commands that touch the state database or the log directly.
- **Runner:** model-written code is Python, run in one `python -m seven._child`
  process per run (`run_js` became `run_python`); npm installs became pip
  installs into `.seven/site-packages`; the V8 heap cap became `RLIMIT_AS`.
  The protocol is stdin/stdout for request and captured output, and a passed fd
  for host calls and the result.
- **Everything else carried over:** the agent loop, supervisor and inbox
  semantics, generated tools, background runs, tool health, compaction,
  structured logging, the SQLite state layout, and the lease.

## Consequences

- The agent loop and supervisor are async but share one event loop; all API
  handlers are `async def` and state access goes through one locked sqlite3
  connection.
- Tests script the model (`tests/fake_model.py`) and run real child processes;
  nothing calls Mistral or the network.
- The old `spec/` contracts were dropped; `docs/` is normative.

## Limits

| Limit | Detail |
|-------|--------|
| UI has no build step | Changes to `seven/ui/` are served as-is. |
