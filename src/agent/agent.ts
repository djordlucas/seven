// One agent's loop: ask the model, run the tools it calls, repeat until it
// answers without calling one. Its conversation lives in the state database,
// one row per message, so a turn cut off by a restart resumes where it stopped.
// When the conversation nears the context window, its older part is compacted
// into a summary (compact.ts).

import { randomUUID } from "node:crypto";
import type { ChatModel, Completion, Message, ToolCall, ToolDef } from "../llm/mistral.ts";
import { type Logger, preview } from "../log.ts";
import type { Runner } from "../runner/index.ts";
import type { AgentRow, State } from "../state/db.ts";
import type { ToolStore } from "../tools/store.ts";
import { awaitRun, type BuiltinContext, builtins, disabledError, formatRun, startGenerated } from "./builtins/index.ts";
import {
  COMPACT_AT,
  cutIndex,
  isOverflow,
  KEEP,
  requestChars,
  summarizeConversation,
  TokenEstimator,
} from "./compact.ts";
import { systemPrompt } from "./prompt.ts";
import { type RunTable, summarize } from "./runs.ts";
import type { Supervisor } from "./supervisor.ts";

/** Longest tool result handed back to the model, in characters. */
const MAX_RESULT_CHARS = 16_000;

export type AgentEvent =
  | { type: "tool_call"; agent: string; name: string; args: string }
  | { type: "tool_result"; agent: string; name: string; result: string }
  | { type: "answer"; agent: string; text: string }
  | { type: "compacted"; agent: string; folded: number; kept: number };

/** Why a conversation was compacted: it neared the window, overflowed it, or was asked to. */
export type CompactReason = "threshold" | "overflow" | "manual";

export interface AgentDeps {
  state: State;
  store: ToolStore;
  runner: Runner;
  runs: RunTable;
  model: ChatModel;
  supervisor: Supervisor;
  workspace: string;
  maxSteps: number;
  /** The model's context window, in tokens. */
  contextTokens: number;
  /** Bound to this agent. */
  log: Logger;
  onEvent?: (e: AgentEvent) => void;
}

/** Where a turn's input came from, for logs. */
export type InputKind = "user" | "task" | "message" | "wake";

export class Agent {
  readonly id: string;
  private readonly deps: AgentDeps;
  private abort?: AbortController;
  private turning = false;
  private readonly estimator = new TokenEstimator();

  constructor(deps: AgentDeps, id: string) {
    this.deps = deps;
    this.id = id;
  }

  row(): AgentRow {
    const row = this.deps.state.getAgent(this.id);
    if (!row) throw new Error(`agent ${this.id} is gone`);
    return row;
  }

  get busy(): boolean {
    return this.turning;
  }

  /** Whether the last turn was cut off: the conversation ends on input the model has not answered. */
  needsResume(): boolean {
    const last = this.deps.state.history(this.id).at(-1);
    return last !== undefined && (last.role === "user" || last.role === "tool");
  }

