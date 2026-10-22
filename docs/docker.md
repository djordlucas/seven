# Docker

Seven runs and is developed in Docker. The image has two targets built from one
pinned Node base: `dev` for working on seven with the repository bind-mounted,
and `runtime` for running the agent unprivileged. Because the VM has no
permission model (`vm.md`), the container is what bounds the agent: it sees the
mounted workspace, its own state volume, and the network.

```bash
cp .env.example .env    # set SEVEN_LLM_API_KEY
make run                # the agent, interactive, in the runtime image
make dev                # a shell in the dev container
make ci                 # typecheck + lint + tests in the dev container
```

## Targets

| Target | Image | Contents | User | Entry |
|--------|-------|----------|------|-------|
| `dev` | `seven:dev` | All dependencies, `git`, `make`; the repository at `/app` (bind mount) | root | `bash` |
| `runtime` | `seven:latest` | Production dependencies, `src/`, `docs/`, `spec/`; `git` for the agent's shell commands | `node` | `seven` |

## Volumes and paths

| Path | Service | Source | Holds |
|------|---------|--------|-------|
| `/app` | dev | the repository (bind) | seven's source |
| `/app/node_modules` | dev | `dev-node-modules` (named volume) | the container's own dependencies; the host's are built for the host platform |
| `/app/.seven` | dev | inside the bind mount | `SEVEN_HOME` in development |
| `/data` | seven | `seven-data` (named volume) | `SEVEN_HOME`: generated tools and the dependency cache |
| `/workspace` | both | `./workspace` (bind) | `SEVEN_WORKSPACE`: where the agent works |

## Make targets

| Target | Runs |
|--------|------|
| `make dev` | A shell in the dev container |
| `make run` | The agent in the runtime image; arguments are not passed, so it starts interactive |
| `make ci` | `make ci-host` inside the dev container: typecheck, lint, tests |
| `make test`, `make lint`, `make typecheck`, `make fmt` | The single step, in the dev container |
| `make test-net` | The tests including npm bundling, which needs the network |
| `make image` | Builds `seven:latest` |
| `make deps-reset` | `npm ci` into the dev container's `node_modules` volume |
| `make clean` | Removes the containers and both named volumes, deleting generated tools in `seven-data` |
| `make *-host` | The same step on the host's Node (>= 24) |

One message without the Makefile: `docker compose run --rm seven "<message>"`.

## Limits

| Limit | Detail |
|-------|--------|
| Stale dev dependencies | The `dev-node-modules` volume is populated once, from the image; after a `package.json` change run `make deps-reset`. |
| Full network access | The container is not network-restricted; the agent can reach any host the Docker network can. |
| No published image | Images are built locally; nothing is pushed to a registry. |
