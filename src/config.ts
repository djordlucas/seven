// Configuration comes from the environment only. `npm start` loads .env when
// present; the container sets the same variables.

import * as path from "node:path";
import { DEFAULT_ENDPOINT } from "./llm/mistral.ts";

export interface Config {
  apiKey: string;
  model: string;
  endpoint: string;
  /** seven's own state: generated tools and the npm cache. */
  home: string;
  /** Where the agent works; guest relative paths resolve here. */
  workspace: string;
  /** Model calls one user message may take before the turn is stopped. */
  maxSteps: number;
  /** Wall-clock budget for one VM run. */
  runTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const workspace = path.resolve(env.SEVEN_WORKSPACE ?? process.cwd());
  return {
    apiKey: env.SEVEN_LLM_API_KEY ?? env.MISTRAL_API_KEY ?? "",
    model: env.SEVEN_LLM_MODEL ?? "mistral-medium-latest",
    endpoint: env.SEVEN_LLM_ENDPOINT ?? DEFAULT_ENDPOINT,
    home: path.resolve(env.SEVEN_HOME ?? path.join(workspace, ".seven")),
    workspace,
    maxSteps: int(env.SEVEN_MAX_STEPS, 40),
    runTimeoutMs: int(env.SEVEN_RUN_TIMEOUT_MS, 60_000),
  };
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
}
