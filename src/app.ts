// Wiring: one seven, from configuration and a model client. The CLI uses it,
// and so do tests, with a scripted model.

import * as path from "node:path";
import { Supervisor, type SupervisorEvent } from "./agent/supervisor.ts";
import type { Config } from "./config.ts";
import { limitConcurrency } from "./llm/limit.ts";
import type { ChatModel } from "./llm/mistral.ts";
import { createRunner, llmModule, type Runner } from "./runner/index.ts";
import { State } from "./state/db.ts";
import { ToolStore } from "./tools/store.ts";

export interface Seven {
  state: State;
  store: ToolStore;
  runner: Runner;
  supervisor: Supervisor;
}

export function createSeven(cfg: Config, model: ChatModel, onEvent?: (e: SupervisorEvent) => void): Seven {
  const state = new State(cfg.stateDb);
  const store = new ToolStore(state, path.join(cfg.home, "tools"));
  const limited = limitConcurrency(model, cfg.llmConcurrency);
  const runner = createRunner({
    home: cfg.home,
    cwd: cfg.workspace,
    timeoutMs: cfg.runTimeoutMs,
    memoryMb: cfg.runMemoryMb,
    host: { llm: llmModule(limited) },
    // How seven.db() in a run knows which database to refuse.
    env: { SEVEN_STATE_DB: state.path },
  });
  const supervisor = new Supervisor({
    state,
    store,
    runner,
    model: limited,
    workspace: cfg.workspace,
    maxSteps: cfg.maxSteps,
    maxAgents: cfg.maxAgents,
    onEvent,
  });
  return { state, store, runner, supervisor };
}
