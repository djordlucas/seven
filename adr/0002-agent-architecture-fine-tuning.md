# 0002: Agent architecture fine tuning

Status: **proposed** — requirements and design are being discussed before any
code changes. The Decision section is a placeholder until they are agreed;
this ADR becomes accepted when the design lands and implementation starts.

## Context

The Python/FastAPI reset ([0001](0001-python-fastapi-reset.md)) is merged
(PR #14). Seven now runs as one FastAPI process: supervisor and agent loops in
asyncio, one Mistral client, built-ins plus generated tools, a Python
child-process runner, SQLite state in `.seven/seven.db`, REST + SSE + UI.

The maintainer wants to change the agent architecture in small, deliberate
steps — new branch `feat/agent-architecture-fine-tuning` — starting from a
requirements and design discussion, recorded here before implementation.

## Decision

Pending. To be recorded here once requirements and design are agreed:

| Aspect | To be decided |
|--------|---------------|
| Requirements | What behavior should change, and why (the problem being solved) |
| Design | The chosen approach, the components it touches, and the alternatives rejected |
| Consequences | What follows from the choice: limits, migrations, doc updates |

## Consequences

None yet. No code changes on this branch until this ADR moves from proposed to
accepted; `docs/` is updated in the same change that implements the decision.

## Limits

| Limit | Detail |
|-------|--------|
| Placeholder | This ADR records intent only; it does not describe any shipped behavior. |
