# Architecture

Seven is a single Python process — a FastAPI app — running any number of
agents concurrently: a supervisor drives each agent's loop, every agent calls
the Mistral API through one shared client, and every piece of code an agent
writes runs in its own child process. All state — agents, conversations,
inboxes and outboxes, jobs, skills, generated tools and their history — is
one SQLite database in the workspace. Agents start with 35 built-in tools
and grow by writing generated tools, which every agent can call from its
next step onward. Long tool output is spilled to files and read back in
chunks, the tool list sent to the model stays small behind discovery and
skills, every peer can exchange mail, and agents and the supervisor can run
persisted autonomous jobs.

```text
              ┌──────────────── seven process (FastAPI) ────────────────┐
 browser ─ UI ─▶│ /api/…  SSE /api/events                                 │
 curl/scripts ─▶ │ root agent ─┐                                           │──▶ Mistral API
 seven send ───▶ │ (inbox)     │  supervisor: drives every agent's loop     │
              │  a1  a2  a3 ◄─┘                                         │
              │      │ tool calls                                       │
              │      ▼                                                 │
              │ built-ins · generated tools ─▶ runner                  │
              │      │                           │ spawn                │
              │      ▼                           ▼                      │
              │ state db (.seven/seven.db)   python child process per run ─▶ files · shell · network
              └──────────────────────────────────────────────────────────┘
                     all data in the workspace (SEVEN_WORKSPACE)
```

## Package layout

```text
seven/
  __init__.py     version
  __main__.py     CLI: serve runs the server; agents/send/tools/logs read state
  app.py          composition root: wires the packages below into SevenApp
  core/           config.py · log.py · state.py (SQLite) · llm.py (Mistral client)
  execution/      runner.py · child.py (python -m seven.execution.child) · runs.py
  tools/          store.py (generated tools) · builtins/ (the built-in tools)
  agent/          agent.py (the loop) · supervisor.py · prompt.py · compact.py
  api/            app.py (FastAPI: /api/…, /api/events) · ui/ (the web UI at /)
```

## Components

| Component | Responsibility |
|-----------|----------------|
| API | FastAPI app (`seven/api/app.py`): REST under `/api/…`, SSE at `/api/events`, the UI at `/`. Every route is `async def` so it shares the event loop with the agents. |
| CLI | `seven serve` wires everything and holds the lease; `seven agents`, `seven send`, `seven tools` and `seven logs` read the state database or the log without running agents, so they work while a server runs. |
| Supervisor | Runs every agent's loop concurrently: resumes unfinished agents at start, starts a turn for each idle agent with work in its inbox (polled every 250 ms), ends request and sequence agents when their tasks are done, and tells parents when children end (`agents.md`). It also drives persisted jobs (task, goal, periodic) on their agents. The root agent is driven by the user, through the API. The supervisor itself is a peer (`supervisor`) with its own inbox, outbox and command language. |
| Agent loop | One per agent. Sends the agent's conversation and the current tool list to the model, runs every tool call in the reply, appends the results, and repeats until a reply has no tool calls or the step budget runs out. Every message is written to the state database as it is produced, and results over `SEVEN_SPILL_CHARS` are spilled to memory instead. Compacts the conversation into a summary when it nears the context window (`compaction.md`). |
| Model client | One non-streamed Mistral chat completion per step, with function tools. Retries 429 and 5xx responses with backoff, honouring `retry-after`. Shared by all agents, with at most `SEVEN_LLM_CONCURRENCY` calls in flight. |
| State database | `<workspace>/.seven/seven.db`: agents, conversations, inboxes and outboxes, jobs, skills, tools, tool runs, background runs, spilled outputs, the lease (`data.md`). |
| Tool store | Generated tools, as rows in the state database; each revision's source is also written to `.seven/tools/<name>/r<revision>.py` for the runner to import. |
| Runner | Installs the pip packages source imports and runs it in a fresh Python child process per run (`runner.md`). |
| Logger | Structured JSON lines from every component, bound to the agent, turn, step, call and run they belong to (`logging.md`). |

## A turn

1. The input is appended to the agent's conversation: the user's message for
   the root agent, an inbox task or message, or a scheduled wake-up.
