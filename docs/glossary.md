# Glossary

The terms below have one meaning each across `docs/`, `spec/` and `adr/`.

| Term | Meaning |
|------|---------|
| Agent | One conversation with the model, with its own inbox, mode and status; any number run at once. Identified by an id (`a1`, …) and a name. |
| Root agent | The agent `seven`, in `interactive` mode: the one the user talks to. |
| Parent | The agent that spawned another; it receives the child's final answer, failure or stop as a message. |
| Mode | How an agent's turns arise and when it ends: `interactive`, `request`, `sequence` or `continuous`. |
| Supervisor | The component that runs every agent's loop in the seven process. |
| Inbox | An agent's queue of tasks and messages, in the state database. |
| Task | An inbox item that starts a turn of its own. |
| Message | An inbox item from another agent or the user, delivered into a turn in progress or starting one. |
| Agent loop | The cycle of model call → tool calls → results that handles one turn of one agent. |
| Turn | One input — a user message, a task, a message, or a scheduled wake-up — and everything the agent loop does until it answers. |
| Step | One model call within a turn. A turn has at most `SEVEN_MAX_STEPS` steps. |
| Tool | Anything the model can call by name: a built-in or a generated tool. |
| Built-in | One of the tools seven ships with: `run_js`, `define_tool`, `read_tool`, `delete_tool`, `start_tool`, `run_status`, `wait_run`, `kill_run`, `list_runs`, `tool_health`, `disable_tool`, `enable_tool`, `spawn_agent`, `list_agents`, `find_agents`, `agent_status`, `send_message`, `wait_message`, `stop_agent`, `sql`. |
| Disabled tool | A generated tool taken out of the model's tool list with a reason, without deleting it. |
| Run history | A generated tool's recorded runs: one record per finished run, with the calling agent. |
| Generated tool | A tool the agent wrote with `define_tool`, saved in the tool store. |
| Tool store | The generated tools, in the state database, shared by every agent. |
| Revision | A generated tool's version counter; it starts at 1 and increments on each redefinition. |
| Runner | The component that installs a module's packages and runs it in a child process. |
| Run | One execution of one module in a fresh Node.js child process, from spawn to the kill of its process group. |
| Synchronous call | A direct tool call: the agent loop waits for the run's result. |
| Background run | A run started with `start_tool`; the loop continues while it runs. Also: asynchronous call. |
| Run id | A background run's name, `r1`, `r2`, … in start order across all agents. |
| Host function | A function in the seven process that a run calls as `seven.<module>.<fn>` over IPC. |
| Workspace | The working directory of every run (`SEVEN_WORKSPACE`), and where all of seven's data lives. |
| State database | `<workspace>/.seven/seven.db`, seven's own SQLite database. |
| Lease | The state database's record of which process runs agents in a workspace. |
