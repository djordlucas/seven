// Generated tools: the part of seven that seven writes.
//
// Each tool is a directory under <home>/tools/<name>/ holding its definition,
// its source (which the runner runs as-is) and its run history. The store is
// re-read every model step, so a tool defined mid-turn is callable on the next
// step.

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
  /** Run limit for this tool, overriding the runner's default. */
  timeoutMs?: number;
  /** Set while the tool is disabled: it is not offered to the model and calls to it are refused. */
  disabled?: { at: string; reason: string };
}

/** One line of a tool's runs.jsonl. */
export interface RunRecord {
  at: string;
  revision: number;
  mode: "sync" | "async";
  ok: boolean;
  durationMs: number;
  /** First line of the error, for a failed run. */
  error?: string;
}

/** Records kept per tool; the file is trimmed to this many when it grows to twice that. */
const KEEP_RUNS = 100;

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

  /**
   * Create or replace a tool. Redefining keeps the run history and clears
   * `disabled`: a new revision is the fix for whatever disabled the old one.
   */
  save(tool: { meta: Omit<ToolMeta, "createdAt" | "updatedAt" | "revision" | "disabled">; source: string }): ToolMeta {
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
    const runs = path.join(final, "runs.jsonl");
    if (fs.existsSync(runs)) fs.copyFileSync(runs, path.join(tmp, "runs.jsonl"));
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    return meta;
  }

  /** Disable a tool with a reason, or re-enable it with `null`. Returns false for an unknown tool. */
  setDisabled(name: string, reason: string | null): boolean {
    const t = this.get(name);
    if (!t) return false;
    const { disabled: _, ...meta } = t.meta;
    const next: ToolMeta = reason === null ? meta : { ...meta, disabled: { at: new Date().toISOString(), reason } };
    this.writeMeta(name, next);
    return true;
  }

  recordRun(name: string, record: RunRecord): void {
    const file = path.join(this.dir, name, "runs.jsonl");
    if (!fs.existsSync(path.dirname(file))) return; // deleted while it ran
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    if (lines.length >= KEEP_RUNS * 2) fs.writeFileSync(file, `${lines.slice(-KEEP_RUNS).join("\n")}\n`);
  }

  /** The most recent `n` runs of a tool, oldest first. */
  history(name: string, n = KEEP_RUNS): RunRecord[] {
    const file = path.join(this.dir, name, "runs.jsonl");
    if (!TOOL_NAME.test(name) || !fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-n)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as RunRecord];
        } catch {
          return [];
        }
      });
  }

  remove(name: string): boolean {
    const dir = path.join(this.dir, name);
    if (!TOOL_NAME.test(name) || !fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  private writeMeta(name: string, meta: ToolMeta): void {
    const file = path.join(this.dir, name, "tool.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }

  private readMeta(name: string): ToolMeta {
    return JSON.parse(fs.readFileSync(path.join(this.dir, name, "tool.json"), "utf8")) as ToolMeta;
  }
}
