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
| R3 | **Efficient use of context**: (a) long tool output is spilled to memory and read back by chunks instead of entering the conversation whole; (b) the full tool-schema set is not sent every step — tools are exposed through discovery or skills; (c) work is delegated to sub-agents when possible, so only their final answer enters the parent's context. | maintainer, design session on `feat/agent-architecture-fine-tuning` |
| R4 | **Skills are a first-class concept** (refining R3b): a skill lists tools (plus description and instructions); **a tool used in a skill cannot be deleted — the skill must be changed first**; skills get **full CRUD from both the user (API/UI) and the model (built-ins)**. | maintainer, design session on `feat/agent-architecture-fine-tuning` |

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
| Message control | New built-ins `start_job` (with optional `agent`), `stop_job`, `list_jobs`; plus messages sent **to the supervisor** as control commands (see R2). Any agent — including the root relaying a user message, or a sub-agent delegating — controls jobs through the conversation. |
| UI/REST control | `GET/POST /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/stop\|pause\|resume` (`POST /api/jobs` accepts `agent`); a Jobs view in the UI and a "run a job on this agent" action in the agent pane; SSE events `job_started`, `job_updated`, `job_finished`. |
| Persistence | Jobs and agents live in `seven.db`; on start the supervisor resumes `running` jobs (honouring `next_run_at`) and agents resume through the existing repair/resume. The lease still guarantees one runner per workspace. |

## Proposed design for R2

Messaging becomes a two-sided mailbox per peer; peers are `supervisor` plus
every agent id.

