// What every built-in gets: the agent calling it and the shared machinery.

import type { ToolDef } from "../../llm/mistral.ts";
import type { Logger } from "../../log.ts";
import type { RunHandle, Runner, RunResult } from "../../runner/index.ts";
import type { StoredTool, ToolStore } from "../../tools/store.ts";
import type { RunTable } from "../runs.ts";
import type { Supervisor } from "../supervisor.ts";

export interface Builtin extends ToolDef {
  run(args: Record<string, unknown>, ctx: BuiltinContext): Promise<string>;
}

export interface BuiltinContext {
  /** The agent making the call. */
  agentId: string;
  runner: Runner;
  store: ToolStore;
  runs: RunTable;
  supervisor: Supervisor;
  workspace: string;
  /** Seven's own database, which the sql built-in refuses to open. */
  stateDb: string;
  /** Aborted when the calling agent is stopped. */
  signal?: AbortSignal;
  /** Bound to the calling agent, turn, step and tool call. */
  log: Logger;
}

export const depsSchema = {
  type: "object",
  description: 'npm packages and version ranges, e.g. {"lodash": "^4"}. Imports not listed install at latest.',
  additionalProperties: { type: "string" },
};

/** Start a generated tool, recording the outcome in its run history when it ends. */
export function startGenerated(
  ctx: BuiltinContext,
  tool: StoredTool,
  args: unknown,
  mode: "sync" | "async",
  timeoutMs?: number,
): RunHandle {
  const handle = ctx.runner.startFile(
    tool.file,
    args,
    timeoutMs ?? tool.meta.timeoutMs,
    ctx.log.child({ tool: tool.meta.name, revision: tool.meta.revision, mode }),
  );
  void handle.done.then(
    (r) =>
      ctx.store.isOpen &&
      ctx.store.recordRun(tool.meta.name, {
        at: new Date(handle.startedAt).toISOString(),
        revision: tool.meta.revision,
        agent: ctx.agentId,
        mode,
        ok: r.ok,
        durationMs: r.durationMs,
        ...(!r.ok && { error: (r.error ?? "").split("\n")[0] }),
      }),
  );
  return handle;
}

/** Await a run, killing it if `signal` aborts first (the calling agent was stopped or seven is shutting down). */
export async function awaitRun(handle: RunHandle, signal?: AbortSignal): Promise<RunResult> {
  const kill = () => handle.kill();
  if (signal?.aborted) kill();
  signal?.addEventListener("abort", kill, { once: true });
  try {
    return await handle.done;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

export function disabledError(tool: StoredTool): string {
  const d = tool.meta.disabled;
  return `error: tool "${tool.meta.name}" is disabled (${d?.reason}). Fix it with define_tool, or enable_tool to use it as is.`;
}

export function formatRun(r: RunResult): string {
  const parts: string[] = [];
  if (r.ok) parts.push(typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2));
  else parts.push(`error: ${r.error}`);
  if (r.logs.length > 0) parts.push(`--- output ---\n${r.logs.join("\n")}`);
  return parts.join("\n");
}

export function positive(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function asDeps(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
}

export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Wait up to `ms`, or less if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
