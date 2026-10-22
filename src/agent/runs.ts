// Background runs: tool calls the model started with start_tool and controls
// by id. They live as long as the seven process and are not persisted.

import type { RunHandle, RunResult } from "../runner/index.ts";

export interface BackgroundRun {
  /** `r1`, `r2`, … in start order. */
  id: string;
  tool: string;
  handle: RunHandle;
  /** Set when the run ends. */
  result?: RunResult;
  /** Whether the model has looked at the run since it ended. */
  checked: boolean;
}

/** Finished runs kept for inspection; the oldest finished are dropped beyond this. */
const KEEP_FINISHED = 50;

export class RunTable {
  private readonly runs = new Map<string, BackgroundRun>();
  private next = 0;

  add(tool: string, handle: RunHandle): BackgroundRun {
    const run: BackgroundRun = { id: `r${++this.next}`, tool, handle, checked: false };
    this.runs.set(run.id, run);
    void handle.done.then((r) => {
      run.result = r;
      this.prune();
    });
    return run;
  }

  get(id: string): BackgroundRun | undefined {
    return this.runs.get(id);
  }

  list(): BackgroundRun[] {
    return [...this.runs.values()];
  }

  private prune(): void {
    const finished = this.list().filter((r) => r.result);
    for (const r of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.runs.delete(r.id);
  }
}

/** One line per run, for the system prompt and list_runs. */
export function summarize(run: BackgroundRun, now = Date.now()): string {
  const r = run.result;
  if (!r) return `${run.id} ${run.tool}: ${run.handle.state()} for ${seconds(now - run.handle.startedAt)}`;
  const outcome = r.ok ? "ok" : `failed: ${firstLine(r.error)}`;
  return `${run.id} ${run.tool}: finished in ${seconds(r.durationMs)}, ${outcome}${run.checked ? "" : " (not checked yet)"}`;
}

/** Full status of one run: state, result once done, and the last `tail` output lines. */
export function describe(run: BackgroundRun, tail: number): string {
  const lines = run.result?.logs ?? run.handle.logs();
  // Describing a finished run is the model checking it.
  if (run.result) run.checked = true;
  const parts = [summarize(run)];
  if (run.result) {
    const r = run.result;
    parts.push(r.ok ? (typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)) : `error: ${r.error}`);
  }
  if (lines.length > 0) {
    const shown = lines.slice(-tail);
    const label =
      shown.length < lines.length ? `last ${shown.length} of ${lines.length} lines` : `${lines.length} lines`;
    parts.push(`--- output (${label}) ---\n${shown.join("\n")}`);
  }
  return parts.join("\n");
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function firstLine(s: string | undefined): string {
  return (s ?? "").split("\n")[0] ?? "";
}