2. Messages that arrived in the agent's inbox since the last step are appended.
3. The system prompt is rebuilt: who the agent is (its mode, parent and
   instructions), the generated tools, its background runs that are going or
   unchecked, the other active agents, its skills, and the summary of
   compacted messages. The tool list sent is kept small: the core tools
   (`SEVEN_CORE_TOOLS`), the discovery and skill meta tools
   (`list_tools`, `describe_tool`, `list_skills`, `load_skill`,
   `unload_skill`), the tools revealed earlier with `describe_tool`, and the
   tools of loaded skills — rebuilt on every step. With `SEVEN_TOOL_DISCOVERY=0`
   every built-in and every enabled generated tool is sent every step instead.
4. When the request is estimated above 75% of the context window, the older
   messages are compacted into the summary first (`compaction.md`).
5. The model replies. A reply without tool calls is the answer and ends the turn.
6. Each tool call runs in order. A built-in runs in the seven process and may
   use the runner; a generated tool runs its source in a child process with the
   call's arguments. An unknown tool or invalid arguments produce an `error: …`
   result for the model, never an exception.
7. A result longer than `SEVEN_SPILL_CHARS` (default 2,000) is spilled to
   `<memory dir>/<call id>.out`, recorded in the `outputs` table, and replaced
   by a reference telling the model to read it in chunks with `read_memory`;
   anything still longer than 16,000 characters is cut, and appended as a
   `tool` message. The loop returns to step 2.

A turn that reaches its step limit (`max_steps`, default `SEVEN_MAX_STEPS`)
ends with `Stopped after N steps without a final answer.`

## Built-in tools

