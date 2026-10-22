// The tools seven is born with. They are deliberately few: running code and
// managing generated tools. Everything else — reading files, searching the web,
// editing its workspace — seven has to build for itself with define_tool.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDef } from "../llm/mistral.ts";
import type { RunHandle, Runner, RunResult } from "../runner/index.ts";
import { type StoredTool, TOOL_NAME, type ToolStore } from "../tools/store.ts";
import { describe, type RunTable, summarize } from "./runs.ts";

export interface Builtin extends ToolDef {
  run(args: Record<string, unknown>): Promise<string>;
}

const depsSchema = {
  type: "object",
  description: 'npm packages and version ranges, e.g. {"lodash": "^4"}. Imports not listed install at latest.',
  additionalProperties: { type: "string" },
};

export function builtins(runner: Runner, store: ToolStore, runs: RunTable): Builtin[] {
  const names = new Set<string>();
  const list: Builtin[] = [
    {
      name: "run_js",
      description:
        "Run TypeScript/JavaScript once, in a fresh Node.js process, and return its result and output. " +
        "The module's default export (a value, or a function called with `args`) is the result.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "ES module source." },
          args: { type: "object", description: "Passed to the default export when it is a function." },
          deps: depsSchema,
        },
        required: ["code"],
      },
      async run(a) {
        return formatRun(await runner.eval(String(a.code), { args: a.args, deps: asDeps(a.deps) }));
      },
    },
    {
      name: "define_tool",
      description:
        "Create or replace one of your own tools. It becomes callable by `name` from your next step and persists " +
        "across sessions. The source's default export is `async (args) => result`. When test_args is given the tool " +
        "is run once first, and it is only saved if that run succeeds.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `snake_case, matching ${TOOL_NAME}.` },
          description: {
            type: "string",
            description: "What the tool does and returns; this is all your future self sees.",
          },
          parameters: { type: "object", description: "JSON Schema for the arguments object." },
          code: { type: "string", description: "ES module source (TypeScript allowed)." },
          deps: depsSchema,
          test_args: { type: "object", description: "Arguments for a trial run before saving." },
          timeout_ms: {
            type: "integer",
            description: "Run limit for this tool, for one that is meant to be slow. Defaults to the normal run limit.",
          },
        },
        required: ["name", "description", "parameters", "code"],
      },
      async run(a) {
        const name = String(a.name);
        if (!TOOL_NAME.test(name)) return `error: name must match ${TOOL_NAME}`;
        if (names.has(name)) return `error: "${name}" is a built-in tool and cannot be replaced`;
        const source = String(a.code);
        const deps = asDeps(a.deps) ?? {};
        const timeoutMs = positive(a.timeout_ms, 0) || undefined;

        let packages: Awaited<ReturnType<Runner["install"]>>;
        try {
          packages = await runner.install(source, deps);
        } catch (err) {
          return `error: ${err instanceof Error ? err.message : String(err)}`;
        }

        let trial = "";
        if (a.test_args !== undefined) {
          const r = await trialRun(runner, name, source, a.test_args, timeoutMs);
          if (!r.ok) return `not saved: the trial run failed\n${formatRun(r)}`;
          trial = `\ntrial run:\n${formatRun(r)}`;
        }

        const meta = store.save({
          meta: {
            name,
            description: String(a.description),
            parameters: (a.parameters as Record<string, unknown>) ?? { type: "object" },
            deps,
            packages,
            ...(timeoutMs && { timeoutMs }),
          },
          source,
        });
        return `saved ${name} (revision ${meta.revision})${trial}`;
      },
    },
    {
      name: "read_tool",
      description: "Show one of your tools: its definition and source. Use it before revising a tool.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a) {
        const t = store.get(String(a.name));
        if (!t) return `error: no tool named "${String(a.name)}"`;
        return `${JSON.stringify(t.meta, null, 2)}\n\n--- source.ts ---\n${t.source}`;
      },
    },
    {
      name: "delete_tool",
      description: "Delete one of your tools.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a) {
        return store.remove(String(a.name)) ? `deleted ${String(a.name)}` : `error: no tool named "${String(a.name)}"`;
      },
    },
    {
      name: "start_tool",
      description:
        "Start a tool in the background and return a run id at once, instead of waiting for its result. " +
        "Works for any of your tools and for run_js. Use it for anything slow, long-running or that might hang; " +
        "then check it with run_status or wait_run, and stop it with kill_run.",
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string", description: "A tool you built, or run_js." },
          args: { type: "object", description: "The tool's arguments (for run_js: code, args, deps)." },
          timeout_ms: {
            type: "integer",
            description: "Kill the run after this long. Defaults to the normal run limit.",
          },
        },
        required: ["tool"],
      },
      async run(a) {
        const tool = String(a.tool);
        const args = (a.args as Record<string, unknown> | undefined) ?? {};
        const timeoutMs = typeof a.timeout_ms === "number" && a.timeout_ms > 0 ? a.timeout_ms : undefined;
        let handle: RunHandle;
        if (tool === "run_js") {
          handle = runner.startEval(String(args.code ?? ""), { args: args.args, deps: asDeps(args.deps), timeoutMs });
        } else {
          const own = store.get(tool);
          if (!own) return `error: no tool named "${tool}"${names.has(tool) ? " that can run in the background" : ""}`;
          if (own.meta.disabled) return disabledError(own);
          handle = startGenerated(runner, store, own, args, "async", timeoutMs);
        }
        const run = runs.add(tool, handle);
        return `started ${run.id} (${tool})`;
      },
    },
    {
      name: "run_status",
      description: "Show a background run: whether it is still going, its result once finished, and its latest output.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The run id from start_tool, e.g. r3." },
          tail: { type: "integer", description: "Output lines to show, from the end. Default 50." },
        },
        required: ["id"],
      },
      async run(a) {
        const run = runs.get(String(a.id));
        if (!run) return `error: no run "${String(a.id)}"`;
        return describe(run, positive(a.tail, 50));
      },
    },
    {
      name: "wait_run",
      description:
        "Wait for a background run to finish, up to timeout_ms, then show its status as run_status does. " +
        "Waiting does not stop the run.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          timeout_ms: { type: "integer", description: `How long to wait. Default 30000, at most ${MAX_WAIT_MS}.` },
          tail: { type: "integer", description: "Output lines to show, from the end. Default 50." },
        },
        required: ["id"],
      },
      async run(a) {
        const run = runs.get(String(a.id));
        if (!run) return `error: no run "${String(a.id)}"`;
        const wait = Math.min(positive(a.timeout_ms, 30_000), MAX_WAIT_MS);
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([run.handle.done, new Promise((r) => (timer = setTimeout(r, wait)))]);
        clearTimeout(timer);
        await Promise.resolve(); // let the run table record a result that just arrived
        return describe(run, positive(a.tail, 50));
      },
    },
    {
      name: "kill_run",
      description: "Stop a background run and everything it started.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async run(a) {
        const run = runs.get(String(a.id));
        if (!run) return `error: no run "${String(a.id)}"`;
        if (run.result) return `${run.id} had already finished\n${describe(run, 20)}`;
        run.handle.kill();
        await run.handle.done;
        await Promise.resolve();
        return `killed ${run.id}\n${describe(run, 20)}`;
      },
    },
    {
      name: "list_runs",
      description: "List background runs: running ones and recently finished ones.",
      parameters: { type: "object", properties: {} },
      async run() {
        const all = runs.list();
        return all.length === 0 ? "no background runs" : all.map((r) => summarize(r)).join("\n");
      },
    },
    {
      name: "tool_health",
      description:
        "Show how one of your tools has been behaving: whether it is disabled, its run limit, and its recent runs " +
        "with their outcome, duration and errors. Use it to decide whether to fix, disable or delete a tool.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          last: { type: "integer", description: "Runs to show, newest first. Default 10." },
        },
        required: ["name"],
      },
      async run(a) {
        const t = store.get(String(a.name));
        if (!t) return `error: no tool named "${String(a.name)}"`;
        return health(t, store, positive(a.last, 10));
      },
    },
    {
      name: "disable_tool",
      description:
        "Disable one of your tools that misbehaves: it disappears from your tool list and calls to it are refused, " +
        "but it is kept. Redefining it with define_tool, or enable_tool, brings it back.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          reason: { type: "string", description: "What is wrong with it; shown to you while it is disabled." },
        },
        required: ["name", "reason"],
      },
      async run(a) {
        const name = String(a.name);
        return store.setDisabled(name, String(a.reason)) ? `disabled ${name}` : `error: no tool named "${name}"`;
      },
    },
    {
      name: "enable_tool",
      description: "Re-enable a disabled tool as it is.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a) {
        const name = String(a.name);
        return store.setDisabled(name, null) ? `enabled ${name}` : `error: no tool named "${name}"`;
      },
    },
  ];
  for (const b of list) names.add(b.name);
  return list;
}

