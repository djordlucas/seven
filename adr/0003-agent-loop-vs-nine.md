# 0003: Agent loop vs nine

Status: **recorded** — a cross-project comparison of the two agent loops; no
code change. Nine was read at `main` @ `8b4f2c0` (pushed 2026-11-23) from a
local clone; seven at `main` @ `f90f772`.

Both loops are stateful ReAct: append the user message, call the model, run
every tool call in the reply as an observation, repeat until a reply has no
tool calls. They diverge in four places: how context stays inside the window,
how the tool list is chosen, how failures and stuck turns are handled, and what
surrounds the loop (queue, reasoning, observability). Nine replaces
summarization and a step cap with trimming plus guards and retries; seven
keeps compaction, a hard step budget and mid-turn resume, and adds
agent-authored tools and multi-agent mail on top.

## Scope and method

Read in seven: `seven/agent/agent.py`, `supervisor.py`, `compact.py`,
`prompt.py`, `jobs.py`, `seven/core/llm.py`, `docs/architecture.md`,
`docs/compaction.md`. Read in nine: `internal/agent/loop.go`, `dispatcher.go`,
`repeats.go`, `promotions.go`, `spill.go`, `refs.go`, `internal/llm/queue.go`,
`internal/context/builder.go`, `docs/agent-loop.md`, `docs/context-builder.md`,
`docs/tool-selection.md`, `docs/thinking-and-planning.md`. Claims cite code;
where a claim rests on measurement, nine's own docs say so.

## The shared core

| Behavior | seven | nine |
|---|---|---|
| Loop shape | ReAct until a reply has no tool calls; several calls in one reply run in order (`agent.py` `turn`) | Same, with a per-turn scratchpad expanded into message pairs (`loop.go` `Run`, `docs/context-builder.md`) |
| Durability | Every message persisted as produced (`state.append_message`) | History + scratchpad in memory, checkpointed after each turn (`SaveState`/`LoadState`) |
| Long tool output | Spilled above 2,000 chars to a memory file and read back in chunks; hard cut at 16,000 chars | Spilled above 2,048 tokens (~8,000 chars) into the file store with a head+tail preview |
| Token estimate | chars/3 by default, recalibrated from reported usage within 1.5–6 (`compact.py` `TokenEstimator`) | 3.45 bytes/token, calibration moves up only to 1.6×, reconciled against provider counts every call (`docs/context-builder.md`) |
| Unknown tool | `error: no tool named …` as the observation, never an exception (`agent.py` `dispatch`) | No registered handler; the failure goes through the retry rules and lands as an observation |
| Memory | Per-agent key/value `remember`/`recall`/`forget` with paging | `memory_get`/`memory_set`/`memory_list` plus `memory_embed`/`memory_query` |

## What nine does that seven doesn't

| Mechanism | What it does | Where in nine |
|---|---|---|
| Priority LLM queue | Serializes all model calls supervisor > active conversation > background, and reports queue waits as a UI stage | `internal/llm/queue.go`, priorities in `provider.go` |
| Native thinking and plan modes | Per-inner-call `think` flag (default: first call of a turn only), plan mode off/plan-only/always switchable live per session, a per-turn force, streamed reasoning trace; capability probed from Ollama | `loop.go` `thinkFor`, `DefaultThinkPolicy`, `SetPlanMode` (`docs/thinking-and-planning.md`) |
| Planning fallback and approval | A tool-free analysis pass when the model cannot think; a human plan-review checkpoint whose clarification folds back in and re-runs the pass | `loop.go` `runAnalysisPass`, `PlanReviewFn` |
| Tool-call retries | Up to 3 attempts, no backoff; skips retries for refused approvals, errors that state `retryable: false`, and calls with no arguments; failure observations say what to do instead | `loop.go` `dispatchWithRetry`, `statedRetryable` |
| Stuck-turn guards | An identical call returning an identical result is noticed from the 3rd and ends the turn at the 5th; an empty model answer is re-drawn twice, then a fallback that is not added to history. The loop has no step cap | `repeats.go`, `maxEmptyAnswerRetries` in `loop.go` |
| Ranked and deferred tool exposition | Embedding-cosine ranking picks top 20 tools plus an always-include set; deferred mode lists the rest by name in an index, loads on call (call-to-load promotes with the schema), LRU-demotes past a 1,500-token budget; hybrid re-ranks 3 picks against the latest tool results; mid-turn `tool_search`/`skill_search`/`doc_search` reach the full catalogs | `internal/context/builder.go`, `promotions.go`, `loop.go` `loadOnFailedCall`, `docs/tool-selection.md` |
| Budget-waterfall context | Priority-ordered assembly (system core, tools, self-model capped 600, enrichment capped 300, history, scratchpad, extras) with oldest-first trimming and no summarization; a notice fires past 90% of budget and re-arms | `internal/context/builder.go`, `loop.go` `maybeWarnContext` (`docs/context-builder.md`) |
| Spill previews and reference args | Over-cap output lands under `spill/` in the file store; the model gets a 1,536-char head+tail preview with imperative read-back instructions; `x-nine-ref` arguments pass content by reference | `spill.go`, `refs.go`, `dispatcher.go` `capOrSpill` |
| Taint and turn restriction | Process-driven turns run restricted to an allowlist with a per-call guard; reading untrusted data restricts the rest of the turn; the restricted input is replaced by a stub in the history afterwards | `loop.go` `TurnRestriction`, `Taint`, `RestrictedInputStub` |
| Observability hooks | Per-turn callbacks for tool start/end (outcome with spill path, attempts, duration, error), context usage, LLM request/response, streamed chunks, stage labels, notices, promotions — feeding the durable event journal; `InspectContext` dry-runs assembly without calling the model | `loop.go` `Hooks` |
| Role-gated tool registration | Only a role's tools are registered on its dispatcher; the advertised set can refresh between turns | `dispatcher.go`, `loop.go` `refreshTools`, `docs/roles.md` |

