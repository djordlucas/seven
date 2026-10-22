// Configuration comes from the environment only. `npm start` loads .env when
// present; the container sets the same variables.

import * as path from "node:path";
import { DEFAULT_ENDPOINT } from "./llm/mistral.ts";

export interface Config {
  apiKey: string;
  model: string;
  endpoint: string;
  /** The working directory of every run; all of seven's data lives in it. */
  workspace: string;
  /** Seven's own data: <workspace>/.seven — the state database, tool sources, node_modules. */
  home: string;
  /** Seven's state database: <home>/seven.db. */
  stateDb: string;
  /** Model calls one turn may take before it is stopped. */
  maxSteps: number;
  /** Wall-clock budget of one run. */
  runTimeoutMs: number;
  /** V8 heap cap of one run, in MiB. */
  runMemoryMb: number;
  /** Agents besides the root that may be active at once. */
  maxAgents: number;
  /** Model calls in flight at once, across all agents. */
  llmConcurrency: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const workspace = path.resolve(env.SEVEN_WORKSPACE ?? process.cwd());
  const home = path.join(workspace, ".seven");
  return {
    apiKey: env.SEVEN_LLM_API_KEY ?? env.MISTRAL_API_KEY ?? "",
    model: env.SEVEN_LLM_MODEL ?? "mistral-medium-latest",
    endpoint: env.SEVEN_LLM_ENDPOINT ?? DEFAULT_ENDPOINT,
    workspace,
    home,
    stateDb: path.join(home, "seven.db"),
    maxSteps: int(env.SEVEN_MAX_STEPS, 40),
    runTimeoutMs: int(env.SEVEN_RUN_TIMEOUT_MS, 60_000),
    runMemoryMb: int(env.SEVEN_RUN_MEMORY_MB, 1024),
    maxAgents: int(env.SEVEN_MAX_AGENTS, 16),
    llmConcurrency: int(env.SEVEN_LLM_CONCURRENCY, 4),
  };
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
}
