# Architecture

Seven is a single Node.js process running any number of agents concurrently: a
supervisor drives each agent's loop, every agent calls the Mistral API through
one shared client, and every piece of code an agent writes runs in its own
child process. All state — agents, conversations, inboxes, generated tools and
their history — is one SQLite database in the workspace. Agents start with 20
built-in tools and grow by writing generated tools, which every agent can call
from its next step onward.

```text
              ┌──────────────────── seven process ─────────────────────┐
 user ─ CLI ─►│ root agent ─┐                                           │
 seven send ─►│ (inbox)     │  supervisor: drives every agent's loop     │
              │  a1  a2  a3 ┘  ◄──► model client (≤ N calls in flight)  │──► Mistral API
              │      │ tool calls                                       │
              │      ▼                                                  │
              │ built-ins · generated tools ─► runner                   │
              │      │                           │ spawn                │
              │      ▼                           ▼                      │
              │ state db (.seven/seven.db)   node child process per run │──► files · shell · network
              └──────────────────────────────────────────────────────────┘
                     all data in the workspace (SEVEN_WORKSPACE)
```

## Components

| Component | Responsibility |
|-----------|----------------|
| CLI | Reads configuration, holds the lease, and runs the root agent interactively (`seven`), for one message (`seven "<message>"`), or runs every agent headless (`seven serve`). `seven agents`, `seven send` and `seven tools` read and write the state database without running agents. Agent activity is echoed to stderr. |
| Supervisor | Runs every agent's loop concurrently: resumes unfinished agents at start, starts a turn for each idle agent with work in its inbox (polled every 250 ms), ends request and sequence agents when their tasks are done, and tells parents when children end (`multi-agent.md`). |
| Agent loop | One per agent. Sends the agent's conversation and the current tool list to the model, runs every tool call in the reply, appends the results, and repeats until a reply has no tool calls or the step budget runs out. Every message is written to the state database as it is produced. |
| Model client | One non-streamed Mistral chat completion per step, with function tools. Retries 429 and 5xx responses with backoff, honouring `retry-after`. Shared by all agents, with at most `SEVEN_LLM_CONCURRENCY` calls in flight. |
| State database | `<workspace>/.seven/seven.db`: agents, conversations, inboxes, tools, tool runs, background runs, the lease (`data.md`). |
| Tool store | Generated tools, as rows in the state database; each revision's source is also written to `.seven/tools/<name>/r<revision>.ts` for the runner to import. |
| Runner | Installs the npm packages source imports and runs it in a fresh Node.js child process per run (`runner.md`). |

## A turn

1. The input is appended to the agent's conversation: the user's message for
   the root agent, an inbox task or message, or a scheduled wake-up.
2. Messages that arrived in the agent's inbox since the last step are appended.
3. The system prompt is rebuilt: who the agent is (its mode, parent and
   instructions), the generated tools, its background runs that are going or
   unchecked, and the other active agents. The tool list is the built-ins plus
   every enabled generated tool, read on every step.
4. The model replies. A reply without tool calls is the answer and ends the turn.
5. Each tool call runs in order. A built-in runs in the seven process and may
   use the runner; a generated tool runs its source in a child process with the
   call's arguments. An unknown tool or invalid arguments produce an `error: …`
   result for the model, never an exception.
6. Each result is cut to 16,000 characters and appended as a `tool` message.
   The loop returns to step 2.

A turn that reaches its step limit (`max_steps`, default `SEVEN_MAX_STEPS`)
ends with `Stopped after N steps without a final answer.`

## Built-in tools