## What seven does that nine doesn't

| Mechanism | What it does | Where in seven |
|---|---|---|
| Summarizing compaction | Folds the older part of the conversation into a rolling LLM summary carried in the system prompt — triggered at 75% of the window, on a provider overflow (400/413/422 wording), or manually; keeps the newest 25%, cut at a user message | `agent/compact.py`, `agent/agent.py` `compact`, `docs/compaction.md` |
| Hard step budget | A turn ends at `max_steps` (default 40, `SEVEN_MAX_STEPS`) with a "Stopped after N steps" answer appended to the conversation | `agent/agent.py` `turn` |
| Mid-turn restart recovery | Messages persist as they are produced; on start `repair()` closes interrupted tool calls with an error message and `needs_resume` restarts an unfinished turn; lost background runs are marked | `agent/agent.py` `repair`/`needs_resume`, `supervisor.py` `start` |
| Reveal-based tool discovery | The advertised list is core tools + meta tools + revealed tools + loaded-skill tools; `describe_tool` reveals one; `SEVEN_TOOL_DISCOVERY=0` sends every enabled tool every step | `agent/agent.py` `context`, `agent/prompt.py` |
| Skills that bundle tools | `load_skill` adds the skill's tools to the advertised list and applies its instructions from the next step; a tool used by a skill cannot be deleted | `agent/prompt.py`, `tools/builtins/skills.py` |
| Agent-authored tools | `define_tool` installs model-written Python, run by the runner in a fresh child process, shared by every agent, with `tool_health`/`disable_tool`/`enable_tool`; nine deliberately removed its tool-authoring tier and writes skills instead | `tools/store.py`, `tools/builtins/`, `execution/runner.py`; nine's `adr/modular_nine.md` §9.10 |
| Multi-agent modes and mail | request/sequence/continuous agents, `delegate` returning only the child's final answer, `send_message`/`wait_message` between any peers, and a `supervisor` peer with line-based control commands | `agent/supervisor.py`, `agent/commands.py`, `docs/agents.md` |
| Persisted jobs | task/goal/periodic jobs drive turns on an agent across restarts; goal jobs get a YES/NO model check after each turn | `agent/jobs.py` |
| Provider-level retries | 429/5xx responses retried up to 5 times with backoff honoring `retry-after`; non-streamed calls; concurrency capped at 4 (`SEVEN_LLM_CONCURRENCY`) by a plain semaphore — no priorities | `core/llm.py` `Mistral` |

## Trade-offs

Context is the biggest divergence. Nine trims the oldest history and that
content is gone from the turn (`docs/context-builder.md` "Trimming is not
compaction"); seven compacts, so a summary survives but the summarizer can drop
detail. Nine pays for its waterfall with an embedder and a ranking step that
can rank the needed tool out of the top 20; seven's reveal list is dumb but
predictable and costs nothing.

Turn bounds differ in kind. Seven's `max_steps` is an absolute bound on any
turn; nine has no step cap in `internal/agent` — its guards catch identical
repeated calls and empty answers, but a model alternating between two
different calls is only stopped by eventually answering.

Failures cost differently. Seven's single-attempt dispatch never spends extra
calls on a deterministic failure; nine's three attempts absorb transient
flakes but triple the cost of permanent ones, mitigated by the skip rules for
refusals, stated non-retryable errors and missing arguments.

Security posture differs. Nine's taint tracking and per-turn restrictions are
built against instructions riding in process-generated input; seven has no
equivalent — and its runner has no permission model by design
(`docs/runner.md`) — so neither system is safe against a hostile prompt, only
nine's loop is instrumented for it.

## Limits

| Limit | Detail |
|---|---|
| Point in time | nine @ `8b4f2c0` (2026-11-23), seven @ `f90f772`; nine is experimental and its README says interfaces change without notice |
| No execution | Neither system was run for this; behavioral claims come from docs and code. Measurements quoted (empty-answer rate, token ratio, exposition costs) are nine's own eval numbers |
| nine read via clone | nine takes no pull requests, so this record lives in seven by choice, not because nine's `adr/` was unavailable |
