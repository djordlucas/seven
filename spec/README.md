# Specification

`spec/` holds seven's normative contracts: numbered requirements that the code
and tests must satisfy. A mismatch between a contract and the code is a bug in
one of them, to be reconciled rather than ignored.

| Contract | Prefix | Subject |
|----------|--------|---------|
| `contracts/runner.md` | `R-RUN` | What a run guarantees to the code it runs and to the embedding program |
| `contracts/agents.md` | `R-AG` | How agents are run, messaged and persisted |

## Limits

The agent loop's steps, the tool store and the Mistral client have no contract
yet; `docs/architecture.md` is their only description.
