# Seven

```
 ██████╗███████╗██╗   ██╗███████╗███╗   ██╗
 ██╔════╝██╔════╝██║   ██║██╔════╝████╗  ██║
 ███████╗█████╗  ██║   ██║█████╗  ██╔██╗ ██║
 ╚════██║██╔══╝  ╚██╗ ██╔╝██╔══╝  ██║╚██╗██║
 ███████║███████╗ ╚████╔╝ ███████╗██║ ╚████║
 ╚══════╝╚══════╝  ╚═══╝  ╚══════╝╚═╝  ╚═══╝
```
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.15+-3776AB.svg)](pyproject.toml)
[![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#project-status)

Seven is an **experiment in an LLM agent that builds itself**. It starts with
only the tools to run code, manage its own tools, control background runs,
spawn and message other agents, and use SQLite. When a task needs a capability
it lacks, it writes a tool for it, saves it, and uses it on its next step —
and so can every agent it spawns to work in parallel. All of its state, and all
of its agents' data, lives in SQLite databases in the workspace. Every piece of
code the model writes runs in its own Python child process. The model is
Mistral's, through its hosted API.

Seven is a **Python package that runs as a FastAPI app**: the agent itself and
the API that controls it are one process, and the same process serves a
companion web UI at `/`.

## Quick start

```bash
git clone https://github.com/djordlucas/seven
cd seven
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env          # set SEVEN_LLM_API_KEY to a Mistral API key
seven serve --host 127.0.0.1 --port 8000
# open http://127.0.0.1:8000
```

Agents work in the current directory (override with `SEVEN_WORKSPACE`), and
all of seven's data lives there, in `.seven/`. The UI talks to the API at
`/api/…`; the same API is how anything else controls seven — see
[docs/api.md](docs/api.md). `seven agents`, `seven send a1 "hi"`,
`seven tools` and `seven logs -f` read the state database or the log directly
and work while a server is running.

With Docker: `docker compose up` serves on port 8000, with agents working in
`/workspace` (mounted from `./workspace`).

## How it works

| Part | What it is | Doc |
|------|------------|-----|
| API + UI | One FastAPI app (`seven serve`): REST at `/api/…`, live events over SSE at `/api/events`, the companion UI at `/` | [docs/api.md](docs/api.md), [docs/ui.md](docs/ui.md) |
| Agent loop | Model call → tool calls → results, repeated until the model answers; the tool list is re-read every step | [docs/architecture.md](docs/architecture.md) |
| Agents | Any number at once: request, sequence or continuous agents, spawned by any agent, found with `find_agents`, talked to with `send_message` / `wait_message`; every peer (agents and the supervisor) has a persisted inbox and outbox | [docs/agents.md](docs/agents.md) |
| Jobs | Persisted autonomous work the supervisor drives on an agent — until a task is done, until a goal is attained, or periodically — controlled via API, UI, messages or built-ins; they survive restarts | [docs/agents.md](docs/agents.md#jobs) |
| Context efficiency | Long tool output spills to `.seven/memory/` and is read back in chunks; the tool list sent each step is small behind `list_tools` / `describe_tool` discovery and skills; `delegate` runs sub-tasks on throwaway agents and returns only the answer | [docs/architecture.md](docs/architecture.md#output-memory-and-tool-discovery) |
| Skills | Named bundles of generated tools plus instructions; a tool used by a skill cannot be deleted until the skill changes; full CRUD from the API/UI and the model's built-ins | [docs/agents.md](docs/agents.md#skills) |
| Generated tools | Python modules any agent writes with `define_tool`, shared by all agents | [docs/architecture.md](docs/architecture.md#generated-tools) |
| Runner | One Python child process per run, killed with everything it spawned when the result is back; pip packages installed on demand; `seven.llm.chat` for calling the model | [docs/runner.md](docs/runner.md) |
| Logging | Structured JSON lines from every component, traced by agent, turn, step and run; `seven logs` and `/api/logs` filter them | [docs/logging.md](docs/logging.md) |
| Data | Seven's state in `.seven/seven.db`; agents and tools use their own SQLite databases through `sql` and `seven.db()` | [docs/data.md](docs/data.md) |
| Misbehaving tools | Every run is recorded; `tool_health` shows failures and durations, `disable_tool` takes a tool out of the tool list, a tool can declare its own `timeout_ms` | [docs/architecture.md](docs/architecture.md#misbehaving-tools) |
| Sync and async calls | A direct call waits for the result; `start_tool` returns a run id to check with `run_status` / `wait_run` and stop with `kill_run` | [docs/architecture.md](docs/architecture.md#sync-and-async-calls) |

## Development

```bash
make install     # pip install -e ".[dev]"
make test        # pytest (no network, no API key: the model is scripted)
make eval        # evals/run.py: 8 end-to-end feature checks against a scripted model
make ci          # the gate before committing: ruff + pytest + evals
make serve       # seven serve on 127.0.0.1:8000
```

`AGENT.md` is the working agreement (branches, commits, the cross-layer
checklist); `DOCS_STYLE.md` governs every Markdown file.

## Project status

Experimental. The loop, the runner, the API and the UI work and are tested
against a scripted model; nothing has been tuned against real sessions yet.

## Roadmap

- Eval tasks that require building tools, to measure what the agent builds
  and reuses (the feature eval suite itself lives in `evals/run.py`,
  `make eval`).
- Streaming model replies into the UI.

## Limits

| Limit | Detail |
|-------|--------|
| No permission model | Deliberate: generated code can do anything the seven process can. Run it in its container. |
| Lossy memory | Long conversations are compacted into a summary; what it leaves out, the agent no longer sees. |
| One process per workspace | Agents run in the one process holding the workspace's lease. |
| One version per pip package | All runs share one `site-packages`; upgrading a package changes every tool that imports it. |

## Contributing

This repository does not accept external pull requests; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](.github/SECURITY.md).

## License

[GPL-3.0](LICENSE).
