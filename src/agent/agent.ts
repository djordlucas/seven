// One agent's loop: ask the model, run the tools it calls, repeat until it
// answers without calling one. Its conversation lives in the state database,
// one row per message, so a turn cut off by a restart resumes where it stopped.

import type { ChatModel, Message, ToolCall, ToolDef } from "../llm/mistral.ts";
import type { Runner } from "../runner/index.ts";
import type { AgentRow, State } from "../state/db.ts";
import type { ToolStore } from "../tools/store.ts";
import { awaitRun, type BuiltinContext, builtins, disabledError, formatRun, startGenerated } from "./builtins/index.ts";
import { systemPrompt } from "./prompt.ts";
import { type RunTable, summarize } from "./runs.ts";
import type { Supervisor } from "./supervisor.ts";

/** Longest tool result handed back to the model, in characters. */
const MAX_RESULT_CHARS = 16_000;

export type AgentEvent =
  | { type: "tool_call"; agent: string; name: string; args: string }
  | { type: "tool_result"; agent: string; name: string; result: string }
  | { type: "answer"; agent: string; text: string };

export interface AgentDeps {
  state: State;
  store: ToolStore;
  runner: Runner;
  runs: RunTable;
  model: ChatModel;
  supervisor: Supervisor;
  workspace: string;
  maxSteps: number;
  onEvent?: (e: AgentEvent) => void;
}

export class Agent {
  readonly id: string;
  private readonly deps: AgentDeps;
  private abort?: AbortController;
  private turning = false;

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
    for (const c of calls) {
      if (answered.has(c.id)) continue;
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
  async turn(input?: { text: string; inboxId?: number }): Promise<string> {
    if (this.turning) throw new Error(`agent ${this.id} is already in a turn`);
    this.turning = true;
    this.abort = new AbortController();
    const { state, model } = this.deps;
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
        this.deliverMessages();
        const { tools, system } = this.context();
        const { message } = await model.complete({
          messages: [system, ...state.history(this.id)],
          tools,
          signal: this.abort.signal,
        });
        this.append(message);

        if (!message.tool_calls?.length) {
          const answer = message.content ?? "";
          this.emit({ type: "answer", agent: this.id, text: answer });
          return answer;
        }
        for (const call of message.tool_calls) {
          const result = truncate(await this.dispatch(call));
          this.append({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
        }
      }

      const stopped = `Stopped after ${maxSteps} steps without a final answer.`;
      this.append({ role: "assistant", content: stopped });
      this.emit({ type: "answer", agent: this.id, text: stopped });
      return stopped;
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

  /** Messages from other agents (or the user) that arrived since the last step join the conversation now. */
  private deliverMessages(): void {
    const { state, supervisor } = this.deps;
    for (const m of state.pending(this.id, { kind: "message" })) {
      state.tx(() => {
        this.append({ role: "user", content: supervisor.formatInbox(m) });
        state.markDelivered(m.id);
      });
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

  private async dispatch(call: ToolCall): Promise<string> {
    const { name, arguments: raw } = call.function;
    this.emit({ type: "tool_call", agent: this.id, name, args: raw });

    let result: string;
    try {
      const args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const builtin = builtins().get(name);
      const own = builtin ? undefined : this.deps.store.get(name);
      if (builtin) result = await builtin.run(args, this.builtinContext());
      else if (own?.meta.disabled) result = disabledError(own);
      else if (own) {
        const ctx = this.builtinContext();
        result = formatRun(await awaitRun(startGenerated(ctx, own, args, "sync"), ctx.signal));
      } else result = `error: no tool named "${name}"`;
    } catch (err) {
      result = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    this.emit({ type: "tool_result", agent: this.id, name, result });
    return result;
  }

  private builtinContext(): BuiltinContext {
    const { runner, store, runs, supervisor, workspace, state } = this.deps;
    return {
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
