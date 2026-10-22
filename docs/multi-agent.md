# Agents

Seven runs any number of agents at once in one process. The root agent, `seven`,
is the one the user talks to; any agent can spawn others to work in parallel,
find them, message them, and stop them. Each agent has its own conversation
and inbox, and all of them share the built-ins and the generated tools. Every
agent, conversation and message is stored in the state database, so agents
that had not finished resume when seven restarts.

## Modes

| Mode | Turns come from | Ends | Final answer goes to |
|------|-----------------|------|----------------------|
| `interactive` | The user (the CLI) | Never; only the root agent has this mode | The user |
| `request` | Its one task | After that task's turn | Its parent, as a message |
| `sequence` | Its tasks, one turn each, in order | After the last task's turn | Its parent, as a message |
| `continuous` | Every task or message in its inbox; and every `interval_s` when idle, if set | When stopped | Whoever it sends messages to |

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
continuous agent whose turn fails stays `idle`, records the error, and waits 30
s before taking its next input.

## Built-ins for agents

| Built-in | Does |
|----------|------|
| `spawn_agent` | Creates an agent with a name, description, instructions, mode and tasks; returns its id (`a1`, `a2`, …) at once. Names are unique among active agents. Refused beyond `SEVEN_MAX_AGENTS` active agents besides the root (default 16). |
| `list_agents` | One line per agent: id, name, mode, status, parent, description. Active agents only unless `all`. |
| `find_agents` | Agents whose name, description or instructions contain every word of the query, case-insensitive, active ones first. |
| `agent_status` | One agent in detail: instructions, interval, times, pending inbox, last answer, result or error. |
| `send_message` | Queues a message in another agent's inbox. Refused for a terminal agent and for oneself. |
| `wait_message` | Waits up to `timeout_ms` (default 60 s, at most 600 s) for the next message to the caller, from one agent if `from` is given, and returns it. |
| `stop_agent` | Stops an agent and kills its background runs. Refused for the root agent and for oneself. |

Agents are referred to by id or by name; a name resolves to the active agent
with that name, else the most recent one.

## Inboxes and messages

An inbox holds two kinds of item. A **task** starts a turn of its own; the
tasks given to `spawn_agent` are tasks. A **message** comes from
`send_message`, from a child agent ending, or from `seven send`.

| Receiver | A message is read |
|----------|-------------------|
| Any agent in a turn | At the start of its next step, appended as a user message |
| An idle continuous agent | As the input of a new turn, within 250 ms |
| An idle request or sequence agent | At the start of the next step of its next task's turn |
| The root agent, idle | At the start of its next turn; the CLI prints it as it arrives |
| Any agent in `wait_message` | As the call's result, instead of in the conversation |

A message reads `[message from a2 "researcher"]` followed by the text, or
`[message from the user]` for one sent with `seven send`.

The supervisor polls the inboxes in the state database every 250 ms, so a
message written by another process reaches its agent as one from an agent does.

## Concurrency

Every agent's loop runs concurrently in the seven process. Model calls from all
agents share a limit of `SEVEN_LLM_CONCURRENCY` in flight (default 4); the rest
wait. Tool runs are separate child processes, so they execute in parallel.

## Running agents

| Command | Does |
|---------|------|
| `seven` | Interactive session with the root agent, and every other agent running. `/agents` lists active agents; `/reset` clears the root agent's conversation. |
| `seven "<message>"` | One root turn, then exit. Agents still active are interrupted and resume at the next start. |
| `seven serve` | Runs every agent without a terminal until SIGINT or SIGTERM. |
| `seven agents [--all]` | Lists agents, with the number of inbox items waiting. Does not run agents. |
| `seven send <agent> <text>` | Queues a message from the user for an active agent. Does not run agents; works while another seven runs them. |

Only one process at a time runs agents in a workspace. It holds a lease in the
state database, renewed every 5 s; a second `seven`, `seven "<message>"` or
`seven serve` exits with `another seven (pid N) is running agents in this
workspace`. A lease not renewed for 15 s, or held by a process that no longer
exists, is taken over.

## Restarts

When seven starts, it resumes every agent that is not terminal:

1. A tool call that had no result gets `error: interrupted — seven restarted
   before this call finished`.
2. A conversation that ends on input the model has not answered resumes from
   that point, without new input.
3. Background runs recorded as running are marked lost: `lost: seven restarted
   while it ran`.

On shutdown, seven interrupts every turn, kills every run (synchronous and
background) and marks background runs lost.

## Limits

| Limit | Detail |
|-------|--------|
| One process per workspace | Agents run in the process holding the lease; there is no distribution across machines. |
| No context management | Each agent sends its whole conversation on every step; a long-lived agent eventually exceeds the model's context window and its turns fail. |
| The root agent does not react on its own | A message to the idle root agent waits for the user's next turn. |
| Polling | Inbox delivery has up to 250 ms latency. |
| Shared tools, no ownership | Any agent can redefine, disable or delete any tool. |
| No spawn depth limit | Agents may spawn agents; only `SEVEN_MAX_AGENTS` bounds the total. |
