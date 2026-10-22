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

Seven is one Node.js process. There is no daemon and no persistence beyond files:

- The **CLI** (`src/main.ts`) runs one **agent loop** (`src/agent`) per process.
- The loop calls **Mistral** (`src/llm/mistral.ts`) with the built-in tools plus
  every **generated tool** in the **tool store** (`src/tools/store.ts`,
  `$SEVEN_HOME/tools/`). The store is re-read every model step, so a tool the
  agent defines is callable on its next step.
- Built-in and generated code runs in the **VM** (`src/vm`): QuickJS compiled to
  wasm, one fresh runtime per run, with host functions exposed as `seven:*`
  modules. The VM has **no permission model** by design (`docs/vm.md`).

Terms like tool, generated tool, run, host module and workspace are used
precisely; see `docs/glossary.md`.

## Changes that cross layers

- **Adding a host module or function** touches three places in lockstep: the
  implementation in `src/vm/host.ts` (or the `host` option of `createVM` for one
  that needs agent state, like `seven:llm` in `src/main.ts`), the module list in
  the system prompt (`src/agent/prompt.ts`) — the model only uses what it is told
  exists — and the host module table in `docs/vm.md`.
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
