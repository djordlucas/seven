# Agents

Seven runs any number of agents at once in one process. The root agent, `seven`,
is the one the user talks to (through the API or the UI); any agent can spawn
others to work in parallel, find them, message them, and stop them. Each agent
has its own conversation, inbox and outbox, and all of them share the
built-ins and the generated tools. The supervisor is a peer of theirs (`supervisor`,
mode `supervisor`): it has an inbox with a command language and an outbox, and
it drives jobs. Every agent, conversation, message, job and skill is stored in
the state database, so agents that had not finished — and jobs that were
running — resume when seven restarts.

## Modes

| Mode | Turns come from | Ends | Final answer goes to |
|------|-----------------|------|----------------------|
| `interactive` | The user (the API) | Never; only the root agent has this mode | The user |
| `request` | Its one task | After that task's turn | Its parent, as a message |
| `sequence` | Its tasks, one turn each, in order | After the last task's turn | Its parent, as a message |
| `continuous` | Every task or message in its inbox; and every `interval_s` when idle, if set | When stopped | Whoever it sends messages to |
| `supervisor` | Messages in its inbox, parsed as commands (below) | Never | The sender of the command, as a message — unless the sender is the user |

A turn is one input and every model step until the model answers without a
tool call, up to the agent's `max_steps` (default `SEVEN_MAX_STEPS`). A
scheduled wake-up is the input `[scheduled wake-up] Continue with your
standing instructions.`

## Status

| Status | Meaning |
|--------|---------|
| `running` | In a turn |
| `idle` | Between turns, waiting for input |
| `done` | A request or sequence agent that finished its tasks; `result` holds its last answer |
| `failed` | A request or sequence agent whose model call failed after retries; `error` holds why |
| `stopped` | Stopped with `stop_agent`; `error` holds by whom and why |

`done`, `failed` and `stopped` are terminal: the agent takes no more input and
messages to it are refused. When a non-root agent ends, its parent receives a
message: `finished:`, `failed:` or `stopped:` followed by the detail. A
continuous agent whose turn fails stays `idle`, records the error, and waits
30 s before taking its next input.

## Built-ins for agents

| Built-in | Does |
|----------|------|
| `spawn_agent` | Creates an agent with a name, description, instructions, mode and tasks; returns its id (`a1`, `a2`, …) at once. Names are unique among active agents. Refused beyond `SEVEN_MAX_AGENTS` active agents besides the root (default 16). |
| `list_agents` | One line per agent: id, name, mode, status, parent, description. Active agents only unless `all`. |
| `find_agents` | Agents whose name, description or instructions contain every word of the query, case-insensitive, active ones first. |
| `agent_status` | One agent in detail: instructions, interval, times, pending inbox, last answer, result or error. |
| `send_message` | Queues a message in another agent's inbox and records it in the sender's outbox. Refused for a terminal agent and for oneself. |
| `wait_message` | Waits up to `timeout_ms` (default 60 s, at most 600 s) for the next message to the caller, from one agent if `from` is given, and returns it. |
| `stop_agent` | Stops an agent and kills its background runs. Refused for the root agent and for oneself. |
| `delegate` | Runs one task on a throwaway request agent, waits up to `SEVEN_DELEGATE_TIMEOUT_S` (default 600 s) for its final answer, returns only that answer, and stops the sub-agent. |
| `list_inbox`, `list_outbox` | Read the caller's own inbox (pending, then delivered) and outbox (sent, to whom, delivered or not). |
| `start_job`, `stop_job`, `list_jobs` | Jobs (below): start one on yourself or a spawned worker, stop one you own, list them. |
| `define_skill`, `read_skill`, `list_skills`, `delete_skill`, `load_skill`, `unload_skill` | Skills (below). |
| `list_tools`, `describe_tool` | Tool discovery: list all tools; reveal one so it is callable from the next step (persisted). |
| `read_memory` | Read a chunk of spilled output by memory id, offset and limit. |
| `remember`, `recall`, `forget` | The agent's own key/value memory — full CRUD, persists across restarts, per-agent keys, shown in the UI's Data view. `remember(key, value)` creates or updates (64 KB cap); `recall(key, offset?, limit?)` reads a character window of one value; `recall()` lists all keys with sizes and value previews; `forget(key)` deletes. |

Agents are referred to by id or by name; a name resolves to the active agent
with that name, else the most recent one.

## Inboxes and messages

An inbox holds two kinds of item. A **task** starts a turn of its own; the
tasks given to `spawn_agent` are tasks. A **message** comes from
`send_message`, from a child agent ending, or from the API / `seven send`.

| Receiver | A message is read |
|----------|-------------------|
| Any agent in a turn | At the start of its next step, appended as a user message |
| An idle continuous agent | As the input of a new turn, within 250 ms |
| An idle request or sequence agent | At the start of the next step of its next task's turn |
| The root agent, idle | At once, as the input of a new turn (the API starts it) |
| The root agent, busy | At the start of its next step |
| Any agent in `wait_message` | As the call's result, instead of in the conversation |

A message reads `[message from a2 "researcher"]` followed by the text, or
`[message from the user]` for one sent from the API or `seven send`.

