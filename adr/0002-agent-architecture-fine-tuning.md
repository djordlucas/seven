# 0002: Agent architecture fine tuning

Status: **proposed** — requirements recorded below with a proposed design
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
| R1 | The supervisor can run autonomously — "like a process", besides the interactive root agent — in three kinds of work: **until a goal is attained**, **until a task is done**, or **periodically**. Controlled through messages (an agent conversation) or a UI control, and persisted, so a seven restart does not stop it. **Extended: the same capability applies to sub-agents** — a job can be attached to any existing agent (not only a freshly spawned worker), and any agent can start/stop jobs on itself or others. | maintainer, design session on `feat/agent-architecture-fine-tuning` |

## Proposed design for R1

Term: **job** (the maintainer suggested "process mode"; "process" already means
the runner's child processes, so `job` is used). A job is an autonomous work
item driven by the supervisor, attached to an agent.

| Kind | Behaviour |
|------|-----------|
| `task` | The agent gets the task once; when it answers, the job is `done` with that answer as its result. |
| `goal` | The agent works turn after turn toward the goal; after each turn the supervisor makes one model call to judge whether the goal is met (YES/NO + summary). Met → `done` with the summary; `max_turns` reached → `failed`. |
| `periodic` | The agent is woken every `interval_s` with its standing instructions, until stopped. |

| Element | Design |
|---------|--------|
| State | New `jobs` table in `seven.db` (schema v1 → v2 migration): id `j<N>`, kind, spec JSON (task/goal text, `interval_s`, instructions, `max_turns`), `agent` (the driven agent's id — an existing sub-agent, or a freshly spawned worker when omitted), status `running\|paused\|done\|failed\|stopped`, result, error, turns, `next_run_at`, `created_by` (`user` or an agent id), timestamps. |
| Worker | `agent` given → the job drives that existing agent. Omitted → the job spawns its own worker agent (mode `continuous`, parent = creator) at start and stops it when the job ends. Root can be a target only via API (it stays user-driven otherwise). |
| Driving | The supervisor's 250 ms tick also drives running jobs: due `periodic` jobs enqueue a wake to their agent; `task`/`goal` jobs enqueue progress input; after each turn of a `goal` job's agent, the goal check runs. All work flows through the agent's existing inbox, so the agent loop and its resume semantics are unchanged. |
| Message control | New built-ins `start_job` (with optional `agent` to attach to an existing sub-agent), `stop_job`, `list_jobs`: any agent — including the root relaying a user message, or a sub-agent delegating — controls jobs through the conversation. |
| UI/REST control | `GET/POST /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/stop\|pause\|resume` (`POST /api/jobs` accepts `agent`); a Jobs view in the UI (start form + live list, showing each job's agent) and a "run a job on this agent" action in the agent pane; SSE events `job_started`, `job_updated`, `job_finished`. |
| Persistence | Jobs and agents live in `seven.db`; on start the supervisor resumes `running` jobs (honouring `next_run_at`) and the agents resume through the existing repair/resume. The lease still guarantees one runner per workspace. |

### Defaults assumed (open points)

| Point | Default | Alternative |
|-------|---------|-------------|
| Goal judgement | One supervisor-side model call per agent turn (shared client, fixed checker prompt) | Agent calls a `report_goal(met, summary)` tool — touches the agent loop |
| Worker | Existing agent when `agent` is given; otherwise a new spawned worker stopped at job end | Always spawn a dedicated worker |
| Goal safeguard | `max_turns` (default 20) → `failed` | No limit (relies on stop) |
| `created_by` | `user` via API/UI, or the calling agent id via built-in | — |

## Consequences

- `state.py` gains a v2 migration and job CRUD; `supervisor.py` gains job
  driving in `tick()` plus start/stop/pause/resume and per-agent attachment;
  `builtins/` gains `start_job`/`stop_job`/`list_jobs`; `api.py` and
  `seven/ui/` gain the Jobs surface and per-agent job actions; `docs/`
  (agents, api, ui, architecture) updated in the same change.
- The agent loop (`agent.py`) is unchanged; jobs drive agents through their
  inboxes.

## Limits

| Limit | Detail |
|-------|--------|
| One runner per workspace | Jobs only progress in the process holding the lease; elsewhere they stay persisted. |
| Goal judgement is model-based | The YES/NO check is another model call, with its own cost and fallibility. |
| One active job per agent | An agent runs one turn at a time; a second job on the same agent queues behind the first. |
| Placeholder design | Nothing here is implemented yet; the ADR records intent until accepted. |
