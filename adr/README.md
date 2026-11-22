# ADRs

`adr/` records decisions: why seven is the way it is. `docs/` describes the
present; an ADR is the record of how it got there and stays put after the
decision ships. New ADRs are numbered (`0001-…`, `0002-…`).

| ADR | Decision |
|-----|----------|
| [0001-python-fastapi-reset.md](0001-python-fastapi-reset.md) | Reset the codebase from Node.js/TypeScript to Python/FastAPI: seven is one FastAPI process with an API and a companion UI |

## Limits

| Limit | Detail |
|-------|--------|
| No retroactive edits | An ADR is not updated after it ships; a reversal is a new ADR. |
