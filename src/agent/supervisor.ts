// The supervisor runs every agent in this process, concurrently.
//
// It owns the agents' lifecycles — spawn, drive, finish, stop — and their
// inboxes. Every agent but the root is driven by its inbox: a tick every
// POLL_MS starts a turn for each idle agent that has work. Polling the
// database, rather than only reacting in-process, is what lets `seven send`
// in another process reach an agent.

import type { ChatModel } from "../llm/mistral.ts";
import type { Runner } from "../runner/index.ts";
import { type AgentMode, type AgentRow, type InboxRow, ROOT_ID, type State, TERMINAL } from "../state/db.ts";
import type { ToolStore } from "../tools/store.ts";
import { Agent, type AgentEvent } from "./agent.ts";
import { sleep } from "./builtins/shared.ts";
import { RunTable } from "./runs.ts";

export const ROOT = ROOT_ID;
const POLL_MS = 250;
/** After a failed turn, a continuous agent waits this long before trying its inbox again. */
const RETRY_MS = 30_000;

export type SupervisorEvent =
  | AgentEvent
  | { type: "spawned"; agent: string; parent: string; name: string; mode: AgentMode }
  | { type: "finished"; agent: string; status: "done" | "failed" | "stopped"; detail: string }
  | { type: "message"; from: string; to: string; text: string };

export interface SpawnSpec {
  name: string;
  description: string;
  instructions: string;
  mode: "request" | "sequence" | "continuous";
  tasks: string[];
  intervalS: number | null;
  maxSteps: number | null;
}

export interface SupervisorOptions {
  state: State;
  store: ToolStore;
  runner: Runner;
  model: ChatModel;
  workspace: string;
  maxSteps: number;
  /** Agents other than the root that may be running or idle at once. */
  maxAgents: number;
  onEvent?: (e: SupervisorEvent) => void;
}

