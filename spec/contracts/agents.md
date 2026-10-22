# Agents contract

Requirements `R-AG.*` define how the supervisor runs agents, delivers their
inboxes and persists them. `docs/multi-agent.md` and `docs/data.md` describe
the same behavior for users; this document is the version tests are written
against.

## Requirements

| ID | Requirement |
|----|-------------|
| R-AG.1 | The root agent has id and name `seven` and mode `interactive`; it is created at the first start and never ends. |
| R-AG.2 | `spawn_agent` creates an agent with a fresh id `a<N>`, records the caller as its parent, queues its tasks as inbox tasks from the parent, and returns before the agent's first turn. |
| R-AG.3 | A request agent takes exactly one task and a sequence agent at least one; `interval_s` is accepted for continuous agents only; a name already used by an active agent, or a spawn beyond `maxAgents` active non-root agents, is refused. |
| R-AG.4 | Each turn of a request or sequence agent takes the oldest undelivered task as input. When no task remains, the agent becomes `done` with its last answer as `result`. |
| R-AG.5 | A continuous agent takes the oldest undelivered inbox item, task or message, as the input of a turn; with none and `interval_s` set, it starts a turn with the scheduled wake-up input once `interval_s` has passed since its last turn. It ends only when stopped. |
| R-AG.6 | Agents' turns run concurrently; one agent is never in two turns at once. |
| R-AG.7 | At the start of every step, the agent's undelivered messages (not tasks) are appended to its conversation in order and marked delivered, in one transaction each. |
| R-AG.8 | `wait_message` returns the oldest undelivered message to the caller (from the given sender, if any) and marks it delivered, or returns nothing after `timeout_ms`. |
| R-AG.9 | When a non-root agent becomes `done`, `failed` or `stopped`, its parent's inbox receives a message from it whose text starts `finished:`, `failed:` or `stopped:`. |
| R-AG.10 | Stopping an agent interrupts its turn, kills its synchronous and background runs, and sets status `stopped`. The root agent and the caller itself cannot be stopped. |
| R-AG.11 | `send_message` to a terminal agent, to an unknown agent, or to oneself is refused; otherwise it queues one inbox message. |
| R-AG.12 | Inboxes are read from the state database at least every 250 ms, so an item written by another process is delivered as one written in-process. |
| R-AG.13 | Every conversation message is written to the state database as it is produced. At start, a tool call without a result gets an `interrupted` result, and an agent whose conversation ends on unanswered input resumes without new input. |
| R-AG.14 | At most one process holds a workspace's lease at a time; a lease whose holder is not alive, or not renewed for 15 s, may be taken over. |
| R-AG.15 | Seven's data lives under the workspace: the state database at `.seven/seven.db`. The `sql` built-in and `seven.db()` refuse a path outside the workspace or naming the state database. |

## Limits

R-AG.14 is enforced by the CLI acquiring the lease before starting the
supervisor; the supervisor itself does not check it.
