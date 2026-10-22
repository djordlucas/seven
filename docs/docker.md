# Docker

Seven runs and is developed in Docker. The image has two targets built from one
pinned Node base: `dev` for working on seven with the repository bind-mounted,
and `runtime` for running agents unprivileged. All of seven's data lives in the
workspace, `./workspace` on the host, mounted at `/workspace`. Because the VM has no
permission model (`runner.md`), the container is what bounds the agent: it sees the
mounted workspace, its own state volume, and the network.

```bash
cp .env.example .env    # set SEVEN_LLM_API_KEY
make run                # the root agent, interactive, in the runtime image
make serve              # every agent, in the background (seven serve)
make dev                # a shell in the dev container
make ci                 # typecheck + lint + tests in the dev container
```

## Targets

| Target | Image | Contents | User | Entry |
|--------|-------|----------|------|-------|
| `dev` | `seven:dev` | All dependencies, `git`, `make`; the repository at `/app` (bind mount) | root | `bash` |
| `runtime` | `seven:latest` | Production dependencies, `src/`, `docs/`, `spec/`; `git` for the agents' shell commands | `node` | `seven` |

## Volumes and paths

| Path | Service | Source | Holds |
|------|---------|--------|-------|
| `/app` | dev | the repository (bind) | seven's source |
| `/app/node_modules` | dev | `dev-node-modules` (named volume) | the container's own dependencies; the host's are built for the host platform |
| `/workspace` | all | `./workspace` (bind) | `SEVEN_WORKSPACE`: where agents work, and all of seven's data in `.seven/` |

## Make targets

| Target | Runs |
|--------|------|
| `make dev` | A shell in the dev container |
| `make run` | The root agent in the runtime image, interactive |
| `make serve`, `make serve-stop` | `seven serve` in the background (`seven-serve` service, restarted unless stopped), and stopping it. Its log lines are in `docker compose logs seven-serve` as well as in `.seven/logs/`. |
| `make ci` | `make ci-host` inside the dev container: typecheck, lint, tests |
| `make test`, `make lint`, `make typecheck`, `make fmt` | The single step, in the dev container |
| `make test-net` | The tests including npm bundling, which needs the network |
| `make image` | Builds `seven:latest` |
| `make deps-reset` | `npm ci` into the dev container's `node_modules` volume |
| `make clean` | Removes the containers and the dev `node_modules` volume; `./workspace`, and so all of seven's data, is untouched |
| `make *-host` | The same step on the host's Node (>= 24) |

One message without the Makefile: `docker compose run --rm seven "<message>"`.

## Limits

| Limit | Detail |
|-------|--------|
| Stale dev dependencies | The `dev-node-modules` volume is populated once, from the image; after a `package.json` change run `make deps-reset`. |
| Full network access | The container is not network-restricted; the agent can reach any host the Docker network can. |
| No published image | Images are built locally; nothing is pushed to a registry. |
