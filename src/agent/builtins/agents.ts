// Agents working with agents: spawning, finding, messaging, stopping.

import type { AgentRow } from "../../state/db.ts";
import { type Builtin, positive } from "./shared.ts";

const MAX_WAIT_MS = 600_000;

export function agentBuiltins(): Builtin[] {
  return [
    {
      name: "spawn_agent",
      description:
        "Start another agent to work in parallel with you. It has the same built-ins and tools as you, its own " +
        "conversation, and runs at the same time as every other agent. Modes: request (one task, then done), " +
        "sequence (its tasks in order, then done) — for both, its final answer is sent to you as a message — and " +
        "continuous (keeps running, handling every message it receives, and waking every interval_s if set, until " +
        "stopped). Returns its id at once.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short and unique among active agents, e.g. researcher." },
          description: { type: "string", description: "What it is for; what other agents see in list_agents." },
          instructions: {
            type: "string",
            description: "Standing instructions: its role, how to work, what to return.",
          },
          mode: { type: "string", enum: ["request", "sequence", "continuous"] },
          tasks: {
            type: "array",
            items: { type: "string" },
            description: "request: exactly one; sequence: one or more, in order; continuous: optional first tasks.",
          },
          interval_s: { type: "integer", description: "continuous only: wake up this often when idle." },
          max_steps: { type: "integer", description: "Model calls per task. Defaults to seven's setting." },
        },
        required: ["name", "description", "instructions", "mode"],
      },
      async run(a, ctx) {
        const r = ctx.supervisor.spawn(ctx.agentId, {
          name: String(a.name),
          description: String(a.description),
          instructions: String(a.instructions),
          mode: String(a.mode) as "request" | "sequence" | "continuous",
          tasks: Array.isArray(a.tasks) ? a.tasks.map(String) : [],
          intervalS: positive(a.interval_s, 0) || null,
          maxSteps: positive(a.max_steps, 0) || null,
        });
        if (typeof r === "string") return `error: ${r}`;
        const reply = r.mode === "continuous" ? "" : "; its final answer will be sent to you as a message";
        return `spawned ${r.id} "${r.name}" (${r.mode})${reply}`;
      },
    },
    {
      name: "list_agents",
      description: "List agents: id, name, mode, status, who spawned it, and what it is for.",
      parameters: {
        type: "object",
        properties: {
          all: { type: "boolean", description: "Include finished, failed and stopped agents. Default false." },
        },
      },
      async run(a, ctx) {
        const rows = ctx.supervisor.list(a.all === true);
        return rows.length === 0 ? "no agents" : rows.map(line).join("\n");
      },
    },
    {
      name: "find_agents",
      description:
        "Find agents whose name, description or instructions contain every word of the query, active ones first.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async run(a, ctx) {
        const rows = ctx.supervisor.find(String(a.query));
        return rows.length === 0 ? `no agent matches "${String(a.query)}"` : rows.map(line).join("\n");
      },
    },
    {
      name: "agent_status",
      description:
        "Show one agent in detail: status, mode, instructions, pending inbox, its last answer, and its result or error.",
      parameters: {
        type: "object",
        properties: { agent: { type: "string", description: "An id or a name." } },
        required: ["agent"],
      },
      async run(a, ctx) {
        const r = ctx.supervisor.resolve(String(a.agent));
        return typeof r === "string" ? `error: ${r}` : ctx.supervisor.status(r);
      },
    },
    {
      name: "send_message",
      description:
        "Send a message to another agent. A busy agent sees it at its next step; an idle continuous agent wakes up " +
        "to handle it. Its reply, if any, arrives as a message to you: see wait_message.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "An id or a name." },
          text: { type: "string" },
        },
        required: ["to", "text"],
      },
      async run(a, ctx) {
        const r = ctx.supervisor.send(ctx.agentId, String(a.to), String(a.text));
        return r.startsWith("sent") ? r : `error: ${r}`;
      },
    },
    {
      name: "wait_message",
      description:
        "Wait for the next message sent to you — from one agent if `from` is given — up to timeout_ms, and return " +
        "it. Messages you do not wait for still reach you, at the start of your next step.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "An id or a name. Default: anyone." },
          timeout_ms: { type: "integer", description: `Default 60000, at most ${MAX_WAIT_MS}.` },
        },
      },
      async run(a, ctx) {
        let from: string | undefined;
        if (a.from !== undefined) {
          const r = ctx.supervisor.resolve(String(a.from));
          if (typeof r === "string") return `error: ${r}`;
          from = r.id;
        }
        const timeoutMs = Math.min(positive(a.timeout_ms, 60_000), MAX_WAIT_MS);
        const msg = await ctx.supervisor.waitMessage(ctx.agentId, { from, timeoutMs, signal: ctx.signal });
        return msg ? ctx.supervisor.formatInbox(msg) : `no message within ${timeoutMs}ms`;
      },
    },
    {
      name: "stop_agent",
      description: "Stop an agent and kill its background runs. Its parent is told. The root agent cannot be stopped.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "An id or a name." },
          reason: { type: "string" },
        },
        required: ["agent"],
      },
      async run(a, ctx) {
        const r = ctx.supervisor.resolve(String(a.agent));
        if (typeof r === "string") return `error: ${r}`;
        const out = ctx.supervisor.stop(r.id, ctx.agentId, a.reason === undefined ? undefined : String(a.reason));
        return out.startsWith("stopped") ? out : `error: ${out}`;
      },
    },
  ];
}

function line(r: AgentRow): string {
  const parent = r.parent ? ` · from ${r.parent}` : "";
  return `${r.id} "${r.name}" · ${r.mode} · ${r.status}${parent} · ${r.description}`;
}
