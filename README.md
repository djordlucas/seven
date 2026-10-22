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
only the tools to run code, manage its own tools and control background runs.
When a task needs a capability it lacks, it writes a tool for it, saves it, and
uses it on its next step, either synchronously or as a background run it can
check on and kill. Every piece of code the model writes runs in its own Node.js
child process, with all of Node and any npm package. The model is Mistral's, through its hosted API.

Seven is a Node.js (TypeScript) program, and it runs and is developed in Docker.

## Quick start

```bash
git clone https://github.com/djordlucas/seven
cd seven
cp .env.example .env          # set SEVEN_LLM_API_KEY to a Mistral API key
make run                      # interactive session in the runtime container
```

The agent works in `./workspace`, mounted at `/workspace`. Its generated tools
persist in the `seven-data` volume.

Without Docker, on Node 24 or later:

```bash
npm install
npm start                     # interactive
npm start -- "<message>"      # one message, then exit
npm start -- tools            # list generated tools
```

## How it works

| Part | What it is | Doc |
|------|------------|-----|
| Agent loop | Model call → tool calls → results, repeated until the model answers; the tool list is re-read every step | [architecture.md](docs/architecture.md) |
| Generated tools | ES modules the agent writes with `define_tool`, saved under `$SEVEN_HOME/tools/` | [architecture.md](docs/architecture.md#generated-tools) |
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

- Session persistence, and context management for long sessions.
- Letting the agent read and change seven's own source, gated by `make ci`.
- An eval set of tasks that require building tools, to measure what the agent
  builds and reuses.

## Limits

| Limit | Detail |
|-------|--------|
| No permission model | Deliberate: generated code can do anything the seven process can. Run it in its container. |
| Memory-only conversations | A session ends with the process; only generated tools persist. |
| No context management | Long sessions eventually exceed the model's context window. |
| One version per npm package | All tools share one `node_modules`; upgrading a package changes every tool that imports it. |

## Contributing

This repository does not accept external pull requests; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](.github/SECURITY.md).

## License

[GPL-3.0](LICENSE).
