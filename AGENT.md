# Seven — working agreement

## Branching & pull requests

**Every change goes on a feature branch with a pull request. Never commit
directly to `main`.**

1. **Branch first:** `git checkout -b <type>/<slug>` — `fix/…`, `feat/…`,
   `chore/…`, `docs/…`. (`git checkout -b` carries any uncommitted work over, so
   it is safe to branch after you have started editing.)
2. **Commit on the branch**, not on `main`. Commit subjects follow
   `<type>(<scope>): <summary>` — `feat(vm): …`, `fix(agent): …`, `docs: …`.
3. **Push and open a PR:** `git push -u origin HEAD && gh pr create --fill`.
   Work reaches `main` by merging the PR, never by a local commit to `main`.

A `PreToolUse` hook (`.claude/hooks/branch-guard.sh`, wired in
`.claude/settings.json`) enforces this by **blocking `git commit` while HEAD is
on `main`**. If you hit that block, you are on `main` — branch and retry.

## Architecture at a glance

Seven is one Node.js process running many agents, with all state in one
SQLite file:

- The **CLI** (`src/main.ts`) wires everything through `src/app.ts` and holds
  the workspace's **lease**; only one process runs agents per workspace.
- The **supervisor** (`src/agent/supervisor.ts`) runs every **agent**'s loop
  (`src/agent/agent.ts`) concurrently, driving them from their **inboxes**.
  `docs/multi-agent.md` has the modes and messaging.
- Every agent calls **Mistral** (`src/llm/mistral.ts`) through one client
  capped at `SEVEN_LLM_CONCURRENCY` calls (`src/llm/limit.ts`), with the
  built-ins (`src/agent/builtins/`) plus every **generated tool** in the
  **tool store** (`src/tools/store.ts`). The store is read every model step, so
  a tool any agent defines is callable by all on their next step.
- **State** — agents, conversations, inboxes, tools, runs, the lease — is
  `<workspace>/.seven/seven.db` (`src/state/db.ts`, `node:sqlite`). All data
  lives in the workspace (`docs/data.md`).
- Built-in and generated code runs in the **runner** (`src/runner`): one Node.js
  child process per run, killed with its process group when the result is back,
  with all of Node and npm available. The runner has **no permission model** by
  design (`docs/runner.md`).

Terms like tool, generated tool, run, host module and workspace are used
precisely; see `docs/glossary.md`.

## Changes that cross layers

- **Adding a host function** (`seven.<module>.<fn>` in a run) touches four
  places in lockstep: a factory in `src/runner/host.ts` that `src/main.ts`
  passes to `createRunner`'s `host` option, a test in `test/runner.test.ts` that
  calls it from a run, the system prompt (`src/agent/prompt.ts`) — the model only
  uses what it is told exists — and the host function table in
  `docs/runner.md`. Most capabilities need none of this: a run already has all
  of Node.
- **`docs/` and `spec/` are the source of truth.** They hold the intended
  behavior; treat a code/doc mismatch as a bug to reconcile, not a doc to
  quietly follow. They ship in the runtime image, where the agent can read them.
- **`docs/` describes the present; `adr/` records how it got there.** `docs/`
  names components and concepts rather than source files and symbols. Design
  notes, plans and reviews live in `adr/`, which may cite code freely. When a
  plan in `adr/` ships, its behavior is absorbed into `docs/` and the plan stays
  put as the record.

## Documentation style

**`DOCS_STYLE.md` governs every Markdown file in this repo. Read it before
writing or editing one.** A `PreToolUse` hook
(`.claude/hooks/docs-style-guard.sh`) surfaces its rules on every `.md` read or
edit. In short: conclusion first, every sentence carries a fact, headings name
their subject, tables for anything with more than one attribute, a `## Limits`
section last, and no superseded content.

## Commit discipline

**Always verify before committing: `make ci`.** It runs typecheck (`tsc`), lint
(Biome) and the tests (`node --test`) inside the dev container, so the result
does not depend on the machine. `make ci-host` runs the same on the host's Node
(>= 24) for a quicker inner loop. A change that does not pass is not ready to
commit.

GitHub Actions is not set up for this repository; the local gate is the only
gate.

## Docker

Seven runs and is developed in Docker (`docs/docker.md`). `Dockerfile` has a
`dev` target (full toolchain, repo bind-mounted at `/app`) and a `runtime`
target (production deps, unprivileged). `make dev` opens a shell in the first,
`make run` starts the agent in the second. The dev container keeps its own
`node_modules` volume; run `make deps-reset` after changing `package.json`.

## Tests & toolchain

- Node **24**, TypeScript run directly by Node's type stripping — there is no
  build step and nothing is emitted. `tsconfig.json` sets `erasableSyntaxOnly`,
  so enums, namespaces and constructor parameter properties are type errors:
  Node cannot strip them. Relative imports carry the `.ts` extension.
- Tests live in `test/` and use `node:test`. The agent loop is tested against a
  scripted model (`test/agent.test.ts`); nothing in the default suite calls
  Mistral or the network.
- The npm-bundling test needs the network and is opt-in: `make test-net`
  (or `SEVEN_NET_TEST=1 npm test`).