Every send is recorded on both sides: the recipient's `inbox` row and the
sender's `outbox` row, in one transaction. `list_outbox` and
`GET /api/agents/{id}/outbox` show what a peer sent and whether it was
delivered; the supervisor and the user appear as senders like any agent.

The supervisor polls the inboxes in the state database every 250 ms, so a
message written by another process reaches its agent as one from an agent does.

## Jobs

A job is autonomous work the supervisor drives on an agent, persisted in the
`jobs` table so a restart does not stop it:

| Kind | Behaviour | Created with |
|------|-----------|--------------|
| `task` | One task is enqueued; the job is `done` with the agent's answer when that turn ends | `task`, optional `instructions` |
| `goal` | A task is enqueued each turn; after each turn the supervisor asks the model whether the goal is attained (one model call per turn), up to `max_turns` (default 20) | `goal`, optional `instructions`, `max_turns` |
| `periodic` | The agent is woken every `interval_s`; the job runs until stopped | `interval_s`, optional `instructions` |

| Job status | Meaning |
|------------|---------|
| `running` | Being driven (a turn is queued or in progress) |
| `paused` | Not driven until resumed |
| `done` | Finished; `result` holds the answer or the goal check's summary |
| `failed` | Finished without success; `error` holds why (e.g. goal not attained within `max_turns`) |
| `stopped` | Stopped; `error` holds by whom and why |

Jobs are created through the API (`POST /api/jobs`), the UI, the `start_job`
built-in, or a message to the supervisor. Scope rules: an agent may attach a
job only to itself or leave `agent` unset — in which case the supervisor
spawns a dedicated continuous worker and stops it when the job ends. Only
the supervisor (API, UI, or its inbox) can assign a job to another agent.
The root and the supervisor are never job targets; a periodic job needs a
continuous agent. Only the supervisor, the job's creator, or the job's agent
can stop it. When a job ends, its creator is told by message.

Messages to the `supervisor` peer are commands, one per line:

```text
start job <task|goal|periodic> [on <agent>] <spec…>
stop <job> [reason…] | pause <job> | resume <job>
jobs | agents | status
```

`task` takes the rest of the line as the task, `goal` as the goal, `periodic`
an `<interval_s> <instructions>`. The reply goes to the sender's inbox as a
message (senders that are agents only — the user reads the supervisor's
outbox).

## Skills

A skill is a named bundle of generated tools with a description and standing
instructions. `define_skill` refuses unknown tool names; a tool used by a
skill cannot be deleted until the skill changes or is deleted
(`delete_tool`, `DELETE /api/tools/{name}` → 409 naming the skills).
`load_skill` makes the skill's tools callable from that agent's next step and
adds its instructions to its system prompt; the load is persisted per agent
(`loaded_skills`), and skills themselves live in the `skills` table. Full
CRUD exists from the user (API and UI) and the model (built-ins).

## Concurrency

Every agent's loop runs concurrently in the seven process. Model calls from all
agents share a limit of `SEVEN_LLM_CONCURRENCY` in flight (default 4); the rest
wait. Tool runs are separate child processes, so they execute in parallel.

## Running agents

| Command | Does |
|---------|------|
| `seven serve [--host H] [--port P]` | Runs the API, the UI and every agent until SIGINT or SIGTERM. |
| `seven agents [--all]` | Lists agents, with the number of inbox items waiting. Does not run agents. |
| `seven send <agent> <text>` | Queues a message from the user for an active agent. Does not run agents; works while a server runs them. |
| `seven tools` | Lists generated tools. Does not run agents. |
| `seven logs [--agent <id>] [--level L] [--grep T] [--tail N] [-f] [--json]` | Prints the log, filtered; follows it with `-f` (`logging.md`). |

Only one process at a time runs agents in a workspace. It holds a lease in the
state database, renewed every 5 s; a second `seven serve` exits with
`another seven (pid N) is running agents in this workspace`. A lease not
renewed for 15 s, or held by a process that no longer exists, is taken over.

## Restarts

When seven starts, it resumes every agent that is not terminal:

1. A tool call that had no result gets `error: interrupted — seven restarted
   before this call finished`.
2. A conversation that ends on input the model has not answered resumes from
   that point, without new input.
3. Background runs recorded as running are marked lost: `lost: seven restarted
   while it ran`.

On shutdown, seven interrupts every turn, kills every run (synchronous and
background) and marks background runs lost. Jobs are not touched: on the next
start the lease-holding process re-drives every job that is `running` or
`paused`; a running job whose agent is gone or terminal fails with
`agent <id> is <status>` (a task job whose agent finished with a result is
done instead).

## Limits

| Limit | Detail |
|-------|--------|
| One process per workspace | Agents run in the process holding the lease; there is no distribution across machines. |
| Lossy memory | A long-lived agent's older messages are compacted into a summary; what the summary leaves out is gone from its view (`compaction.md`). |
| Polling | Inbox delivery has up to 250 ms latency. |
| Shared tools, no ownership | Any agent can redefine, disable or delete any tool. |
| No spawn depth limit | Agents may spawn agents; only `SEVEN_MAX_AGENTS` bounds the total. |
| One active turn per agent | A second job on the same agent queues behind the first. |
| Mail is FIFO text | No priorities or attachments; delivery is one `delivered_at` flag, no read receipts. |
