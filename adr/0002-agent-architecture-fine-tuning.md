# 0002: Agent architecture fine tuning

Status: **proposed** — requirement R1 recorded below with a proposed design
under discussion; no code changes until the design is accepted and this ADR
moves to accepted.

## Context

The Python/FastAPI reset ([0001](0001-python-fastapi-reset.md)) is merged
(PR #14). Seven runs as one FastAPI process: supervisor and agent loops in
asyncio, one Mistral client, built-ins plus generated tools, a Python
child-process runner, SQLite state in `.seven/seven.db`, REST + SSE + UI.

## Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| R1 | The supervisor can run autonomously — "like a process", besides the interactive root agent — in three kinds of work: **until a goal is attained**, **until a task is done**, or **periodically**. The behaviour is controllable through messages (an agent conversation) or a UI control, and is persisted, so a seven restart does not stop it. | maintainer, design session on `feat/agent-architecture-fine-tuning` |

## Proposed design for R1

Term: **job** (the maintainer suggested "process mode"; "process" already means
the runner's child processes, so `job` is used). A job is an autonomous work
item owned by the supervisor.

| Kind | Behaviour |
|------|-----------|
| `task` | Runs until the task is done: the job's worker agent gets the task once; when it answers, the job is `done` with that answer as its result. |
| `goal` | Runs until the goal is attained: the worker is given the goal and works turn after turn; after each turn the supervisor makes one model call to judge whether the goal is met (YES/NO + summary). Met → `done` with the summary; `max_turns` reached → `failed`. |
| `periodic` | Runs periodically: the worker is woken every `interval_s` with its standing instructions, until stopped. |

| Element | Design |
|---------|--------|
| State | New `jobs` table in `seven.db` (schema v1 → v2 migration): id `j<N>`, kind, spec JSON (task/goal text, `interval_s`, instructions, `max_turns`), status `running\|paused\|done\|failed\|stopped`, worker agent id, result, error, turns, `next_run_at`, `created_by` (`user` or an agent id), timestamps. |
| Worker | Each job spawns its own agent (mode `continuous`, parent = creator) when started and stops it when the job ends. |
| Driving | The supervisor's existing 250 ms tick also drives running jobs: due `periodic` jobs wake their worker; `task`/`goal` jobs message their worker; the `goal` check runs after each worker turn. No change to the agent loop. |
| Message control | New built-ins `start_job`, `stop_job`, `list_jobs`: any agent — including the root relaying a user message — can start/stop jobs through the conversation. |
| UI/REST control | `GET/POST /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/stop|pause|resume`; a Jobs view in the UI (start form + live list); SSE events `job_started`, `job_updated`, `job_finished`. |
| Persistence | Jobs and their workers live in `seven.db`; on start the supervisor resumes `running` jobs (honouring `next_run_at`) — worker turns resume through the existing agent repair/resume. The lease still guarantees one runner per workspace. |

### Defaults assumed (open points)

| Point | Default | Alternative |
|-------|---------|-------------|
| Goal judgement | One supervisor-side model call per worker turn (shared client, fixed checker prompt) | Worker calls a `report_goal(met, summary)` tool instead — touches the agent loop |
| Worker | One agent per job, stopped at job end | A shared worker agent for all jobs |
| Goal safeguard | `max_turns` (default 20) → `failed` | No limit (relies on stop) |
| `created_by` | `user` via API/UI, or the calling agent via built-in | — |

## Consequences

- `state.py` gains a v2 migration and job CRUD; `supervisor.py` gains job
  driving in `tick()` plus start/stop/pause/resume; `builtins/` gains
  `start_job`/`stop_job`/`list_jobs`; `api.py` and `seven/ui/` gain the Jobs
  surface; `docs/` (agents, api, ui, architecture) updated in the same change.
- The agent loop (`agent.py`) is unchanged.

## Limits

| Limit | Detail |
|-------|--------|
| One runner per workspace | Jobs only run in the process holding the lease; the others stay persisted. |
| Goal judgement is model-based | The YES/NO check is another model call, with its own cost and fallibility. |
| Placeholder design | Nothing here is implemented yet; the ADR records intent until accepted. |
