# 0002: Agent architecture fine tuning

Status: **accepted** — implemented on `feat/implement-r1-r5` (R1–R5, state
schema v2, 35 built-ins, API + UI surfaces, `evals/run.py`; gate `make ci`
= ruff + pytest + evals).

## Context

The Python/FastAPI reset ([0001](0001-python-fastapi-reset.md)) is merged
(PR #14). Seven runs as one FastAPI process: supervisor and agent loops in
asyncio, one Mistral client, built-ins plus generated tools, a Python
child-process runner, SQLite state in `.seven/seven.db`, REST + SSE + UI.

## Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| R1 | The supervisor can run autonomously — "like a process", besides the interactive root agent — in three kinds of work: **until a goal is attained**, **until a task is done**, or **periodically**. Controlled through messages (an agent conversation or a message to the supervisor) or a UI control, and persisted, so a seven restart does not stop it. Extended: the same capability applies to **sub-agents** — a job can attach to an existing agent, and any agent can start/stop jobs **on itself**; assigning a job to **another** agent is the supervisor's job (a message to the `supervisor` peer, or the API/UI). | maintainer, design session on `feat/agent-architecture-fine-tuning` |
| R2 | **Every message peer — the supervisor and every agent (root or sub) — has a persisted inbox and outbox**, so agent-to-agent and agent-to-supervisor communication is first-class: sending records both sides, and either side can read what it received and what it sent. | maintainer, design session on `feat/agent-architecture-fine-tuning` |
| R3 | **Efficient use of context**: (a) long tool output is spilled to memory and read back by chunks instead of entering the conversation whole; (b) the full tool-schema set is not sent every step — tools are exposed through discovery or skills; (c) work is delegated to sub-agents when possible, so only their final answer enters the parent's context. | maintainer, design session on `feat/agent-architecture-fine-tuning` |
| R4 | **Skills are a first-class concept** (refining R3b): a skill lists tools (plus description and instructions); **a tool used in a skill cannot be deleted — the skill must be changed first**; skills get **full CRUD from both the user (API/UI) and the model (built-ins)**. | maintainer, design session on `feat/agent-architecture-fine-tuning` |
| R5 | **An eval suite confirms that all features work end to end** — not just unit-level, but whole flows across layers (agent turns, jobs, mail, memory, discovery, skills, delegation, runner, API/UI), deterministically and without network or an API key. | maintainer, design session on `feat/agent-architecture-fine-tuning` |

## State & migration (v2)

One migration, v1 → v2, in one transaction:

| Change | Detail |
|--------|--------|
| New tables | `jobs` (R1), `outbox` (R2), `skills` (R4), `outputs` (R3a: call/run id, agent, tool, chars, lines, path, created_at) |
| `agents` rebuild | SQLite cannot ALTER a CHECK, so the table is rebuilt: new table with `mode` CHECK extended by `supervisor`, plus columns `loaded_skills` and `revealed_tools` (both JSON arrays, default `[]`); copy rows; drop; rename; insert the `supervisor` peer row (id `supervisor`, mode `supervisor`). |
| Counters | `meta` gains `job_seq`; `outputs` keys on the call/run id, `outbox` links to its `inbox` row. |
| Mail write path | One `State.send(sender, recipient, kind, text)` inserts the inbox row and the outbox row (with `inbox_id`) in one transaction. |

## Proposed design for R1

Term: **job** (the maintainer suggested "process mode"; "process" already means
the runner's child processes, so `job` is used). A job is an autonomous work
item driven by the supervisor, attached to an agent.

| Kind | Behaviour |
|------|-----------|
| `task` | The agent gets the task once (an inbox **task**); when it answers, the job is `done` with that answer as its result. |
| `goal` | The agent works turn after turn toward the goal (repeated task items with progress context); after each completed turn the supervisor runs one goal-check model call (YES/NO + summary). Met → `done` with the summary; `max_turns` → `failed`. |
| `periodic` | The agent is woken every `interval_s` with its standing instructions, until stopped. Only allowed on `continuous` agents or a job-spawned worker. |

| Element | Design |
|---------|--------|
| `jobs` row | id `j<N>`, kind, spec JSON (task/goal text, `interval_s`, instructions, `max_turns` default 20), `agent`, status `running\|paused\|done\|failed\|stopped`, result, error, turns, `next_run_at`, `created_by` (`user` or an agent id), timestamps. |
| Worker | `agent` given → the job drives that existing agent. Omitted → the job spawns its own worker (mode `continuous`, parent = creator) at start and stops it when the job ends. **The root is never a job target** — it is user-driven. |
| Assignment scope | Who may point a job at which agent: through the built-ins, an agent may only target **itself** (`agent` = the caller's id, or omitted → a spawned worker); anything else is refused with `error: only the supervisor can assign a job to another agent`. Supervisor-originated jobs (message to the `supervisor` peer, API/UI as `user`) may target any sub-agent. `stop_job` follows the same rule: agents stop their own jobs, the supervisor stops any. |
| Job × agent mode | `task`/`goal` enqueue task items, which every mode consumes; `periodic` requires a `continuous` agent (given or spawned). |
| Driving | The supervisor's 250 ms tick also drives running jobs: due `periodic` jobs enqueue a wake; `task`/`goal` jobs enqueue progress input when their agent is idle. Work flows through the agent's inbox, so the agent loop and its resume semantics are unchanged. |
| Turn detection & goal check | The tick watches each goal job's agent: when its `turns`/`last_turn_at` advances and it is idle, run the goal check (one model call, fixed checker prompt, shared client). A restart simply re-arms from `next_run_at` — the check is idempotent. |
| Completion & stop | On `done`/`failed`/`stopped` the supervisor sends the `created_by` a message through the R2 mail system (`job j1 done: …` / `failed: …`), recorded in its outbox. `stop` on a running job interrupts the worker's turn (existing `interrupt()`), kills its background runs, and marks the job `stopped`. `pause`/`resume` just flip status. |
| Message control | Built-ins `start_job`, `stop_job`, `list_jobs` (assignment scope above); plus messages **to the `supervisor` peer** as line-based control commands (R2). Any agent — root relaying the user, or a sub-agent running a job on itself — controls jobs through the conversation. |
| UI/REST control | `GET/POST /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/stop\|pause\|resume` (`POST /api/jobs` accepts `agent` — supervisor-level, so any sub-agent, never the root); a Jobs view in the UI and a "run a job on this agent" action in the agent pane; SSE events `job_started`, `job_updated`, `job_finished`. |
| Persistence | Jobs and agents live in `seven.db`; on start the supervisor resumes `running` jobs (honouring `next_run_at`) and agents resume through the existing repair/resume. The lease still guarantees one runner per workspace. |

## Proposed design for R2

Messaging becomes a two-sided mailbox per peer; peers are `supervisor` plus
every agent id.

| Element | Design |
|---------|--------|
| Peers | Reserved peer id `supervisor` (agents row, mode `supervisor`; the driver tick skips it — never model-driven; `stop_agent` refuses it; it appears in `list_agents`). `resolve`/`send_message` accept it like any agent. |
| Inbox | The existing `inbox` table, now also for `agent = 'supervisor'`. Agent delivery semantics unchanged; the supervisor consumes its own inbox in its tick. `POST /api/agents/supervisor/messages` only queues a control message — no turn is started. |
| Outbox | `outbox` table: id, `sender`, `recipient`, `kind`, `text`, `created_at`, `inbox_id` (link to the recipient's inbox row, so delivery state is shared). Written by the single `State.send()` in one transaction — used by `send_message`, `seven send`, the API, and supervisor-originated messages. |
| Supervisor inbox as control channel | Line-based commands consumed by the supervisor tick: `start job <kind> …`, `stop <job>`, `pause\|resume <job>`, `jobs`, `agents`, `status`. Unknown text stays in the inbox and is answered with an error message to the sender, recorded in the supervisor's outbox. |
| Agent-facing built-ins | `send_message`/`wait_message` accept `supervisor` as `to`/`from`. New `list_inbox` (pending, then recent delivered) and `list_outbox` (recent sent, with delivered state). |
| API / UI | `GET /api/agents/{id}/outbox` alongside `/inbox`; `/api/agents/supervisor/…` works for mail; the UI agent pane gains Inbox/Outbox tabs; the agents list includes the supervisor peer; SSE `message` events carry sender/recipient. |

## Proposed design for R3

Three mechanisms; (a) and (b) change the agent loop's request/result handling,
(c) adds a delegation primitive.

| Part | Design |
|------|--------|
| (a) Output memory | Tool results longer than `SEVEN_SPILL_CHARS` (default 2,000 **characters**) are spilled whole to `.seven/memory/<call_id>.out` (indexed in `outputs`); the `tool` message carries only a reference: `output saved to memory <call_id> (N chars, M lines); read chunks with read_memory("<call_id>", from, to)`. **Background-run output spills the same way** (`.seven/memory/r<N>.out`); `run_status` shows reference + short tail. New core built-in `read_memory(id, offset=0, limit=4000)` returns a character window with total size and next-offset hint. Shorter results stay inline, still capped at 16,000 chars. Nothing is lost — the 16k hard cut becomes spill + reference for anything long. |
| (b) Discovery / skills | Every step sends only a **core set** — `run_python`, `define_tool`, `read_tool`, `delegate`, `send_message`, `wait_message`, `spawn_agent`, `read_memory` — plus meta-tools `list_tools`, `describe_tool`, `list_skills`, `load_skill`/`unload_skill`. Everything else (run-control built-ins, `sql`, all generated tools) is discoverable: `list_tools(query?)` lists name+description, `describe_tool(name)` returns the full schema **and appends the name to the caller's persisted `revealed_tools`**, so it stays callable from the next step on; `list_tools` marks which tools are revealed or in a loaded skill. Skills are specified in R4. |
| (c) Delegation | Core built-in `delegate(task, instructions?, name?)`: spawns a `request` sub-agent, waits for its final answer (`wait_message` from it, up to `SEVEN_DELEGATE_TIMEOUT_S`, default 600), returns **only the final answer** (spilled per (a) if long), and stops the sub-agent. On timeout or sub-agent failure the sub-agent is stopped and `delegate` returns `error: …`. The sub-agent's transcript never enters the parent's context. The system prompt steers delegation for long or independent sub-tasks. Counts toward `SEVEN_MAX_AGENTS` while running. |

## Proposed design for R4 (skills)

A skill is a named bundle of **generated tools plus description and
instructions**.

| Element | Design |
|---------|--------|
| `skills` row | `name` PK (same `^[a-z][a-z0-9_]{0,63}$` rule as tools), `description`, `instructions`, `tools` (JSON array of **generated-tool names only** — built-ins are already core or discoverable), `created_at`, `updated_at`. |
| Model CRUD (built-ins) | `define_skill(name, description, instructions, tools[])` creates or replaces (upsert, tracked by `updated_at` only — no revision counter); validates the name rule and that **every listed tool exists** (missing ones named in the error). `read_skill(name)` returns the definition plus the caller's loaded flag. `list_skills()` lists all with the caller's loaded flag. `delete_skill(name)` deletes and scrubs the name from every agent's `loaded_skills` in one transaction. `load_skill(name)` / `unload_skill(name)` manage the caller's persisted `loaded_skills`; unknown name → clear error. A loaded skill's tool schemas are sent from the next step and its instructions join the system prompt; because the tool list is resolved from the skill row each step, loaded agents pick up skill edits automatically. |
| User CRUD (API/UI) | `GET /api/skills`, `POST /api/skills` (upsert, same validation), `GET /api/skills/{name}`, `DELETE /api/skills/{name}`. UI: a Skills view with an editor (name, description, instructions, tools chosen from existing tools) and delete; the agent pane can load/unload a skill for that agent; the tool detail shows which skills use a tool. |
| Delete protection | `ToolStore.remove(name)` (behind `delete_tool` and `DELETE /api/tools/{name}`) refuses while any skill lists the tool: `error: tool "x" is used by skill(s) a, b — change the skill first (define_skill without x) or delete_skill`. Containment via `json_each(skills.tools)`. Redefining (`define_tool`) and disabling are **not** blocked — only deletion. |
| Prompt | The system prompt lists skills by name + description (small) and appends the instructions of loaded skills; skill tools' schemas are sent only while loaded. |
| Events | `skill_defined`, `skill_deleted`, `skill_loaded`, `skill_unloaded` join the SSE stream. |

## Proposed design for R5 (eval suite)

An `evals/` directory next to `tests/`, run by `make eval` (and included in
`make ci`): each eval is a small scripted scenario — a fresh temp workspace, a
SevenApp with the **scripted model** from `tests/fake_model.py` (deterministic
replies, no network, no API key), actions (API calls, built-in calls, CLI
commands, simulated restarts), and assertions on API responses, DB rows and
emitted events. A run prints one line per eval (pass/fail, duration) and exits
non-zero on any failure; failed evals keep their workspace for inspection.

| Coverage | Evals |
|----------|-------|
| Base loop | agent turn with tool calls; `run_python` sync/async; background runs + kill; restart resume (`repair`); API happy paths; SSE events |
| R1 | `task` job done + mailed to creator; `goal` job loop with scripted YES/NO checks → done, and `max_turns` → failed; `periodic` wake honoring `next_run_at`; job restart resume; supervisor command via a message to `supervisor`; assignment-scope refusal (agent → other agent) |
| R2 | send → inbox + outbox rows in one tx; `list_inbox`/`list_outbox`; delivered flag propagation; supervisor peer send/receive; unknown command answered with an error message |
| R3 | result over `SEVEN_SPILL_CHARS` spills to `.seven/memory/` and the `tool` message carries the reference; `read_memory` chunk round-trip; `describe_tool` persists into `revealed_tools`; `SEVEN_TOOL_DISCOVERY=0` restores full schemas; `delegate` returns only the final answer, stops the sub-agent, times out → `error:` |
| R4 | `define_skill` validation (unknown tool refused); full CRUD via built-ins and `/api/skills`; `delete_tool` refused while a skill uses it, allowed after the skill changes; `load_skill`/`unload_skill` persisted per agent and reflected in the next request's tool list |

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `SEVEN_SPILL_CHARS` | `2000` | Tool/run output longer than this (chars) spills to memory instead of the conversation. |
| `SEVEN_MEMORY_DIR` | `.seven/memory` | Where spilled output lives, relative to the workspace. |
| `SEVEN_CORE_TOOLS` | the core list above | Tool names always sent as schemas; overridable. |
| `SEVEN_TOOL_DISCOVERY` | `1` | `0` restores sending every tool schema every step. |
| `SEVEN_DELEGATE_TIMEOUT_S` | `600` | How long `delegate` waits for the sub-agent's final answer. |

## Consequences

- `state.py`: the v2 migration above; `send()`; job/skill/output CRUD.
- `agent.py` (first change to the loop): dispatch spills long results and
  appends the reference; `context()` sends core + meta tools + revealed tools
  + loaded skills' tools; the system prompt describes discovery, skills and
  delegation.
- `supervisor.py`: job driving in `tick()`, turn detection and goal checks,
  supervisor-inbox command grammar, per-agent attachment, start/stop/pause/resume.
- `builtins/`: `start_job`/`stop_job`/`list_jobs`/`list_inbox`/`list_outbox`/
  `read_memory`/`list_tools`/`describe_tool`/`define_skill`/`read_skill`/
  `list_skills`/`delete_skill`/`load_skill`/`unload_skill`/`delegate`;
  `send_message`/`wait_message` accept `supervisor`; `delete_tool` refuses
  tools referenced by a skill.
- `api.py` + `seven/ui/`: `/api/jobs`, `/api/skills` (full CRUD), `/api/memory/{id}`,
  outbox and supervisor-peer endpoints, Jobs/Skills views, agent-pane mail
  tabs and memory reader, load/unload per agent, tool discovery surfaces.
- `evals/` + a runner (`python -m seven.evals` or `make eval`) with the
  coverage table above; `make ci` runs pytest + ruff + evals.
- `docs/` (architecture, agents, api, ui, data, runner) and `prompt.py`
  updated in the same change.

## Verification

- Tests per requirement, no network: job lifecycle incl. restart resume and
  goal check; mail round-trip (inbox + outbox, supervisor commands); spill +
  `read_memory` round-trip; discovery reveal persistence; skills CRUD and the
  delete-protection refusal; `delegate` success and timeout.
- Eval suite (R5) confirms whole features end to end against a scripted model
  (`evals/run.py`).
- Gate: `make ci` (ruff + pytest + evals). Docs updated in the same change.

## Limits

| Limit | Detail |
|-------|--------|
| One runner per workspace | Jobs and supervisor-inbox processing only progress in the lease-holding process; elsewhere they stay persisted. |
| The root is never a job target | Jobs drive sub-agents or spawned workers; the root stays user-driven. |
| Job assignment scope | Sub-agents can start/stop jobs on themselves only; jobs on other agents come from the supervisor (supervisor messages, API/UI). (`delegate` in R3c is different: it spawns a throwaway request agent for one task and stops it — it does not assign a job.) |
| Goal judgement is model-based | The YES/NO check is another model call, with its own cost and fallibility. |
| One active job per agent | An agent runs one turn at a time; a second job on the same agent queues behind the first. |
| Mail is FIFO text-only | No priorities, no attachments; delivery is one `delivered_at` flag, no read receipts. |
| Discovery costs a step | The model must call `list_tools`/`describe_tool` before using a non-core tool; in exchange every step's prompt is much smaller. |
| Skills reference existing generated tools only | `define_skill` refuses unknown tool names; deleting a tool used by a skill is refused until the skill changes. |
| Loaded skills and revealed tools are per agent | Persisted per agent; changes affect only that agent's next steps. |
| Spilled output costs a read | The agent pays one `read_memory` call per chunk it actually needs. |
| Delegation hides the sub-agent's work | The parent sees only the final answer; the full transcript stays in the sub-agent's row for the UI/logs. |
| Evals are scripted, not a quality measure | The eval suite proves features work with a deterministic model; it says nothing about real-model behavior. |
| Placeholder designs | Nothing here is implemented yet; the ADR records intent until accepted. |
