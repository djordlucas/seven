# Context compaction

**Status:** Implemented — **Date:** 2026-10-22
**Scope:** `src/agent/compact.ts`, `src/agent/agent.ts`, `src/state/db.ts`, `src/agent/prompt.ts`

Every agent sent its whole conversation on every step, so a long-lived agent —
above all a continuous one — would eventually exceed the model's context window
and every turn after that would fail. Seven now folds an agent's older messages
into a model-written summary carried by its system prompt, and sends only the
recent messages verbatim. The schema change it needed also introduced schema
migrations.

## Decisions

| Decision | Chosen | Alternatives and why not |
|----------|--------|--------------------------|
| What replaces old messages | A summary written by the same model, merged with the previous summary on each compaction | Dropping the oldest messages (a sliding window) loses the original request first, which is what an agent most needs; truncating tool results only delays the overflow. |
| Where the summary goes | A section at the end of the system prompt, stored on the agent row | A synthetic user message in the conversation would make two user messages in a row and depend on the provider accepting that order; the system prompt is rebuilt every step anyway. |
| What happens to folded messages | Kept in `messages`; the agent row's `context_from` marks where the context starts | Deleting them would lose the record people inspect; the full transcript costs only disk. |
| When to compact | Above 75% of `SEVEN_CONTEXT_TOKENS` by estimate, and on an overflow error from the model | Only on error would make every compaction cost a failed call; only by estimate would fail when the estimate is wrong. Both are cheap. |
| Token estimate | Characters ÷ 3, recalibrated from each reply's `prompt_tokens` | A tokenizer for Mistral models is another dependency and still wrong for tool schemas' overhead; the reported count is exact for the request just sent. |
| Where to cut | The longest recent part within 25% of the window, starting at a user message if one fits, else an assistant message, never a tool result | Cutting before a tool result orphans it from its call, which the API rejects; preferring a user message keeps whole turns. |
| Cut inside a turn | Allowed, with an unstored user line before the kept part | Refusing would leave a single long turn uncompactable. |
| Long folded part | Summarized in chunks of half the window, each folded into the summary of the last | One request for everything can itself overflow. |
| Failed summary at the threshold | Logged; the step goes ahead uncompacted | Failing the turn on a summarizer error would turn an optional optimisation into an outage. |
| Schema change | `MIGRATIONS` in `src/state/db.ts`, applied in order in one transaction; version 1 stays the base `SCHEMA` | Recreating the database would lose state; editing `SCHEMA` alone would not change existing databases (`CREATE TABLE IF NOT EXISTS`). |

## Limits

This record describes the change as of its commit. Present behavior is in
`docs/compaction.md`, `docs/data.md` and `spec/contracts/agents.md`.
