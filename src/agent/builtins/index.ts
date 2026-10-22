// The tools every agent is born with. They are deliberately few: running code,
// managing tools, controlling background runs, working with other agents, and
// SQL. Everything else — reading files, searching the web, editing the
// workspace — seven has to build for itself with define_tool.

import { agentBuiltins } from "./agents.ts";
import { codeBuiltins } from "./code.ts";
import { runBuiltins } from "./runs.ts";
import type { Builtin } from "./shared.ts";
import { sqlBuiltins } from "./sql.ts";

export type { Builtin, BuiltinContext } from "./shared.ts";
export { awaitRun, disabledError, formatRun, startGenerated } from "./shared.ts";

let all: Map<string, Builtin> | undefined;

/** Every built-in, by name. The same set for every agent; the caller is in the context. */
export function builtins(): Map<string, Builtin> {
  if (!all) {
    const isBuiltin = (name: string) => all?.has(name) ?? false;
    all = new Map(
      [...codeBuiltins(isBuiltin), ...runBuiltins(isBuiltin), ...agentBuiltins(), ...sqlBuiltins()].map((b) => [
        b.name,
        b,
      ]),
    );
  }
  return all;
}
