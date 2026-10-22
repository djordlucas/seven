# Context compaction

When an agent's next request nears the model's context window, seven folds the
older part of its conversation into a summary and sends only the recent part
message by message. The summary rides in the agent's system prompt. Folded
messages stay in the state database; they are no longer sent. Every agent is
compacted the same way, so a continuous agent can run indefinitely.

## When it happens

| Trigger | Condition | Then |
|---------|-----------|------|
| Threshold | Before a step, the estimated request is above 75% of `SEVEN_CONTEXT_TOKENS` | Compact, then call the model |
| Overflow | The model rejects a request as too long (a 400, 413 or 422 that names tokens, context or length) | Compact, then make the call once more; a second rejection fails the turn |
| Manual | `/compact` in the interactive session (the root agent) | Compact now |

The estimate is the request's size in characters — system prompt, conversation
and tool schemas — divided by characters per token. That ratio starts at a
conservative 3 and is recalibrated after every reply from the prompt token
count the model reports, within 1.5 to 6.

## What is kept

1. The cut keeps the most recent messages that fit in 25% of the window,
   starting at a user message when one fits, else at an assistant message. It
   never starts at a tool result, whose call would be folded away. When no
   such part fits, the shortest one is kept.
2. Everything before the cut goes to the summarizer, with the previous summary
   when there is one. It is sent in chunks of at most 50% of the window; each
   chunk's summary becomes the previous summary of the next. Each message is
   cut to 4,000 characters (start and end) for the summarizer.
3. The summarizer is the same model, with no tools, asked to keep requests and
   instructions and who gave them, the task in progress and its next step,
   decisions, the paths, tools, runs and agents in play, errors and fixes, and
   what is still open. Its reply is capped at 8% of the window.
4. The summary replaces the previous one in the agent's state, and the agent's
   context starts after the last folded message.

The system prompt ends with `## Earlier in this conversation` and the summary.
When the kept part starts at an assistant message — the cut fell inside a turn
— the request carries a one-line user message before it, saying earlier
messages are summarized; it is not stored.

## Failures

| Failure | Result |
|---------|--------|
| The summarizer call fails at the threshold | `context compaction failed` is logged and the step goes ahead with the whole conversation |
| The summarizer call fails after an overflow | The turn fails with that error |
| Nothing can be folded (one message, or one giant step) | `context not compacted` is logged; at an overflow, the model's error fails the turn |

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `SEVEN_CONTEXT_TOKENS` | `128000` | The model's context window, in tokens. Set it to the model's actual window; the thresholds above are shares of it. |

## Limits

| Limit | Detail |
|-------|--------|
| Summaries lose detail | What the summarizer drops is gone from the agent's view; the messages are still in the `messages` table for people, not for the agent. |
| One giant step cannot be compacted | A turn's latest step is always kept whole; tool results are capped at 16,000 characters, but 40 of them in one turn can still exceed a small window. |
| The estimate is approximate | Until the first reply reports usage, and after a restart, the ratio is the default 3 characters per token. |
| Overflow is recognised by its wording | A provider error that does not mention tokens, context or length is not treated as an overflow. |
| `/compact` is root-only | Other agents compact only at the threshold or on overflow. |
