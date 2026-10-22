#!/usr/bin/env node
// seven's CLI.
//
//   seven                 interactive session
//   seven "<message>"     one message, then exit
//   seven tools           list the tools seven has built

import * as path from "node:path";
import * as readline from "node:readline/promises";
import { styleText } from "node:util";
import { Agent, type AgentEvent } from "./agent/agent.ts";
import { loadConfig } from "./config.ts";
import { Mistral } from "./llm/mistral.ts";
import { ToolStore } from "./tools/store.ts";
import { createVM } from "./vm/index.ts";

const cfg = loadConfig();
const store = new ToolStore(path.join(cfg.home, "tools"));
const argv = process.argv.slice(2);

if (argv[0] === "tools") {
  for (const t of store.list()) console.log(`${t.name}  r${t.revision}  ${t.description}`);
  process.exit(0);
}

if (!cfg.apiKey) {
  console.error("seven: set SEVEN_LLM_API_KEY (or MISTRAL_API_KEY); see .env.example");
  process.exit(2);
}

const model = new Mistral({ apiKey: cfg.apiKey, model: cfg.model, endpoint: cfg.endpoint });
const vm = createVM({
  cwd: cfg.workspace,
  depsDir: path.join(cfg.home, "deps"),
  timeoutMs: cfg.runTimeoutMs,
  host: {
    llm: {
      chat: async (prompt: string, system?: string) => {
        const { message } = await model.complete({
          messages: [
            ...(system ? [{ role: "system" as const, content: system }] : []),
            { role: "user", content: prompt },
          ],
        });
        return message.content ?? "";
      },
    },
  },
});

const agent = new Agent({ model, vm, store, workspace: cfg.workspace, maxSteps: cfg.maxSteps, onEvent: show });

function show(e: AgentEvent): void {
  if (e.type === "tool_call") console.error(styleText("cyan", `→ ${e.name}`), styleText("dim", clip(e.args, 400)));
  if (e.type === "tool_result") console.error(styleText("dim", `← ${clip(e.result, 800)}`));
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

if (argv.length > 0) {
  console.log(await agent.send(argv.join(" ")));
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.error(styleText("dim", `seven · ${cfg.model} · workspace ${cfg.workspace} · ctrl-d to exit`));
  for (;;) {
    const line = await rl.question(styleText("bold", "› ")).catch(() => null);
    if (line === null) break;
    if (!line.trim()) continue;
    try {
      console.log(`${await agent.send(line)}\n`);
    } catch (err) {
      console.error(styleText("red", err instanceof Error ? err.message : String(err)));
    }
  }
  rl.close();
}