| Tool | Does |
|------|------|
| `run_js` | Runs code once in a child process; returns the result and the process's output. |
| `define_tool` | Installs a new or revised generated tool's packages and saves it. With `test_args`, runs it first and saves only if that run succeeds. With `timeout_ms`, gives the tool its own run limit. Refuses a name that matches a built-in. |
| `read_tool` | Returns a generated tool's definition and source. |
| `delete_tool` | Deletes a generated tool and its history. |
| `tool_health` | Shows a generated tool's state, run limit, and its last `last` runs (default 10) with caller, outcome, duration and first error line, plus totals over its recorded history. |
| `disable_tool` | Disables a generated tool with a reason. |
| `enable_tool` | Re-enables a disabled tool unchanged. |
| `start_tool` | Starts a generated tool or `run_js` as a background run and returns its run id at once. Takes an optional `timeout_ms`. |
| `run_status` | Shows a background run: running or finished, its result once finished, and the last `tail` output lines (default 50). |
| `wait_run` | Waits for a background run to finish, up to `timeout_ms` (default 30 s, at most 300 s), then shows its status. Waiting does not stop the run. |
| `kill_run` | Kills a background run and its process group; the run fails with `killed`. |
| `list_runs` | Lists the calling agent's background runs, one line each. |
| `spawn_agent`, `list_agents`, `find_agents`, `agent_status`, `send_message`, `wait_message`, `stop_agent` | Working with other agents (`multi-agent.md`). |
| `sql` | Runs SQL on a SQLite database file in the workspace (`data.md`). |

The built-ins are deliberately limited to running code, managing generated
tools, controlling background runs, working with other agents, and SQL.
Reading files, searching or editing are capabilities the agents write for
themselves.

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

A generated tool is an ES module whose default export is
`async (args) => result`, with a name (`^[a-z][a-z0-9_]{0,63}$`), a description
and a JSON Schema for its arguments. Tools are shared: one defined by any agent
is offered to every agent from its next step. Defining a tool under an existing
name replaces it and increments its revision. A tool imports packages from the
shared `.seven/node_modules`, so upgrading a package changes every tool that
uses it.

## Misbehaving tools

Every run of a generated tool, synchronous or background, is recorded with the
agent that called it; trial runs from `define_tool` are not. `tool_health`
reads that history.

A disabled tool stays in the tool store but is left out of every agent's tool
list, and the system prompt names it with its reason. A direct call or
`start_tool` to it returns
`error: tool "<name>" is disabled (<reason>). Fix it with define_tool, or enable_tool to use it as is.`
Redefining the tool clears `disabled`, because the new revision is the fix.

A tool's `timeoutMs` replaces the default run limit (`SEVEN_RUN_TIMEOUT_MS`)
for every run of that tool; `start_tool`'s own `timeout_ms` overrides both.

## Configuration

All configuration comes from environment variables; `npm start` and
`compose.yaml` read `.env` when it exists.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SEVEN_LLM_API_KEY` | `MISTRAL_API_KEY` | Mistral API key. Required to run agents. |
| `SEVEN_LLM_MODEL` | `mistral-medium-latest` | Any Mistral chat model with function calling. |
| `SEVEN_LLM_ENDPOINT` | `https://api.mistral.ai/v1` | API base URL. |
| `SEVEN_WORKSPACE` | current directory (`/workspace` in the image) | The working directory of every run, and where all of seven's data lives (`.seven/`). |
| `SEVEN_MAX_STEPS` | `40` | Model calls one turn may take. |
| `SEVEN_RUN_TIMEOUT_MS` | `60000` | Wall-clock budget of one run. |
| `SEVEN_RUN_MEMORY_MB` | `1024` | V8 heap cap of one run, in MiB. |
| `SEVEN_MAX_AGENTS` | `16` | Agents besides the root that may be active at once. |
| `SEVEN_LLM_CONCURRENCY` | `4` | Model calls in flight at once, across all agents. |

## Limits

| Limit | Detail |
|-------|--------|
| No context management | Each agent sends its whole conversation on every step; a long-lived agent eventually exceeds the model's context window and the API call fails. |
| No streaming | Each model reply arrives whole. |
| Sequential tool calls | Tool calls in one reply run one after another; `start_tool` and other agents are how work overlaps. |
| No automatic disabling | Seven does not disable a tool on its own, however often it fails; agents decide from `tool_health`. |
| No push notification | An agent learns that a background run finished from the system prompt at its next step, or by asking; nothing interrupts a step in progress. |
| No self-modification of seven's own source | Agents extend seven through generated tools only; they do not edit `src/`. |
