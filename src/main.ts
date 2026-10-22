#!/usr/bin/env node
// seven's CLI.
//
//   seven                       interactive session with the root agent
//   seven "<message>"           one message to the root agent, then exit
//   seven serve                 run every agent, without a terminal, until stopped
//   seven agents [--all]        list agents
//   seven send <agent> <text>   message an agent; works while another seven runs
//   seven tools                 list generated tools
//   seven logs [filters] [-f]   read seven's log (see docs/logging.md)
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
import { createLogger, fileSink, type Level, type Sink, stderrSink } from "./log.ts";
import { follow, format, type LogFilter, matches, parse, readLines } from "./logs.ts";
import { State, TERMINAL } from "./state/db.ts";
import { ToolStore } from "./tools/store.ts";

const cfg = loadConfig();
const [command, ...rest] = process.argv.slice(2);

// ── commands that do not run agents ─────────────────────────────────────────

if (command === "logs") {
  if (!cfg.logFile) {
    console.error("seven: logging to a file is off (SEVEN_LOG_FILE=off)");
    process.exit(2);
  }
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const filter: LogFilter = {
    agent: flag("--agent"),
    turn: flag("--turn"),
    run: flag("--run"),
    level: flag("--level") as Level | undefined,
    grep: flag("--grep"),
  };
  const json = rest.includes("--json");
  const color = !json && process.stdout.isTTY;
  const print = (line: string) => {
    const r = parse(line);
    if (r && matches(r, line, filter)) console.log(json ? line : format(r, color));
  };
  const tail = Number(flag("--tail") ?? 100);
  const lines = readLines(cfg.logFile).filter((l) => {
    const r = parse(l);
    return r !== undefined && matches(r, l, filter);
  });
  for (const line of tail > 0 ? lines.slice(-tail) : lines)
    console.log(json ? line : format(parse(line) as never, color));
  if (rest.includes("-f") || rest.includes("--follow")) {
    follow(cfg.logFile, print);
    await new Promise(() => {}); // until interrupted
  }
  process.exit(0);
}

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

const sinks: Sink[] = [];
if (cfg.logFile) sinks.push(fileSink(cfg.logFile));
if (cfg.logStderr ?? command === "serve") sinks.push(stderrSink());
const log = createLogger({ level: cfg.logLevel, sinks, bindings: { pid: process.pid } });
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: err });
  console.error(err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => log.error("unhandled rejection", { error: err }));

const model = new Mistral({ apiKey: cfg.apiKey, model: cfg.model, endpoint: cfg.endpoint });
const seven = createSeven(cfg, model, show, log);
const lease = seven.state.acquireLease();
if (!lease.ok) {
  log.warn("lease held by another process", { holder: lease.pid });
  console.error(`seven: another seven (pid ${lease.pid}) is running agents in this workspace`);
  process.exit(1);
}
log.info("seven started", {
  command: command === undefined ? "interactive" : command === "serve" ? "serve" : "message",
  model: cfg.model,
  endpoint: cfg.endpoint,
  workspace: cfg.workspace,
  node: process.versions.node,
  log_level: cfg.logLevel,
  max_agents: cfg.maxAgents,
  llm_concurrency: cfg.llmConcurrency,
  ...(lease.tookOverFrom && { took_lease_from: lease.tookOverFrom }),
});
const heartbeat = setInterval(() => seven.state.heartbeat(), 5000);
seven.supervisor.start();

let closing = false;
async function close(code = 0): Promise<never> {
  if (!closing) {
    closing = true;
    clearInterval(heartbeat);
    await seven.supervisor.shutdown();
    seven.state.releaseLease();
    log.info("seven stopped", { exit_code: code });
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
