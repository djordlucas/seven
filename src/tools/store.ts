// Generated tools: the part of seven that seven writes.
//
// Each tool is a directory under <home>/tools/<name>/ holding its definition
// and its source, which the runner runs as-is. The store is re-read every model
// step, so a tool defined mid-turn is callable on the next step.

import * as fs from "node:fs";
import * as path from "node:path";

export interface ToolMeta {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Version ranges as requested. */
  deps: Record<string, string>;
  /** Packages the source imports, with the version installed when it was saved. */
  packages: { name: string; version: string }[];
  createdAt: string;
  updatedAt: string;
  /** Increments on every redefinition. */
  revision: number;
}

export interface StoredTool {
  meta: ToolMeta;
  source: string;
  /** Absolute path of the source file, for the runner. */
  file: string;
}

export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export class ToolStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  list(): ToolMeta[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && TOOL_NAME.test(e.name))
      .flatMap((e) => {
        try {
          return [this.readMeta(e.name)];
        } catch {
          return []; // a half-written or hand-broken tool is skipped, not fatal
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): StoredTool | undefined {
    if (!TOOL_NAME.test(name) || !fs.existsSync(path.join(this.dir, name, "tool.json"))) return undefined;
    const file = path.join(this.dir, name, "source.ts");
    return { meta: this.readMeta(name), source: fs.readFileSync(file, "utf8"), file };
  }

  save(tool: { meta: Omit<ToolMeta, "createdAt" | "updatedAt" | "revision">; source: string }): ToolMeta {
    const { name } = tool.meta;
    if (!TOOL_NAME.test(name)) throw new Error(`invalid tool name "${name}": must match ${TOOL_NAME}`);
    const prev = this.get(name)?.meta;
    const now = new Date().toISOString();
    const meta: ToolMeta = {
      ...tool.meta,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      revision: (prev?.revision ?? 0) + 1,
    };

    // Written to a sibling directory and renamed, so a reader never sees a
    // tool.json that disagrees with its source.
    const final = path.join(this.dir, name);
    const tmp = path.join(this.dir, `.${name}.${process.pid}.tmp`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "tool.json"), `${JSON.stringify(meta, null, 2)}\n`);
    fs.writeFileSync(path.join(tmp, "source.ts"), tool.source);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    return meta;
  }

  remove(name: string): boolean {
    const dir = path.join(this.dir, name);
    if (!TOOL_NAME.test(name) || !fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  private readMeta(name: string): ToolMeta {
    return JSON.parse(fs.readFileSync(path.join(this.dir, name, "tool.json"), "utf8")) as ToolMeta;
  }
}
