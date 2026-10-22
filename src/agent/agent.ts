// The agent loop: ask the model, run the tools it calls, repeat until it
// answers without calling one.

import type { ChatModel, Message, ToolCall, ToolDef } from "../llm/mistral.ts";
import type { Runner } from "../runner/index.ts";
import type { ToolStore } from "../tools/store.ts";
import { type Builtin, builtins, disabledError, formatRun, startGenerated } from "./builtins.ts";
import { systemPrompt } from "./prompt.ts";
import { RunTable, summarize } from "./runs.ts";

/** Longest tool result handed back to the model, in characters. */
const MAX_RESULT_CHARS = 16_000;

export type AgentEvent =
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "answer"; text: string };

export interface AgentOptions {
  model: ChatModel;
  runner: Runner;
  store: ToolStore;
  workspace: string;
  maxSteps: number;
  onEvent?: (e: AgentEvent) => void;
}

export class Agent {
  readonly history: Message[] = [];
  readonly runs = new RunTable();
  private readonly opts: AgentOptions;
  private readonly builtins: Map<string, Builtin>;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.builtins = new Map(builtins(opts.runner, opts.store, this.runs).map((b) => [b.name, b]));
  }

  /** Handle one user message; resolves with the final answer. */
  async send(text: string, signal?: AbortSignal): Promise<string> {
    const { model, store, maxSteps } = this.opts;
    this.history.push({ role: "user", content: text });

    for (let step = 0; step < maxSteps; step++) {
      // Re-read every step: a tool defined on the previous step is callable now.
      const own = store.list();
      const tools: ToolDef[] = [
        ...[...this.builtins.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
        ...own
          .filter((t) => !t.disabled)
          .map(({ name, description, parameters }) => ({ name, description, parameters })),
      ];
      const runs = this.runs
        .list()
        .filter((r) => !r.result || !r.checked)
        .map((r) => summarize(r));
      const system: Message = {
        role: "system",
        content: systemPrompt({ workspace: this.opts.workspace, tools: own, runs }),
      };

      const { message } = await model.complete({ messages: [system, ...this.history], tools, signal });
      this.history.push(message);

      if (!message.tool_calls?.length) {
        const answer = message.content ?? "";
        this.emit({ type: "answer", text: answer });
        return answer;
      }
      for (const call of message.tool_calls) {
        const result = truncate(await this.dispatch(call));
        this.history.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
      }
    }

    const stopped = `Stopped after ${maxSteps} steps without a final answer.`;
    this.emit({ type: "answer", text: stopped });
    return stopped;
  }

  private async dispatch(call: ToolCall): Promise<string> {
    const { name, arguments: raw } = call.function;
    this.emit({ type: "tool_call", name, args: raw });

    let result: string;
    try {
      const args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const builtin = this.builtins.get(name);
      const own = builtin ? undefined : this.opts.store.get(name);
      if (builtin) result = await builtin.run(args);
      else if (own?.meta.disabled) result = disabledError(own);
      else if (own) result = formatRun(await startGenerated(this.opts.runner, this.opts.store, own, args, "sync").done);
      else result = `error: no tool named "${name}"`;
    } catch (err) {
      result = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    this.emit({ type: "tool_result", name, result });
    return result;
  }

  private emit(e: AgentEvent): void {
    this.opts.onEvent?.(e);
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${s.length - MAX_RESULT_CHARS} of ${s.length} characters]`;
}
