# Documentation

`docs/` describes how seven works today, for people running or changing it. The
design history is in `adr/`; the normative contracts are in `spec/`.

| Document | Subject |
|----------|---------|
| `architecture.md` | Components, the agent loop, built-in and generated tools, configuration |
| `multi-agent.md` | Agents: modes, status, spawning, messaging, the CLI commands that run them, restarts |
| `logging.md` | The structured log: format, fields, levels, messages, `seven logs` |
| `data.md` | Where data lives: the state database, and the databases agents and tools use |
| `runner.md` | The runner: runs, limits, host functions, dependencies |
| `docker.md` | Images, volumes and Make targets for running and developing seven |
| `glossary.md` | The terms these documents use |

## Limits

No document covers deployment beyond a local Docker host; there is none.
