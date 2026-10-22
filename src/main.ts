#!/usr/bin/env node
// seven's CLI.
//
//   seven                       interactive session with the root agent
//   seven "<message>"           one message to the root agent, then exit
//   seven serve                 run every agent, without a terminal, until stopped
//   seven agents [--all]        list agents
//   seven send <agent> <text>   message an agent; works while another seven runs
//   seven tools                 list generated tools
//
// Only one process at a time runs agents (interactive, one message, serve);
// the others only read and write the state database.

import * as path from "node:path";
import * as readline from "node:readline/promises";
import { styleText } from "node:util";
import { ROOT, type SupervisorEvent } from "./agent/supervisor.ts";
import { createSeven } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Mistral } from "./llm/mistral.ts";
import { State, TERMINAL } from "./state/db.ts";
import { ToolStore } from "./tools/store.ts";

const cfg = loadConfig();
const [command, ...rest] = process.argv.slice(2);

// ── commands that do not run agents ─────────────────────────────────────────

if (command === "tools" || command === "agents" || command === "send") {
  const state = new State(cfg.stateDb);
  if (command === "tools") {
    for (const t of new ToolStore(state, path.join(cfg.home, "tools")).list()) {
      console.log(`${t.name}  r${t.revision}${t.disabled ? "  (disabled)" : ""}  ${t.description}`);
    }
  } else if (command === "agents") {
    const all = rest.includes("--all");
    for (const a of state.listAgents()) {
      if (!all && TERMINAL.includes(a.status)) continue;
      const pending = state.pending(a.id).length;
      console.log(
        `${a.id}  ${a.name}  ${a.mode}  ${a.status}${pending ? `  (${pending} waiting)` : ""}  ${a.description}`,
      );
    }
  } else {
    const [ref, ...words] = rest;
    const agents = state.listAgents();
    const to =
      agents.find((a) => a.id === ref) ?? agents.findLast((a) => a.name === ref && !TERMINAL.includes(a.status));
    if (!ref || words.length === 0 || !to) {
      console.error(ref && words.length ? `seven: no active agent "${ref}"` : "usage: seven send <agent> <text>");
      process.exit(2);
    }
    state.enqueue(to.id, { sender: "user", kind: "message", text: words.join(" ") });
    console.log(`queued for ${to.id} "${to.name}"`);
  }
  state.close();
  process.exit(0);
}

// ── commands that run agents ────────────────────────────────────────────────

if (!cfg.apiKey) {
  console.error("seven: set SEVEN_LLM_API_KEY (or MISTRAL_API_KEY); see .env.example");
  process.exit(2);
}

const model = new Mistral({ apiKey: cfg.apiKey, model: cfg.model, endpoint: cfg.endpoint });
const seven = createSeven(cfg, model, show);
const lease = seven.state.acquireLease();
if (!lease.ok) {
  console.error(`seven: another seven (pid ${lease.pid}) is running agents in this workspace`);
  process.exit(1);
}
const heartbeat = setInterval(() => seven.state.heartbeat(), 5000);
seven.supervisor.start();

let closing = false;
async function close(code = 0): Promise<never> {
  if (!closing) {
    closing = true;
    clearInterval(heartbeat);
    await seven.supervisor.shutdown();
    seven.state.releaseLease();
    seven.state.close();
  }
  process.exit(code);
}
process.on("SIGINT", () => void close(130));
process.on("SIGTERM", () => void close(143));

function show(e: SupervisorEvent): void {
  const who = "agent" in e && e.agent !== ROOT ? styleText("magenta", `[${e.agent}] `) : "";
  if (e.type === "tool_call") {
    console.error(`${who}${styleText("cyan", `→ ${e.name}`)}`, styleText("dim", clip(e.args, 400)));
  } else if (e.type === "tool_result") {
    console.error(`${who}${styleText("dim", `← ${clip(e.result, 800)}`)}`);
  } else if (e.type === "spawned") {
    console.error(styleText("magenta", `+ ${e.agent} "${e.name}" (${e.mode}) spawned by ${e.parent}`));
  } else if (e.type === "finished") {
    console.error(styleText("magenta", `- ${e.agent} ${e.status}: ${clip(e.detail, 300)}`));
  } else if (e.type === "message" && e.to === ROOT) {
    console.error(styleText("yellow", `✉ ${e.from} → seven: ${clip(e.text, 300)}`));
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function activeChildren(): number {
  return seven.supervisor.list(false).filter((a) => a.id !== ROOT).length;
}

if (command === "serve") {
  console.error(
    styleText("dim", `seven serve · ${cfg.model} · workspace ${cfg.workspace} · ${activeChildren()} active agents`),
  );
  await new Promise(() => {}); // until SIGINT or SIGTERM
} else if (command !== undefined) {
  const root = seven.supervisor.root();
  if (root.needsResume()) await root.turn();
  console.log(await root.turn({ text: [command, ...rest].join(" ") }));
  const n = activeChildren();
  if (n > 0) {
    console.error(
      styleText("dim", `${n} agents still active; they resume at the next start (or run \`seven serve\`).`),
    );
  }
  await close(0);
} else {
  const root = seven.supervisor.root();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.error(
    styleText("dim", `seven · ${cfg.model} · workspace ${cfg.workspace} · /agents, /reset, ctrl-d to exit`),
  );
  if (root.needsResume()) console.log(`${await root.turn()}\n`);
  for (;;) {
    const line = await rl.question(styleText("bold", "› ")).catch(() => null);
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;
    if (text === "/agents") {
      for (const a of seven.supervisor.list(false)) {
        console.log(`${a.id}  ${a.name}  ${a.mode}  ${a.status}  ${a.description}`);
      }
      continue;
    }
    if (text === "/reset") {
      seven.state.clearHistory(ROOT);
      console.log("conversation cleared");
      continue;
    }
    try {
      console.log(`${await root.turn({ text })}\n`);
    } catch (err) {
      console.error(styleText("red", err instanceof Error ? err.message : String(err)));
    }
  }
  rl.close();
  await close(0);
}