export class Supervisor {
  readonly runs: RunTable;
  private readonly opts: SupervisorOptions;
  private readonly agents = new Map<string, Agent>();
  private readonly retryAt = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
    this.runs = new RunTable(opts.state);
  }

  /** The root agent: the one the user talks to. The state database creates it. */
  root(): Agent {
    return this.agent(ROOT) as Agent;
  }

  /**
   * Resume every agent that had not finished, then start driving inboxes.
   * Runs left "running" by a previous process are marked lost.
   */
  start(): void {
    const { state } = this.opts;
    state.markLostRuns();
    for (const row of state.listAgents()) {
      if (TERMINAL.includes(row.status)) continue;
      this.agent(row.id)?.repair();
    }
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.tick();
  }

  /** Stop driving agents. Turns in progress are interrupted and resume at the next start. */
  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const a of this.agents.values()) a.interrupt();
    await this.runs.shutdown();
    const deadline = Date.now() + 5000;
    while ([...this.agents.values()].some((a) => a.busy) && Date.now() < deadline) await sleep(20);
  }

  // ── what agents call ──────────────────────────────────────────────────────

  spawn(parent: string, spec: SpawnSpec): AgentRow | string {
    const { state, maxAgents } = this.opts;
    const name = spec.name.trim();
    if (!name) return "name is required";
    if (!["request", "sequence", "continuous"].includes(spec.mode)) return `unknown mode "${spec.mode}"`;
    if (spec.mode === "request" && spec.tasks.length !== 1) return "a request agent takes exactly one task";
    if (spec.mode === "sequence" && spec.tasks.length === 0) return "a sequence agent takes at least one task";
    if (spec.mode !== "continuous" && spec.intervalS) return "interval_s applies to continuous agents only";
    const active = this.list(false).filter((a) => a.id !== ROOT);
    if (active.some((a) => a.name === name)) return `an active agent is already named "${name}"`;
    if (active.length >= maxAgents)
      return `${active.length} agents are already active, the most allowed (SEVEN_MAX_AGENTS)`;

    const row = state.tx(() => {
      const r = state.createAgent({ ...spec, name, parent, mode: spec.mode });
      for (const text of spec.tasks) state.enqueue(r.id, { sender: parent, kind: "task", text });
      return r;
    });
    this.emit({ type: "spawned", agent: row.id, parent, name, mode: row.mode });
    this.tick();
    return row;
  }

  /** Agents, oldest first; active ones only unless `all`. */
  list(all: boolean): AgentRow[] {
    const rows = this.opts.state.listAgents();
    return all ? rows : rows.filter((r) => !TERMINAL.includes(r.status));
  }

  /** Agents whose name, description or instructions contain every word of `query`; active first. */
  find(query: string): AgentRow[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.list(true).filter((r) => {
      const hay = `${r.name} ${r.description} ${r.instructions}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const active = (r: AgentRow) => (TERMINAL.includes(r.status) ? 1 : 0);
    return rows.sort((a, b) => active(a) - active(b));
  }

  /** An agent by id, or by name: the active one, else the most recent. */
  resolve(ref: string): AgentRow | string {
    const { state } = this.opts;
    const byId = state.getAgent(ref);
    if (byId) return byId;
    const named = this.list(true).filter((r) => r.name === ref);
    const pick = named.findLast((r) => !TERMINAL.includes(r.status)) ?? named.at(-1);
    return pick ?? `no agent "${ref}"`;
  }

  send(from: string, toRef: string, text: string): string {
    const to = this.resolve(toRef);
    if (typeof to === "string") return to;
    if (to.id === from) return "you cannot message yourself";
    if (TERMINAL.includes(to.status)) {
      const result = to.result ? `; its result: ${to.result.slice(0, 500)}` : "";
      return `${to.id} "${to.name}" is ${to.status} and reads no more messages${result}`;
    }
    this.opts.state.enqueue(to.id, { sender: from, kind: "message", text });
    this.emit({ type: "message", from, to: to.id, text });
    this.tick();
    return `sent to ${to.id} "${to.name}"`;
  }

  /** Wait for the next undelivered message to `agent` (from `from`, if given), and deliver it. */
  async waitMessage(
    agent: string,
    opts: { from?: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<InboxRow | undefined> {
    const { state } = this.opts;
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      const next = state.pending(agent, { kind: "message", sender: opts.from })[0];
      if (next) {
        state.markDelivered(next.id);
        return next;
      }
      if (Date.now() >= deadline || opts.signal?.aborted || this.closed) return undefined;
      await sleep(Math.min(POLL_MS, deadline - Date.now()), opts.signal);
    }
  }

  stop(id: string, by: string, reason?: string): string {
    const row = this.opts.state.getAgent(id);
    if (!row) return `no agent "${id}"`;
    if (id === ROOT) return "the root agent cannot be stopped";
    if (id === by) return "an agent cannot stop itself; finish your turn instead";
    if (TERMINAL.includes(row.status)) return `${id} is already ${row.status}`;
    const detail = `stopped by ${by}${reason ? `: ${reason}` : ""}`;
    this.end(row, "stopped", detail);
    return `stopped ${id} "${row.name}"`;
  }

  /** One agent in detail, for agent_status. */
  status(row: AgentRow): string {
    const { state } = this.opts;
    const pending = state.pending(row.id);
    const lines = [
      `${row.id} "${row.name}" · ${row.mode} · ${row.status}${row.parent ? ` · spawned by ${row.parent}` : ""}`,
      `description: ${row.description}`,
      ...(row.instructions ? [`instructions: ${row.instructions}`] : []),
      ...(row.intervalS ? [`wakes every ${row.intervalS}s when idle`] : []),
      `created ${row.createdAt}; last turn ${row.lastTurnAt ?? "never"}${row.finishedAt ? `; finished ${row.finishedAt}` : ""}`,
      `inbox: ${pending.filter((p) => p.kind === "task").length} tasks and ${pending.filter((p) => p.kind === "message").length} messages waiting`,
    ];
    const last = this.agent(row.id)?.lastAnswer() ?? null;
    if (row.result !== null) lines.push(`result: ${row.result}`);
    else if (last) lines.push(`last answer: ${last.slice(0, 2000)}`);
    if (row.error) lines.push(`error: ${row.error}`);
    return lines.join("\n");
  }

  /** How an inbox item reads in the receiving agent's conversation. */
  formatInbox(m: InboxRow): string {
    if (m.sender === "user") return `[message from the user]\n${m.text}`;
    const sender = this.opts.state.getAgent(m.sender);
    return `[message from ${m.sender}${sender ? ` "${sender.name}"` : ""}]\n${m.text}`;
  }

  // ── driving ───────────────────────────────────────────────────────────────

  private agent(id: string): Agent | undefined {
    let a = this.agents.get(id);
    if (!a && this.opts.state.getAgent(id)) {
      const { state, store, runner, model, workspace, maxSteps, onEvent } = this.opts;
      a = new Agent(
        { state, store, runner, runs: this.runs, model, supervisor: this, workspace, maxSteps, onEvent },
        id,
      );
      this.agents.set(id, a);
    }
    return a;
  }

  private tick(): void {
    if (this.closed) return;
    for (const row of this.opts.state.listAgents()) {
      if (row.id === ROOT || TERMINAL.includes(row.status)) continue;
      const a = this.agent(row.id);
      if (a && !a.busy) void this.drive(a, row);
    }
  }

  /** Give an idle agent its next piece of work, if it has one. */
  private async drive(a: Agent, row: AgentRow): Promise<void> {
    const { state } = this.opts;
    if ((this.retryAt.get(a.id) ?? 0) > Date.now()) return;

    let input: { text: string; inboxId?: number } | undefined;
    if (!a.needsResume()) {
      const next = row.mode === "continuous" ? state.pending(a.id)[0] : state.pending(a.id, { kind: "task" })[0];
      if (next) {
        input = { text: next.kind === "task" ? next.text : this.formatInbox(next), inboxId: next.id };
      } else if (row.mode === "continuous") {
        if (!row.intervalS || !due(row)) {
          if (row.status !== "idle") state.updateAgent(a.id, { status: "idle" });
          return;
        }
        input = { text: "[scheduled wake-up] Continue with your standing instructions." };
      } else {
        // A request or sequence agent with no task left is done.
        this.end(row, "done", a.lastAnswer() ?? "");
        return;
      }
    }

    try {
      await a.turn(input);
      if (row.mode === "continuous" && !this.closed) {
        const now = state.getAgent(a.id);
        if (now && !TERMINAL.includes(now.status)) state.updateAgent(a.id, { status: "idle" });
      }
    } catch (err) {
      const current = state.getAgent(a.id);
      if (this.closed || !current || TERMINAL.includes(current.status)) return; // stopped or shutting down
      const message = err instanceof Error ? err.message : String(err);
      if (row.mode === "continuous") {
        state.updateAgent(a.id, { status: "idle", error: message });
        this.retryAt.set(a.id, Date.now() + RETRY_MS);
      } else {
        this.end(current, "failed", message);
      }
      return;
    }
    this.tick();
  }

  /** Finish an agent and tell its parent. */
  private end(row: AgentRow, status: "done" | "failed" | "stopped", detail: string): void {
    const { state } = this.opts;
    const a = this.agents.get(row.id);
    a?.interrupt();
    this.runs.killAll(row.id);
    state.updateAgent(row.id, {
      status,
      finishedAt: new Date().toISOString(),
      ...(status === "done" ? { result: detail } : { error: detail }),
    });
    if (row.parent) {
      const head = status === "done" ? "finished" : status;
      state.enqueue(row.parent, { sender: row.id, kind: "message", text: `${head}:\n${detail}` });
      this.emit({ type: "message", from: row.id, to: row.parent, text: `${head}:\n${detail}` });
    }
    this.emit({ type: "finished", agent: row.id, status, detail });
  }

  private emit(e: SupervisorEvent): void {
    this.opts.onEvent?.(e);
  }
}

function due(row: AgentRow): boolean {
  if (!row.intervalS) return false;
  const last = Date.parse(row.lastTurnAt ?? row.createdAt);
  return Date.now() - last >= row.intervalS * 1000;
}