| Tool | Does |
|------|------|
| `run_python` | Runs Python once in a child process; returns the result and the process's output. |
| `define_tool` | Installs a new or revised generated tool's packages and saves it. With `test_args`, runs it first and saves only if that run succeeds. With `timeout_ms`, gives the tool its own run limit. Refuses a name that matches a built-in. |
| `read_tool` | Returns a generated tool's definition and source. |
| `delete_tool` | Deletes a generated tool and its history. |
| `tool_health` | Shows a generated tool's state, run limit, and its last `last` runs (default 10) with caller, outcome, duration and first error line, plus totals over its recorded history. |
| `disable_tool` | Disables a generated tool with a reason. |
| `enable_tool` | Re-enables a disabled tool unchanged. |
| `start_tool` | Starts a generated tool or `run_python` as a background run and returns its run id at once. Takes an optional `timeout_ms`. |
| `run_status` | Shows a background run: running or finished, its result once finished, and the last `tail` output lines (default 50). |
| `wait_run` | Waits for a background run to finish, up to `timeout_ms` (default 30 s, at most 300 s), then shows its status. Waiting does not stop the run. |
| `kill_run` | Kills a background run and its process group; the run fails with `killed`. |
| `list_runs` | Lists the calling agent's background runs, one line each. |
| `spawn_agent`, `list_agents`, `find_agents`, `agent_status`, `send_message`, `wait_message`, `stop_agent`, `delegate` | Working with other agents (`agents.md`); `delegate` runs one task on a throwaway request agent and returns only its answer. |
| `list_inbox`, `list_outbox` | Read the caller's inbox (pending, then delivered) and outbox (what was sent, to whom, delivered or not). |
| `start_job`, `stop_job`, `list_jobs` | Jobs: autonomous work the supervisor drives (`agents.md#jobs`). |
| `define_skill`, `read_skill`, `list_skills`, `delete_skill`, `load_skill`, `unload_skill` | Skills: named bundles of generated tools plus instructions; loading one makes its tools callable (`agents.md#skills). |
| `list_tools`, `describe_tool` | Tool discovery: list everything that exists; reveal one tool's schema, persistently, so it is callable from the next step. |
| `read_memory` | Read a character window of spilled output (`SEVEN_MEMORY_DIR`), with total size and next offset. |
| `remember`, `recall`, `forget` | Per-agent key/value memory in the state DB (`kv` table) — CRUD: upsert, paged read (`offset`/`limit`), key listing with previews, delete. 64 KB value cap. |
| `sql` | Runs SQL on a SQLite database file in the workspace (`data.md`). |

The built-ins are deliberately limited to running code, managing generated
tools, controlling background runs, working with other agents, jobs, mail,
skills, memory, discovery, and SQL. Reading files, searching or editing are
capabilities the agents write for themselves.

## Sync and async calls

A direct tool call is synchronous: the loop waits for the run, up to its time
limit, and the result is the tool message. `start_tool` makes the same call
asynchronous: the run starts, the tool message is `started r<N> (<tool>)`, and
the loop continues while the run's process keeps going.

| Background run state | Shown as |
|----------------------|----------|
| Installing packages or running | `r3 fetch_all: running for 12.4s` |
| Finished, not yet looked at | `r3 fetch_all: finished in 14.0s, ok (not checked yet)` |
| Finished and looked at | `r3 fetch_all: finished in 14.0s, ok` |
| Cut off by a restart | `r3 fetch_all: lost: seven restarted while it ran` |

A finished run counts as looked at once `run_status`, `wait_run` or `kill_run`
has shown it. Run ids are numbered across all agents and persist in the state
database with each run's result and last 500 output lines; `list_runs` shows
the caller's 50 most recent.

## Generated tools

A generated tool is a Python module whose `default` export is the result — a
value, or a function called with the run's arguments (`async` works). It has a
name (`^[a-z][a-z0-9_]{0,63}$`), a description and a JSON Schema for its
arguments. Tools are shared: one defined by any agent is offered to every agent
from its next step. Defining a tool under an existing name replaces it and
increments its revision. A tool names pip packages in `deps`; they are installed
into the shared `.seven/site-packages`, so upgrading a package changes every
tool that uses it.

## Misbehaving tools

Every run of a generated tool, synchronous or background, is recorded with the
agent that called it; trial runs from `define_tool` are not. `tool_health`
reads that history.

A disabled tool stays in the tool store but is left out of every agent's tool
list, and the system prompt names it with its reason. A direct call or
`start_tool` to it returns
`error: tool "<name>" is disabled (<reason>). Fix it with define_tool, or enable_tool to use it as is.`
Redefining the tool clears `disabled`, because the new revision is the fix.

A tool's `timeout_ms` replaces the default run limit (`SEVEN_RUN_TIMEOUT_MS`)
for every run of that tool; `start_tool`'s own `timeout_ms` overrides both.

## Jobs

A job is persisted autonomous work the supervisor drives on an agent —
until a task is done, until a goal is attained, or periodically:

| Kind | Runs until | Spec |
|------|-----------|------|
| `task` | The agent's turn ends | `task`, optional `instructions` |
| `goal` | A supervisor-side model check after each turn answers YES, or `max_turns` (default 20) turns pass | `goal`, optional `instructions`, `max_turns` |
| `periodic` | Stopped; wakes the agent every `interval_s` | `interval_s`, optional `instructions` |

Jobs are created through the API, the UI, a message to the supervisor
(`start job task on a1 …`, `stop j1`, `pause j1`, `resume j1`, `jobs`,
`agents`, `status`), or the `start_job` built-in — which may only attach a
job to the calling agent itself or to a freshly spawned worker; assigning a
job to another agent is the supervisor's job. A job without an agent gets a
dedicated continuous worker, stopped when the job ends. The root and the
supervisor are never job targets, a periodic job needs a continuous agent,
and jobs survive restarts: the lease-holding process re-drives every
running or paused job (`agents.md#jobs`).

## Mail

Every message peer — the supervisor and every agent — has a persisted inbox
and outbox. Sending writes both sides in one transaction: the recipient's
inbox row and the sender's outbox row. `list_inbox` and `list_outbox` read
them; the API exposes them per agent, and the UI shows both as chat tabs.
Replies the supervisor sends to an agent's command arrive as ordinary
messages; messages from the user have no inbox to reply into, so they are
answered on the supervisor's outbox only.

## Output memory and tool discovery

Two measures keep context use low:

- Tool and run results longer than `SEVEN_SPILL_CHARS` never enter the
  conversation whole: they are written to `<memory dir>/<id>.out`
  (default `.seven/memory/`), recorded in the `outputs` table, and the agent
  gets a reference; `read_memory(id, offset, limit)` pages through the file,
  and `/api/memory` shows the same for the UI.
- With tool discovery on (default), each step sends only the core tools, the
  meta tools, previously revealed tools and loaded-skill tools.
  `list_tools` shows everything that exists; `describe_tool` reveals one,
  persisted per agent in `revealed_tools`. `SEVEN_TOOL_DISCOVERY=0` restores
  sending every schema every step.

`delegate` is the third measure: it spawns a request agent for an independent
sub-task, waits up to `SEVEN_DELEGATE_TIMEOUT_S` for its final answer, and
returns only that answer — the sub-agent's conversation never enters the
parent's context.

## Skills

A skill is a named bundle of generated tools plus a description and standing
instructions. `define_skill` refuses tool names that do not exist, and a tool
used by a skill cannot be deleted (`delete_tool` and `DELETE /api/tools/…`
refuse with the skill names) until the skill is changed or deleted. Loading
a skill (`load_skill`, or `POST /api/skills/{name}/load?agent=a1`) makes its
tools callable from that agent's next step and adds its instructions to the
system prompt; the load is persisted per agent. Skills get full CRUD from
the user (API and UI) and from the model (built-ins).

## Configuration

All configuration comes from environment variables. A `.env` file in the
current directory is also read when it exists, without overriding variables
already set in the environment; `compose.yaml` passes `.env` through
`env_file` as well.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SEVEN_LLM_API_KEY` | `MISTRAL_API_KEY` | Mistral API key. Required to run agents. |
| `SEVEN_LLM_MODEL` | `mistral-medium-latest` | Any Mistral chat model with function calling. |
| `SEVEN_LLM_ENDPOINT` | `https://api.mistral.ai/v1` | API base URL. |
| `SEVEN_WORKSPACE` | current directory | The working directory of every run, and where all of seven's data lives (`.seven/`). |
| `SEVEN_MAX_STEPS` | `40` | Model calls one turn may take. |
| `SEVEN_CONTEXT_TOKENS` | `128000` | The model's context window; conversations are compacted to fit it (`compaction.md`). |
| `SEVEN_RUN_TIMEOUT_MS` | `60000` | Wall-clock budget of one run. |
| `SEVEN_RUN_MEMORY_MB` | `1024` | Address-space cap of one run, in MiB (RLIMIT_AS in the child). |
| `SEVEN_MAX_AGENTS` | `16` | Agents besides the root that may be active at once. |
| `SEVEN_LLM_CONCURRENCY` | `4` | Model calls in flight at once, across all agents. |
| `SEVEN_SPILL_CHARS` | `2000` | Tool results longer than this are spilled to memory instead of entering the conversation. `0` disables spilling. |
| `SEVEN_MEMORY_DIR` | `.seven/memory` | Where spilled output files live; relative paths resolve against the workspace. |
| `SEVEN_CORE_TOOLS` | `run_python,define_tool,read_tool,delegate,send_message,wait_message,spawn_agent,read_memory,remember,recall,forget` | Comma-separated tools always in the tool list when discovery is on. |
| `SEVEN_TOOL_DISCOVERY` | `1` | `0` sends every tool schema on every step. |
| `SEVEN_DELEGATE_TIMEOUT_S` | `600` | How long `delegate` waits for the sub-agent's answer. |
| `SEVEN_LOG_LEVEL`, `SEVEN_LOG_FILE`, `SEVEN_LOG_STDERR` | `info`, `.seven/logs/seven.log`, on for `serve` | Logging (`logging.md`). |

## Limits

| Limit | Detail |
|-------|--------|
| Lossy compaction | A compacted conversation is a summary; details the summarizer drops are gone from the agent's view (`compaction.md`). |
| No streaming | Each model reply arrives whole; SSE streams agent events, not model tokens. |
| Sequential tool calls | Tool calls in one reply run one after another; `start_tool` and other agents are how work overlaps. |
| No automatic disabling | Seven does not disable a tool on its own, however often it fails; agents decide from `tool_health`. |
| No push notification | An agent learns that a background run finished from the system prompt at its next step, or by asking; nothing interrupts a step in progress. |
| Goal judgement is model-based | The per-turn YES/NO check is another model call, with its own cost and fallibility. |
| Spill threshold is per result | A result just over `SEVEN_SPILL_CHARS` spills whole; the agent then pays one `read_memory` call per chunk it needs. |
| Discovery costs a step | The model must call `list_tools`/`describe_tool` before using a non-core tool. |
| User commands are not mailed back | The supervisor answers commands from agents as messages, but the user has no inbox row; user-sent commands are answered on the supervisor's outbox only. |
| No self-modification of seven's own source | Agents extend seven through generated tools only; they do not edit the `seven/` package. |
