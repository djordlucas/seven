# Seven
```
 ███████╗███████╗██╗   ██╗███████╗███╗   ██╗
 ██╔════╝██╔════╝██║   ██║██╔════╝████╗  ██║
 ███████╗█████╗  ██║   ██║█████╗  ██╔██╗ ██║
 ╚════██║██╔══╝  ╚██╗ ██╔╝██╔══╝  ██║╚██╗██║
 ███████║███████╗ ╚████╔╝ ███████╗██║ ╚████║
 ╚══════╝╚══════╝  ╚═══╝  ╚══════╝╚═╝  ╚═══╝
```
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-24-339933.svg)](package.json)
[![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#project-status)

Seven is an **experiment in an LLM agent that builds itself**. It starts with
only the tools to run code, manage its own tools, control background runs,
spawn and message other agents, and use SQLite. When a task needs a capability
it lacks, it writes a tool for it, saves it, and uses it on its next step —
and so can every agent it spawns to work in parallel. All of its state, and all
of its agents' data, lives in SQLite databases in the workspace. Every piece of code the model writes runs in its own Node.js
child process, with all of Node and any npm package. The model is Mistral's, through its hosted API.

Seven is a Node.js (TypeScript) program, and it runs and is developed in Docker.

## Quick start

```bash
git clone https://github.com/djordlucas/seven
cd seven
cp .env.example .env          # set SEVEN_LLM_API_KEY to a Mistral API key
make run                      # interactive session in the runtime container
```

Agents work in `./workspace`, mounted at `/workspace`, and all of seven's data
lives there, in `.seven/`. `make serve` keeps agents running in the
background; `docker compose run --rm seven agents` lists them.

Without Docker, on Node 24 or later:

```bash
npm install
npm start                     # interactive
npm start -- "<message>"      # one message, then exit
npm start -- serve            # run every agent, headless
npm start -- agents           # list agents
npm start -- send a2 "hi"     # message an agent, even while another seven runs
npm start -- tools            # list generated tools
npm start -- logs -f          # follow seven's log
```

## How it works

| Part | What it is | Doc |
|------|------------|-----|
| Agent loop | Model call → tool calls → results, repeated until the model answers; the tool list is re-read every step | [architecture.md](docs/architecture.md) |
| Agents | Any number at once: request, sequence or continuous agents, spawned by any agent, found with `find_agents`, talked to with `send_message` / `wait_message` | [multi-agent.md](docs/multi-agent.md) |
| Generated tools | ES modules any agent writes with `define_tool`, shared by all agents | [architecture.md](docs/architecture.md#generated-tools) |
| Logging | Structured JSON lines from every component, traced by agent, turn, step and run; `seven logs` filters and follows them | [logging.md](docs/logging.md) |
| Data | Seven's state in `.seven/seven.db`; agents and tools use their own SQLite databases through `sql` and `seven.db()` | [data.md](docs/data.md) |
| Misbehaving tools | Every run is recorded; `tool_health` shows a tool's failures and durations, `disable_tool` takes it out of the tool list, and a tool can declare its own `timeout_ms` | [architecture.md](docs/architecture.md#misbehaving-tools) |
| Sync and async calls | A direct call waits for the result; `start_tool` returns a run id to check with `run_status` / `wait_run` and stop with `kill_run` | [architecture.md](docs/architecture.md#sync-and-async-calls) |
| Runner | One Node.js child process per run, killed with everything it spawned when the result is back; TypeScript; npm imports installed automatically; `seven.llm.chat` for calling the model | [runner.md](docs/runner.md) |
| Docker | `dev` and `runtime` targets from one pinned Node image | [docker.md](docs/docker.md) |

Seven first ran code in a QuickJS-in-wasm VM modelled on
[nine](https://github.com/djordlucas/nine)'s; [adr/child-process-runner.md](adr/child-process-runner.md)
records why it moved to child processes.

## Development

```bash
make dev        # shell in the dev container, repo at /app
make ci         # typecheck + lint + tests, in the dev container
make test-net   # including the npm-bundling test (network)
```

`AGENT.md` is the working agreement (branches, commits, the cross-layer
checklist); `DOCS_STYLE.md` governs every Markdown file.

## Project status

Experimental. Seven is a bootstrap: the loop, the VM and the tool store work and
are tested; nothing has been tuned against real sessions yet.

## Roadmap

- Context management for long-lived agents.
- Letting the agent read and change seven's own source, gated by `make ci`.
- An eval set of tasks that require building tools, to measure what the agent
  builds and reuses.

## Limits

| Limit | Detail |
|-------|--------|
| No permission model | Deliberate: generated code can do anything the seven process can. Run it in its container. |
| No context management | Long-lived agents eventually exceed the model's context window. |
| One process per workspace | Agents run in the one process holding the workspace's lease. |
| One version per npm package | All tools share one `node_modules`; upgrading a package changes every tool that imports it. |

## Contributing

This repository does not accept external pull requests; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](.github/SECURITY.md).

## License

[GPL-3.0](LICENSE).
