# The UI

`seven serve` serves a companion single-page UI at `/` — vanilla HTML/CSS/JS
in `seven/api/ui/`, no build step. It is feature-complete: every endpoint in
[api.md](api.md) has a surface here.

| View | Covers |
|------|--------|
| Agents | The agent list (live, the supervisor peer included), a chat pane per agent with the full transcript, tool calls and results, Inbox and Outbox tabs per agent, sending a message, spawning an agent (all modes), stopping, compacting, resetting the conversation. Live updates arrive over `/api/events`. |
| Tools | The generated tool list, one tool's definition, source and health, calling a tool with JSON args, starting a background run, disabling/enabling/deleting (refused with the using skills while one does), defining a new tool, and a Run Python box for `/api/exec`. |
| Activity | Runs and logs in one place, as sub-tabs: background runs (live) with one run's status, result and output and killing a live run; the structured log with agent/level/grep/tail filters and a follow mode. |
| Jobs | Jobs (live): kind, spec, agent, status, turns, result or error; start (task/goal/periodic, on an agent), stop, pause, resume. |
| Skills | Skills: list, define, edit, delete, read, and load/unload per agent. |
| Memory | Spilled outputs (live) with size and tool, and one output read in character chunks. |
| Config | `/api/config` and `/api/health` as a table (the API key is never sent). |

The top bar shows the instance name (the workspace directory's basename) in the
center, the live-stream status and a theme switcher (dark/light, remembered in
`localStorage`). Agent descriptions appear in a floating box after hovering a
roster row for about a second. |

## Limits

| Limit | Detail |
|-------|--------|
| No build step | The UI is hand-written JS served as static files; there is no bundler or framework to update. |
| Polling + SSE | Agent and run lists poll every few seconds; the open conversation streams over SSE. |
| Single workspace | The UI shows the workspace of the one server it is served by. |