  /**
   * Close tool calls a restart cut off, so the conversation is valid to send:
   * every tool call gets a result.
   */
  repair(): void {
    const history = this.deps.state.history(this.id);
    const lastAssistant = history.findLastIndex((m) => m.role === "assistant");
    const calls =
      lastAssistant >= 0 ? (history[lastAssistant] as Extract<Message, { role: "assistant" }>).tool_calls : undefined;
    if (!calls?.length) return;
    const answered = new Set(
      history.slice(lastAssistant + 1).flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])),
    );
    const cut = calls.filter((c) => !answered.has(c.id));
    if (cut.length > 0) {
      this.deps.log.warn("interrupted tool calls closed", { tools: cut.map((c) => c.function.name) });
    }
    for (const c of cut) {
      this.append({
        role: "tool",
        tool_call_id: c.id,
        name: c.function.name,
        content: "error: interrupted — seven restarted before this call finished",
      });
    }
  }

  /** Stop the turn in progress, if any. */
  interrupt(): void {
    this.abort?.abort();
  }

  /**
   * Run one turn. With `input`, it is appended first (an inbox item is marked
   * delivered in the same transaction); without, the turn resumes an
   * unanswered conversation. Resolves with the final answer.
   */
  async turn(input?: { text: string; inboxId?: number; kind?: InputKind }): Promise<string> {
    if (this.turning) throw new Error(`agent ${this.id} is already in a turn`);
    this.turning = true;
    this.abort = new AbortController();
    const { state } = this.deps;
    const log = this.deps.log.child({ turn: randomUUID().slice(0, 8) });
    const started = performance.now();
    let steps = 0;
    log.info("turn started", {
      input: input ? (input.kind ?? "user") : "resume",
      ...(input?.inboxId !== undefined && { inbox_id: input.inboxId }),
      ...(log.enabled("debug") && input && { text: preview(input.text) }),
    });
    try {
      state.updateAgent(this.id, { status: "running" });
      if (input) {
        state.tx(() => {
          this.append({ role: "user", content: input.text });
          if (input.inboxId !== undefined) state.markDelivered(input.inboxId);
        });
      }

      const maxSteps = this.row().maxSteps ?? this.deps.maxSteps;
      for (let step = 0; step < maxSteps; step++) {
        steps = step + 1;
        const stepLog = log.child({ step: steps });
        this.deliverMessages(stepLog);
        const { message } = await this.complete(stepLog);
        this.append(message);

        if (!message.tool_calls?.length) {
          const answer = message.content ?? "";
          log.info("turn finished", {
            outcome: "answered",
            steps,
            duration_ms: Math.round(performance.now() - started),
            answer_chars: answer.length,
            ...(log.enabled("debug") && { answer: preview(answer) }),
          });
          this.emit({ type: "answer", agent: this.id, text: answer });
          return answer;
        }
        for (const call of message.tool_calls) {
          const result = truncate(await this.dispatch(call, stepLog));
          this.append({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
        }
      }

      const stopped = `Stopped after ${maxSteps} steps without a final answer.`;
      log.warn("turn finished", { outcome: "max_steps", steps, duration_ms: Math.round(performance.now() - started) });
      this.append({ role: "assistant", content: stopped });
      this.emit({ type: "answer", agent: this.id, text: stopped });
      return stopped;
    } catch (err) {
      const aborted = this.abort?.signal.aborted ?? false;
      log[aborted ? "info" : "error"]("turn ended early", {
        outcome: aborted ? "interrupted" : "error",
        steps,
        duration_ms: Math.round(performance.now() - started),
        ...(!aborted && { error: err }),
      });
      throw err;
    } finally {
      this.turning = false;
      this.abort = undefined;
      // Running means "in a turn"; an agent that was stopped meanwhile keeps its terminal status.
      const status = state.getAgent(this.id)?.status === "running" ? "idle" : undefined;
      state.updateAgent(this.id, { lastTurnAt: new Date().toISOString(), ...(status && { status }) });
    }
  }

  /** The last answer the agent gave. */
  lastAnswer(): string | null {
    const last = this.deps.state.history(this.id).findLast((m) => m.role === "assistant" && !m.tool_calls?.length) as
      | Extract<Message, { role: "assistant" }>
      | undefined;
    return last?.content ?? null;
  }

  /**
   * Fold the older part of the conversation into the summary, keeping the
   * recent messages that fit a quarter of the context window. Resolves with
   * what was folded, or undefined when there was nothing to fold.
   */
  async compact(
    reason: CompactReason,
    log: Logger = this.deps.log,
  ): Promise<{ folded: number; kept: number } | undefined> {
    const { state, model, contextTokens } = this.deps;
    const rows = state.context(this.id);
    const cut = cutIndex(
      rows.map((r) => r.message),
      this.estimator.chars(contextTokens * KEEP),
    );
    if (cut === 0) {
      log.warn("context not compacted", { reason, detail: "nothing to fold", messages: rows.length });
      return undefined;
    }
    const started = performance.now();
    const before = this.estimator.tokens(
      requestChars(
        rows.map((r) => r.message),
        [],
      ),
    );
    const summary = await summarizeConversation(model, {
      previous: this.row().summary,
      messages: rows.slice(0, cut).map((r) => r.message),
      contextTokens,
      estimator: this.estimator,
      signal: this.abort?.signal,
      log,
    });
    state.compact(this.id, summary, (rows[cut - 1] as { id: number }).id);
    const after = this.estimator.tokens(requestChars(state.history(this.id), []) + summary.length);
    const out = { folded: cut, kept: rows.length - cut };
    log.info("context compacted", {
      reason,
      ...out,
      tokens_before: before,
      tokens_after: after,
      summary_chars: summary.length,
      compactions: this.row().compactions,
      duration_ms: Math.round(performance.now() - started),
      ...(log.enabled("debug") && { summary: preview(summary) }),
    });
    this.emit({ type: "compacted", agent: this.id, ...out });
    return out;
  }

  /**
   * One model call on the current conversation. The conversation is compacted
   * first when the request is estimated near the window, or after the model
   * refuses it as too long (then the call is made once more).
   */
  private async complete(log: Logger): Promise<Completion> {
    const window = this.deps.contextTokens;
    let req = this.request();
    if (this.estimator.tokens(req.chars) > window * COMPACT_AT) {
      try {
        if (await this.compact("threshold", log)) req = this.request();
      } catch (err) {
        if (this.abort?.signal.aborted) throw err;
        log.error("context compaction failed", { reason: "threshold", error: err });
      }
    }
    try {
      return await this.send(req, log);
    } catch (err) {
      if (this.abort?.signal.aborted || !isOverflow(err)) throw err;
      log.warn("context overflowed", { tokens_estimated: this.estimator.tokens(req.chars), window });
      if (!(await this.compact("overflow", log))) throw err;
      return await this.send(this.request(), log);
    }
  }

  private async send(req: { messages: Message[]; tools: ToolDef[]; chars: number }, log: Logger): Promise<Completion> {
    const out = await this.deps.model.complete({
      messages: req.messages,
      tools: req.tools,
      signal: this.abort?.signal,
      log,
    });
    this.estimator.calibrate(req.chars, out.usage?.prompt_tokens);
    return out;
  }

  /** The request for the next step: system prompt, the conversation since the last compaction, the tools. */
  private request(): { messages: Message[]; tools: ToolDef[]; chars: number } {
    const { tools, system } = this.context();
    const history = this.deps.state.history(this.id);
    // A compaction can cut in the middle of a turn; the model is still owed a user message first.
    const lead: Message[] =
      history[0] && history[0].role !== "user"
        ? [{ role: "user", content: "(Earlier messages are summarized in the system prompt. Continue.)" }]
        : [];
    const messages = [system, ...lead, ...history];
    return { messages, tools, chars: requestChars(messages, tools) };
  }

  /** Messages from other agents (or the user) that arrived since the last step join the conversation now. */
  private deliverMessages(log: Logger): void {
    const { state, supervisor } = this.deps;
    for (const m of state.pending(this.id, { kind: "message" })) {
      state.tx(() => {
        this.append({ role: "user", content: supervisor.formatInbox(m) });
        state.markDelivered(m.id);
      });
      log.info("message delivered", { from: m.sender, inbox_id: m.id, chars: m.text.length });
    }
  }

  private context(): { tools: ToolDef[]; system: Message } {
    const { store, runs, supervisor, workspace } = this.deps;
    const own = store.list();
    const tools: ToolDef[] = [
      ...[...builtins().values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
      ...own.filter((t) => !t.disabled).map(({ name, description, parameters }) => ({ name, description, parameters })),
    ];
    const myRuns = runs
      .list(this.id)
      .filter((r) => r.status === "running" || !r.checked)
      .map((r) => summarize(r, runs.handle(r.id)));
    const content = systemPrompt({
      workspace,
      self: this.row(),
      tools: own,
      runs: myRuns,
      agents: supervisor.list(false).filter((a) => a.id !== this.id),
    });
    return { tools, system: { role: "system", content } };
  }

  private async dispatch(call: ToolCall, stepLog: Logger): Promise<string> {
    const { name, arguments: raw } = call.function;
    const log = stepLog.child({ call: call.id });
    this.emit({ type: "tool_call", agent: this.id, name, args: raw });
    const started = performance.now();

    let result: string;
    let kind: "builtin" | "generated" | "unknown" = "unknown";
    try {
      const args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const builtin = builtins().get(name);
      const own = builtin ? undefined : this.deps.store.get(name);
      if (builtin) {
        kind = "builtin";
        result = await builtin.run(args, this.builtinContext(log));
      } else if (own?.meta.disabled) {
        kind = "generated";
        result = disabledError(own);
      } else if (own) {
        kind = "generated";
        const ctx = this.builtinContext(log);
        result = formatRun(await awaitRun(startGenerated(ctx, own, args, "sync"), ctx.signal));
      } else result = `error: no tool named "${name}"`;
    } catch (err) {
      result = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const failed = result.startsWith("error:") || result.startsWith("not saved:");
    log[failed ? "warn" : "info"]("tool called", {
      tool: name,
      kind,
      ok: !failed,
      duration_ms: Math.round(performance.now() - started),
      result_chars: result.length,
      ...(failed && { error: preview(result, 300) }),
      ...(log.enabled("debug") && { args: preview(raw), result: preview(result) }),
    });
    this.emit({ type: "tool_result", agent: this.id, name, result });
    return result;
  }

  private builtinContext(log: Logger): BuiltinContext {
    const { runner, store, runs, supervisor, workspace, state } = this.deps;
    return {
      log,
      agentId: this.id,
      runner,
      store,
      runs,
      supervisor,
      workspace,
      stateDb: state.path,
      signal: this.abort?.signal,
    };
  }

  private append(message: Message): void {
    this.deps.state.appendMessage(this.id, message);
  }

  private emit(e: AgentEvent): void {
    this.deps.onEvent?.(e);
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${s.length - MAX_RESULT_CHARS} of ${s.length} characters]`;
}
