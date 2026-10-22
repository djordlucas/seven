// Running code and managing generated tools.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Runner, RunResult } from "../../runner/index.ts";
import { type StoredTool, TOOL_NAME, type ToolStore } from "../../tools/store.ts";
import { asDeps, awaitRun, type Builtin, depsSchema, formatRun, positive, secs } from "./shared.ts";

export function codeBuiltins(isBuiltin: (name: string) => boolean): Builtin[] {
  return [
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
      async run(a, ctx) {
        const handle = ctx.runner.startEval(String(a.code), { args: a.args, deps: asDeps(a.deps) });
        return formatRun(await awaitRun(handle, ctx.signal));
      },
    },
    {
      name: "define_tool",
      description:
        "Create or replace a tool. It becomes callable by `name` from your next step — by you and by every other " +
        "agent — and persists across sessions. The source's default export is `async (args) => result`. When " +
        "test_args is given the tool is run once first, and it is only saved if that run succeeds.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `snake_case, matching ${TOOL_NAME}.` },
          description: {
            type: "string",
            description: "What the tool does and returns; this is all a future caller sees.",
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
      async run(a, ctx) {
        const name = String(a.name);
        if (!TOOL_NAME.test(name)) return `error: name must match ${TOOL_NAME}`;
        if (isBuiltin(name)) return `error: "${name}" is a built-in tool and cannot be replaced`;
        const source = String(a.code);
        const deps = asDeps(a.deps) ?? {};
        const timeoutMs = positive(a.timeout_ms, 0) || undefined;

        let packages: Awaited<ReturnType<Runner["install"]>>;
        try {
          packages = await ctx.runner.install(source, deps);
        } catch (err) {
          return `error: ${err instanceof Error ? err.message : String(err)}`;
        }

        let trial = "";
        if (a.test_args !== undefined) {
          const r = await trialRun(ctx.runner, name, source, a.test_args, timeoutMs);
          if (!r.ok) return `not saved: the trial run failed\n${formatRun(r)}`;
          trial = `\ntrial run:\n${formatRun(r)}`;
        }

        const meta = ctx.store.save({
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
      description: "Show a tool: its definition and source. Use it before revising a tool.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a, ctx) {
        const t = ctx.store.get(String(a.name));
        if (!t) return `error: no tool named "${String(a.name)}"`;
        return `${JSON.stringify(t.meta, null, 2)}\n\n--- source ---\n${t.source}`;
      },
    },
    {
      name: "delete_tool",
      description: "Delete a tool, for every agent.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a, ctx) {
        const name = String(a.name);
        return ctx.store.remove(name) ? `deleted ${name}` : `error: no tool named "${name}"`;
      },
    },
    {
      name: "tool_health",
      description:
        "Show how a tool has been behaving: whether it is disabled, its run limit, and its recent runs with their " +
        "caller, outcome, duration and errors. Use it to decide whether to fix, disable or delete a tool.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          last: { type: "integer", description: "Runs to show, newest first. Default 10." },
        },
        required: ["name"],
      },
      async run(a, ctx) {
        const t = ctx.store.get(String(a.name));
        if (!t) return `error: no tool named "${String(a.name)}"`;
        return health(t, ctx.store, positive(a.last, 10));
      },
    },
    {
      name: "disable_tool",
      description:
        "Disable a tool that misbehaves: it disappears from every agent's tool list and calls to it are refused, " +
        "but it is kept. Redefining it with define_tool, or enable_tool, brings it back.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          reason: { type: "string", description: "What is wrong with it; shown to every agent while it is disabled." },
        },
        required: ["name", "reason"],
      },
      async run(a, ctx) {
        const name = String(a.name);
        return ctx.store.setDisabled(name, String(a.reason)) ? `disabled ${name}` : `error: no tool named "${name}"`;
      },
    },
    {
      name: "enable_tool",
      description: "Re-enable a disabled tool as it is.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a, ctx) {
        const name = String(a.name);
        return ctx.store.setDisabled(name, null) ? `enabled ${name}` : `error: no tool named "${name}"`;
      },
    },
  ];
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

function health(tool: StoredTool, store: ToolStore, last: number): string {
  const { meta } = tool;
  const runs = store.history(meta.name);
  const state = meta.disabled ? `disabled since ${meta.disabled.at}: ${meta.disabled.reason}` : "enabled";
  const lines = [
    `${meta.name} (revision ${meta.revision}): ${state}`,
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
      .map(
        (r) =>
          `- ${r.at} r${r.revision} ${r.agent} ${r.mode} ${secs(r.durationMs)} ${r.ok ? "ok" : `failed: ${r.error}`}`,
      ),
  );
  return lines.join("\n");
}
