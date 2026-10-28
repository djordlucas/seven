# seven runs and is developed in this image. Two targets:
#
#   dev      the toolchain (all deps, git, make) with the repo bind-mounted at
#            /app by compose.yaml; `make ci` runs here.
#   runtime  production deps and src/ only, as the unprivileged `node` user.
#
# All of seven's data — its state database, tool sources, node_modules, and
# the agents' own files and databases — lives in the workspace, /workspace.
#
# Node runs the TypeScript sources directly, so there is no build stage.
# The base is pinned to an exact tag; dependabot proposes bumps.

FROM node:26.12.0-bookworm-slim AS base
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
# git and ca-certificates are for the agent's own shell commands and for npm
# fetching guest dependencies, not for seven itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS dev
RUN apt-get update \
 && apt-get install -y --no-install-recommends make \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules node_modules
COPY . .
ENV SEVEN_WORKSPACE=/workspace
CMD ["bash"]

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS runtime
COPY --from=prod-deps /app/node_modules node_modules
COPY package.json ./
COPY src src
# The agent can read its own documentation (DOCS_STYLE.md, document types).
COPY docs docs
COPY spec spec
RUN mkdir -p /workspace && chown node:node /workspace
ENV SEVEN_WORKSPACE=/workspace \
    NODE_ENV=production
USER node
WORKDIR /workspace
VOLUME ["/workspace"]
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/src/main.ts"]
