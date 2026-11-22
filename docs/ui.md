# The UI

`seven serve` serves a companion single-page UI at `/` — vanilla HTML/CSS/JS
in `seven/ui/`, no build step. It is feature-complete: every endpoint in
[api.md](api.md) has a surface here.

| View | Covers |
|------|--------|
| Agents | The agent list (live), a chat pane per agent with the full transcript, tool calls and results, sending a message, spawning an agent (all modes), stopping, compacting, resetting the conversation. Live updates arrive over `/api/events`. |
| Tools | The generated tool list, one tool's definition, source and health, calling a tool with JSON args, starting a background run, disabling/enabling/deleting, defining a new tool, and a Run Python box for `/api/exec`. |
| Runs | Background runs (live), one run's status, result and output, killing a live run. |
| Logs | The structured log with agent/level/grep/tail filters and a follow mode. |
| Config | `/api/config` and `/api/health` as a table (the API key is never sent). |

## Limits

| Limit | Detail |
|-------|--------|
| No build step | The UI is hand-written JS served as static files; there is no bundler or framework to update. |
| Polling + SSE | Agent and run lists poll every few seconds; the open conversation streams over SSE. |
| Single workspace | The UI shows the workspace of the one server it is served by. |
