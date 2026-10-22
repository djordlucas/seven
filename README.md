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
four tools — run code, and define, read and delete its own tools — and when a
task needs a capability it lacks, it writes a tool for it, saves it, and uses it
on its next step. Every line of code the model writes runs in a QuickJS
interpreter compiled to WebAssembly, with full access to files, the shell, the
network and npm. The model is Mistral's, through its hosted API.

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
| Generated tools | ES modules the agent writes with `define_tool`, saved under `$SEVEN_HOME/tools/` with their source and bundle | [architecture.md](docs/architecture.md#generated-tools) |
| VM | QuickJS in wasm, one fresh runtime per run; TypeScript and npm imports bundled by esbuild; host functions as `seven:fs`, `seven:shell`, `seven:env`, `seven:wasm`, `seven:llm`; raw WASI modules on Node's wasm engine | [vm.md](docs/vm.md) |
| Docker | `dev` and `runtime` targets from one pinned Node image | [docker.md](docs/docker.md) |

The VM is a simpler equivalent of [nine](https://github.com/djordlucas/nine)'s
tool VM, without its capability model; [adr/vm-runtime.md](adr/vm-runtime.md)
records what was kept and what was dropped.

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
| Browser-compatible npm packages only | Packages that need Node built-ins fail to bundle or to run. |

## Contributing

This repository does not accept external pull requests; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](.github/SECURITY.md).

## License

[GPL-3.0](LICENSE).