| Element | Design |
|---------|--------|
| Peers | The supervisor gets a reserved peer id `supervisor` (a row in `agents` with a new mode `supervisor`; the driver tick skips it — it is never model-driven). `resolve`/`send_message` accept it like any agent; it cannot be stopped. |
| Inbox | The existing `inbox` table, now also holding items for `agent = 'supervisor'`. Delivery semantics unchanged for agents; the supervisor consumes its own inbox in its tick. |
| Outbox | New `outbox` table: id, `sender`, `recipient`, `kind`, `text`, `created_at`, `inbox_id` (link to the recipient's inbox row, so delivery state is shared). One `State.send(sender, recipient, kind, text)` writes both rows in one transaction — used by `send_message`, `seven send`, the API, and supervisor-originated messages. |
| Supervisor inbox as control channel | Messages to `supervisor` are line-based commands consumed by the supervisor tick (R1's "controlled through messages"): `start job <kind> …`, `stop <job>`, `pause\|resume <job>`, `jobs`, `agents`, `status`. Unknown text stays in the inbox and is answered with an error message to the sender, recorded in the supervisor's outbox. |
| Agent-facing built-ins | `send_message`/`wait_message` accept `supervisor` as `to`/`from`. New built-ins `list_inbox` (pending, then recent delivered) and `list_outbox` (recent sent, with delivered state). |
| API / UI | `GET /api/agents/{id}/outbox` alongside `/inbox`; `/api/agents/supervisor/…` works for mail; the UI agent pane gains Inbox/Outbox tabs; the agents list includes the supervisor peer; SSE `message` events carry sender/recipient. |

## Proposed design for R3

Three mechanisms; (a) and (b) change the agent loop's request/result handling,
(c) adds a delegation primitive.

| Part | Design |
|------|--------|
| (a) Output memory | Tool results longer than `SEVEN_SPILL_CHARS` (default 2,000) are **not** put in the conversation whole. The full result is stored under `.seven/memory/<call_id>.out` with an index row (`outputs` table: call id, agent, tool, chars, lines, path, created_at), and the `tool` message carries only a reference: `output saved to memory <call_id> (N chars, M lines); read it in chunks with read_memory("<call_id>", from, to)`. New built-in `read_memory(id, offset=0, limit=4000)` returns a character window (with total size and a hint for the next offset). Shorter results stay inline as today. Nothing is lost — the 16,000-char truncation becomes spill + reference instead of a hard cut. |
| (b) Discovery / skills | Every step no longer sends all ~20 built-in schemas plus every generated tool's schema. A **core set** is always sent: `run_python`, `define_tool`, `read_tool`, `delegate`, `send_message`, `wait_message`, `spawn_agent`, `read_memory`, plus the meta-tools `list_tools`, `describe_tool`, `list_skills`, `load_skill`/`unload_skill`. Everything else (the run-control built-ins, `sql`, all generated tools) is discoverable: `list_tools(query?)` lists name+description, `describe_tool(name)` returns the full schema, and from the next step the tool is callable. Skills themselves are specified in R4. |
| (c) Delegation | New built-in `delegate(task, instructions?, name?)`: spawns a `request` sub-agent with the task, waits for its final answer (`wait_message` from it), returns **only the final answer** (spilled per (a) if long) to the parent, and stops the sub-agent. The sub-agent's whole conversation never enters the parent's context. The system prompt steers the agent to delegate long or independent sub-tasks. Counts toward `SEVEN_MAX_AGENTS` while running. |
| Config | `SEVEN_SPILL_CHARS` (2,000), `SEVEN_MEMORY_DIR` (`.seven/memory`), `SEVEN_CORE_TOOLS` (the core list above, overridable). Discovery can be switched back to "all schemas" with `SEVEN_TOOL_DISCOVERY=0` for comparison. |

## Proposed design for R4 (skills)

A skill is a named bundle of **tools plus description and instructions**.

| Element | Design |
|---------|--------|
| State | `skills` table (schema v2): `name` PK (same `^[a-z][a-z0-9_]{0,63}$` rule as tools), `description`, `instructions`, `tools` (JSON array of generated-tool names), `created_at`, `updated_at`. Agents gain `loaded_skills` (JSON array) in the same v2 rebuild. |
| Model CRUD (built-ins) | `define_skill(name, description, instructions, tools[])` creates or replaces a skill (validates the name rule and that **every listed tool exists** — missing ones are named in the error). `read_skill(name)` returns the definition plus whether the caller has it loaded. `list_skills()` lists all with the caller's loaded flag. `delete_skill(name)` deletes and scrubs the name from every agent's `loaded_skills`. `load_skill(name)` / `unload_skill(name)` manage the caller's loaded set (persisted, so a restart keeps it); a loaded skill's tool schemas are sent from the next step and its instructions join the system prompt. |
| User CRUD (API/UI) | `GET /api/skills`, `POST /api/skills` (upsert, same validation), `GET /api/skills/{name}`, `DELETE /api/skills/{name}`. UI: a Skills view with an editor (name, description, instructions, tools chosen from the existing tools) and delete; the agent pane can load/unload a skill for that agent; the tool detail shows which skills use a tool. |
| Delete protection | `ToolStore.remove(name)` (behind `delete_tool` and `DELETE /api/tools/{name}`) refuses while any skill lists the tool: `error: tool "x" is used by skill(s) a, b — change the skill first (define_skill without x) or delete_skill`. Containment checked with `json_each(skills.tools)`. Redefining (`define_tool`) and disabling are not blocked — only deletion. |
| Prompt | The system prompt lists skills by name + description (small) and appends the instructions of loaded skills; skill tools' schemas are sent only while loaded. |
| Events | `skill_defined`, `skill_deleted`, `skill_loaded`, `skill_unloaded` join the SSE stream for the UI. |

## Consequences

- `state.py`: v2 migration now adds `jobs`, `outbox`, `skills`, `outputs`,
  rebuilds `agents` (mode CHECK + `supervisor` row + `loaded_skills` column),
  plus counters; one `send()` writing inbox+outbox.
- `agent.py` (first change to the loop): dispatch spills long results and
  appends the reference; `context()` sends core + meta tools plus loaded
  skills' tools instead of everything; the system prompt describes discovery.
- `supervisor.py`: job driving in `tick()`, supervisor-inbox command grammar,
  per-agent attachment, start/stop/pause/resume.
- `builtins/`: `start_job`/`stop_job`/`list_jobs`/`list_inbox`/`list_outbox`/
  `read_memory`/`list_tools`/`describe_tool`/`define_skill`/`read_skill`/
  `list_skills`/`delete_skill`/`load_skill`/`unload_skill`/`delegate`;
  `send_message`/`wait_message` accept `supervisor`; `delete_tool` refuses
  tools referenced by a skill.
- `api.py` + `seven/ui/`: `/api/jobs`, `/api/skills` (full CRUD), `/api/memory/{id}`,
  outbox and supervisor-peer endpoints, Jobs/Skills views, agent-pane mail
  tabs and memory reader, tool discovery surfaces, load/unload per agent.
- `docs/` (architecture, agents, api, ui, data, runner) updated in the same
  change; `prompt.py` rewritten for discovery + delegation guidance.

## Limits

| Limit | Detail |
|-------|--------|
| One runner per workspace | Jobs and supervisor-inbox processing only progress in the lease-holding process; elsewhere they stay persisted. |
| Goal judgement is model-based | The YES/NO check is another model call, with its own cost and fallibility. |
| One active job per agent | An agent runs one turn at a time; a second job on the same agent queues behind the first. |
| Mail is FIFO text-only | No priorities, no attachments; delivery is one `delivered_at` flag, no read receipts. |
| Discovery costs a step | The model must call `list_tools`/`describe_tool` before using a non-core tool; in exchange every step's prompt is much smaller. |
| Skills reference existing tools only | `define_skill` refuses tool names that do not exist; deleting a tool used by a skill is refused until the skill changes. |
| Loaded skills are per agent | `loaded_skills` persists per agent; unloading removes the schemas and instructions from that agent's next steps only. |
| Spilled output costs a read | The agent pays one `read_memory` call per chunk it actually needs, instead of every step carrying the whole output. |
| Delegation hides the sub-agent's work | The parent sees only the final answer; the full transcript stays in the sub-agent's row for the UI/logs. |
| Placeholder designs | Nothing here is implemented yet; the ADR records intent until accepted. |
