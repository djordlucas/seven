// Configuration comes from the environment only. `npm start` loads .env when
// present; the container sets the same variables.

import * as path from "node:path";
import { DEFAULT_ENDPOINT } from "./llm/mistral.ts";
import { type Level, parseLevel } from "./log.ts";

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
  /** The model's context window, in tokens; an agent's conversation is compacted to fit it. */
  contextTokens: number;
  /** Wall-clock budget of one run. */
  runTimeoutMs: number;
  /** V8 heap cap of one run, in MiB. */
  runMemoryMb: number;
  /** Agents besides the root that may be active at once. */
  maxAgents: number;
  /** Model calls in flight at once, across all agents. */
  llmConcurrency: number;
  /** Lowest level logged. */
  logLevel: Level;
  /** JSON-lines log file: <home>/logs/seven.log; empty when logging to a file is off. */
  logFile: string;
  /** Also log to stderr: on for `seven serve` unless set. */
  logStderr: boolean | undefined;
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
    contextTokens: int(env.SEVEN_CONTEXT_TOKENS, 128_000),
    runTimeoutMs: int(env.SEVEN_RUN_TIMEOUT_MS, 60_000),
    runMemoryMb: int(env.SEVEN_RUN_MEMORY_MB, 1024),
    maxAgents: int(env.SEVEN_MAX_AGENTS, 16),
    llmConcurrency: int(env.SEVEN_LLM_CONCURRENCY, 4),
    logLevel: parseLevel(env.SEVEN_LOG_LEVEL, "info"),
    logFile: env.SEVEN_LOG_FILE === "off" ? "" : path.resolve(workspace, env.SEVEN_LOG_FILE ?? ".seven/logs/seven.log"),
    logStderr: env.SEVEN_LOG_STDERR === undefined ? undefined : env.SEVEN_LOG_STDERR === "1",
  };
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
}
