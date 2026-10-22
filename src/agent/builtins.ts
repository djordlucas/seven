// The tools seven is born with. They are deliberately few: running code and
// managing generated tools. Everything else — reading files, searching the web,
// editing its workspace — seven has to build for itself with define_tool.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDef } from "../llm/mistral.ts";
import type { Runner, RunResult } from "../runner/index.ts";
import { TOOL_NAME, type ToolStore } from "../tools/store.ts";

export interface Builtin extends ToolDef {
  run(args: Record<string, unknown>): Promise<string>;
}

const depsSchema = {
  type: "object",
  description: 'npm packages and version ranges, e.g. {"lodash": "^4"}. Imports not listed install at latest.',
  additionalProperties: { type: "string" },
};

export function builtins(runner: Runner, store: ToolStore): Builtin[] {
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
        },
        required: ["name", "description", "parameters", "code"],
      },
      async run(a) {
        const name = String(a.name);
        if (!TOOL_NAME.test(name)) return `error: name must match ${TOOL_NAME}`;
        if (names.has(name)) return `error: "${name}" is a built-in tool and cannot be replaced`;
        const source = String(a.code);
        const deps = asDeps(a.deps) ?? {};

        let packages: Awaited<ReturnType<Runner["install"]>>;
        try {
          packages = await runner.install(source, deps);
        } catch (err) {
          return `error: ${err instanceof Error ? err.message : String(err)}`;
        }

        let trial = "";
        if (a.test_args !== undefined) {
          const r = await trialRun(runner, name, source, a.test_args);
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
  ];
  for (const b of list) names.add(b.name);
  return list;
}

/** Run a candidate tool from a scratch file under the runner's home, so its imports resolve. */
async function trialRun(runner: Runner, name: string, source: string, args: unknown): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(runner.home, "tmp", `trial-${name}-`));
  const file = path.join(dir, "source.ts");
  fs.writeFileSync(file, source);
  try {
    return await runner.runFile(file, args);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function formatRun(r: RunResult): string {
  const parts: string[] = [];
  if (r.ok) parts.push(typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2));
  else parts.push(`error: ${r.error}`);
  if (r.logs.length > 0) parts.push(`--- output ---\n${r.logs.join("\n")}`);
  return parts.join("\n");
}

function asDeps(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
}
