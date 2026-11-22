# Docs

`docs/` is the source of truth for how seven behaves; a code/doc mismatch is a
bug in one of them, to be reconciled. Every file follows
[DOCS_STYLE.md](../DOCS_STYLE.md).

| Doc | Subject |
|-----|---------|
| [architecture.md](architecture.md) | The process, the agent loop, built-in tools, configuration |
| [api.md](api.md) | The HTTP API that controls seven, and the SSE event stream |
| [ui.md](ui.md) | The companion web UI served at `/` |
| [agents.md](agents.md) | Multi-agent: modes, inboxes, restarts, the lease, the CLI |
| [runner.md](runner.md) | The Python child process every piece of model-written code runs in |
| [data.md](data.md) | Where everything lives: the workspace layout and the state database |
| [logging.md](logging.md) | The structured JSON-lines log and how to read it |
| [compaction.md](compaction.md) | Folding long conversations into a summary |

## Limits

| Limit | Detail |
|-------|--------|
| No contracts directory | The old `spec/` contracts were dropped in the Python reset; `docs/` is normative. |
