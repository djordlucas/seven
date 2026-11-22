# 0002: Agent architecture fine tuning

Status: **proposed** — requirements recorded below with proposed designs
under discussion; no code changes until the designs are accepted and this ADR
moves to accepted.

## Context

The Python/FastAPI reset ([0001](0001-python-fastapi-reset.md)) is merged
(PR #14). Seven runs as one FastAPI process: supervisor and agent loops in
asyncio, one Mistral client, built-ins plus generated tools, a Python
child-process runner, SQLite state in `.seven/seven.db`, REST + SSE + UI.

## Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| R1 | The supervisor can run autonomously — "like a process", besides the interactive root agent — in three kinds of work: **until a goal is attained**, **until a task is done**, or **periodically**. Controlled through messages (an agent conversation) or a UI control, and persisted, so a seven restart does not stop it. Extended: the same capability applies to **sub-agents** — a job can attach to any existing agent, and any agent can start/stop jobs on itself or others. | maintainer, design session on `feat/agent-architecture-fine-tuning` |
| R2 | **Every message peer — the supervisor and every agent (root or sub) — has a persisted inbox and outbox**, so agent-to-agent and agent-to-supervisor communication is first-class: sending records both sides, and either side can read what it received and what it sent. | maintainer, design session on `feat/agent-architecture-fine-tuning` |

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
| Message control | New built-ins `start_job` (with optional `agent` to attach to an existing sub-agent), `stop_job`, `list_jobs`. Separately, messages sent **to the supervisor** (see R2) act as control commands (see R2). Any agent — including the root relaying a user message, or a sub-agent delegating — controls jobs through the conversation. |
| UI/REST control | `GET/POST /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/stop\|pause\|resume` (`POST /api/jobs` accepts `agent`); a Jobs view in the UI (start form + live list, showing each job's agent) and a "run a job on this agent" action in the agent pane; SSE events `job_started`, `job_updated`, `job_finished`. |
| Persistence | Jobs and agents live in `seven.db`; on start the supervisor resumes `running` jobs (honouring `next_run_at`) and the agents resume through the existing repair/resume. The lease still guarantees one runner per workspace. |

## Proposed design for R2

Messaging becomes a two-sided mailbox per peer; peers are `supervisor` plus
every agent id.

| Element | Design |
|---------|--------|
| Peers | The supervisor gets a reserved peer id `supervisor` (a row in `agents` with a new mode `supervisor`; the driver tick skips it — it is never model-driven). `resolve`/`send_message` accept it like any agent; it cannot be stopped. |
| Inbox | The existing `inbox` table, now also holding items for `agent = 'supervisor'`. Delivery semantics unchanged for agents (consumed at step start / by `wait_message`); the supervisor consumes its own inbox in its tick. |
| Outbox | New `outbox` table: id, `sender`, `recipient`, `kind`, `text`, `created_at`, `inbox_id` (link to the recipient's inbox row, so delivery state is shared). One `State.send(sender, recipient, kind, text)` writes both rows in one transaction — used by `send_message`, by the user (`seven send`, API), and by supervisor-originated messages. |
| Supervisor inbox as control channel | Messages to `supervisor` are line-based commands consumed by the supervisor tick (this is R1's "controlled through messages"): `start job <kind> …`, `stop <job>`, `pause|resume <job>`, `jobs`, `agents`, `status`. Unknown text is kept in the inbox and answered with an error message to the sender (recorded in the supervisor's outbox). |
| Agent-facing built-ins | `send_message` and `wait_message` keep working and now accept `supervisor` as `to`/`from`. New built-ins `list_inbox` (pending items, then recent delivered) and `list_outbox` (recent sent, with delivered state), so an agent can read its own mail from the conversation. |
| API / UI | `GET /api/agents/{id}/outbox` alongside the existing `/inbox`; `/api/agents/supervisor/…` works for inbox/outbox/send. The UI agent pane gains Inbox and Outbox tabs; the agents list includes the supervisor peer; SSE `message` events carry sender/recipient so both panes update live. |
| Migration | Schema v2 adds `jobs` and `outbox`, rebuilds `agents` with mode CHECK extended by `supervisor`, inserts the supervisor row, and adds the `job_seq` counter — one migration, one transaction. |

### Defaults assumed (open points)

| Point | Default | Alternative |
|-------|---------|-------------|
| Goal judgement (R1) | One supervisor-side model call per agent turn (shared client, fixed checker prompt) | Agent calls a `report_goal(met, summary)` tool — touches the agent loop |
| Worker (R1) | Existing agent when `agent` is given; otherwise a new spawned worker stopped at job end | Always spawn a dedicated worker |
| Goal safeguard (R1) | `max_turns` (default 20) → `failed` | No limit (relies on stop) |
| Supervisor commands (R2) | Small fixed grammar in the supervisor tick, not free-form model interpretation | Model-driven command parsing (more flexible, more cost and drift) |
| Delivery state | `delivered_at` on the inbox row, surfaced through the outbox link; no separate read receipt | Read receipts (`read_at`) |

## Consequences

- `state.py`: v2 migration (jobs, outbox, agents rebuild + supervisor row,
  counters) and one `send()` writing inbox+outbox; `supervisor.py`: job
  driving in `tick()`, supervisor-inbox command handling, per-agent
  attachment, start/stop/pause/resume; `builtins/`: `start_job`/`stop_job`/
  `list_jobs`/`list_inbox`/`list_outbox`, `send_message`/`wait_message` accept
  `supervisor`; `api.py` + `seven/ui/`: jobs and outbox/inbox surfaces, Jobs
  view, agent-pane mail tabs; `docs/` (agents, api, ui, architecture, data)
  updated in the same change.
- The agent loop (`agent.py`) is unchanged; jobs and mail drive agents through
  their inboxes.

## Limits

| Limit | Detail |
|-------|--------|
| One runner per workspace | Jobs and supervisor-inbox processing only progress in the lease-holding process; elsewhere they stay persisted. |
| Goal judgement is model-based | The YES/NO check is another model call, with its own cost and fallibility. |
| One active job per agent | An agent runs one turn at a time; a second job on the same agent queues behind the first. |
| Mail is not a queue with priorities | Inbox is FIFO; no priorities, no attachments, text only. |
| Supervisor command grammar is fixed | Free-text commands to `supervisor` are not model-interpreted. |
| Placeholder designs | Nothing here is implemented yet; the ADR records intent until accepted. |