/** Run a candidate tool from a scratch file under the runner's home, so its imports resolve. */
async function trialRun(
  runner: Runner,
  name: string,
  source: string,
  args: unknown,
  timeoutMs?: number,
): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(runner.home, "tmp", `trial-${name}-`));
  const file = path.join(dir, "source.ts");
  fs.writeFileSync(file, source);
  try {
    return await runner.runFile(file, args, timeoutMs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Start a generated tool, recording the outcome in its run history when it ends. */
export function startGenerated(
  runner: Runner,
  store: ToolStore,
  tool: StoredTool,
  args: unknown,
  mode: "sync" | "async",
  timeoutMs?: number,
): RunHandle {
  const handle = runner.startFile(tool.file, args, timeoutMs ?? tool.meta.timeoutMs);
  void handle.done.then((r) =>
    store.recordRun(tool.meta.name, {
      at: new Date(handle.startedAt).toISOString(),
      revision: tool.meta.revision,
      mode,
      ok: r.ok,
      durationMs: r.durationMs,
      ...(!r.ok && { error: (r.error ?? "").split("\n")[0] }),
    }),
  );
  return handle;
}

export function disabledError(tool: StoredTool): string {
  const d = tool.meta.disabled;
  return `error: tool "${tool.meta.name}" is disabled (${d?.reason}). Fix it with define_tool, or enable_tool to use it as is.`;
}

function health(tool: StoredTool, store: ToolStore, last: number): string {
  const { meta } = tool;
  const runs = store.history(meta.name);
  const lines = [
    `${meta.name} (revision ${meta.revision}): ${meta.disabled ? `disabled since ${meta.disabled.at}: ${meta.disabled.reason}` : "enabled"}`,
    `run limit: ${meta.timeoutMs ? `${meta.timeoutMs}ms` : "default"}`,
  ];
  if (runs.length === 0) return [...lines, "no runs recorded"].join("\n");

  const ok = runs.filter((r) => r.ok).length;
  const durations = runs.map((r) => r.durationMs).sort((x, y) => x - y);
  const median = durations[Math.floor(durations.length / 2)] ?? 0;
  lines.push(
    `last ${runs.length} runs: ${ok} ok, ${runs.length - ok} failed; median ${secs(median)}, slowest ${secs(durations.at(-1) ?? 0)}`,
    "recent runs, newest first:",
    ...runs
      .slice(-last)
      .reverse()
      .map((r) => `- ${r.at} r${r.revision} ${r.mode} ${secs(r.durationMs)} ${r.ok ? "ok" : `failed: ${r.error}`}`),
  );
  return lines.join("\n");
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRun(r: RunResult): string {
  const parts: string[] = [];
  if (r.ok) parts.push(typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2));
  else parts.push(`error: ${r.error}`);
  if (r.logs.length > 0) parts.push(`--- output ---\n${r.logs.join("\n")}`);
  return parts.join("\n");
}

const MAX_WAIT_MS = 300_000;

function positive(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function asDeps(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
}
