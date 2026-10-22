// A whole seven around a scripted model, for tests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SupervisorEvent } from "../src/agent/supervisor.ts";
import { createSeven, type Seven } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ChatModel, Completion, Message, ToolDef } from "../src/llm/mistral.ts";

export type Reply =
  | Completion["message"]
  | ((seen: Message[]) => Completion["message"] | Promise<Completion["message"]>);

/**
 * Plays back a script per agent, recognising the agent from its system prompt,
 * and records every request. A reply may be a function of the conversation.
 */
export class ScriptedModel implements ChatModel {
  readonly seen: { agent: string; messages: Message[]; tools: ToolDef[] }[] = [];
  private readonly scripts: Map<string, Reply[]>;

  constructor(scripts: Record<string, Reply[]>) {
    this.scripts = new Map(Object.entries(scripts).map(([k, v]) => [k, [...v]]));
  }

  /** Add replies for an agent, e.g. one spawned later or after a restart. */
  add(agent: string, ...replies: Reply[]): void {
    this.scripts.set(agent, [...(this.scripts.get(agent) ?? []), ...replies]);
  }

  async complete(req: { messages: Message[]; tools?: ToolDef[]; signal?: AbortSignal }): Promise<Completion> {
    const system = String(req.messages[0]?.content ?? "");
    const agent = /^You are agent (\S+)/.exec(system)?.[1] ?? "seven";
    this.seen.push({ agent, messages: structuredClone(req.messages), tools: req.tools ?? [] });
    const next = this.scripts.get(agent)?.shift();
    if (!next) throw new Error(`script exhausted for ${agent}`);
    if (req.signal?.aborted) throw new Error("aborted");
    return { message: typeof next === "function" ? await next(req.messages) : next };
  }

  /** What one agent was sent, in order. */
  of(agent: string): { messages: Message[]; tools: ToolDef[] }[] {
    return this.seen.filter((s) => s.agent === agent);
  }

  /** The tool results one agent has seen, in order. */
  toolResults(agent: string): string[] {
    const last = this.of(agent).at(-1);
    return (last?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
  }
}

export const call = (id: string, name: string, args: unknown) => ({
  role: "assistant" as const,
  content: null,
  tool_calls: [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});

export const say = (content: string) => ({ role: "assistant" as const, content });

export interface Harness extends Seven {
  model: ScriptedModel;
  workspace: string;
  events: SupervisorEvent[];
  close(): Promise<void>;
}

/** A started seven in a fresh workspace (or `workspace`, to restart on an existing one). */
export function harness(
  scripts: Record<string, Reply[]>,
  opts: { workspace?: string; env?: Record<string, string> } = {},
): Harness {
  const workspace = opts.workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "seven-test-"));
  const cfg = loadConfig({ SEVEN_WORKSPACE: workspace, SEVEN_MAX_STEPS: "10", ...opts.env });
  const model = new ScriptedModel(scripts);
  const events: SupervisorEvent[] = [];
  const seven = createSeven(cfg, model, (e) => events.push(e));
  seven.supervisor.start();
  return {
    ...seven,
    model,
    workspace,
    events,
    async close() {
      await seven.supervisor.shutdown();
      seven.state.close();
    },
  };
}

export async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}
