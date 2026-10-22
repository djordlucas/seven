// SQLite databases for agents: any file in the workspace except seven's own.

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Builtin } from "./shared.ts";

/** Rows returned to the model at most; the rest are counted. */
const MAX_ROWS = 200;

export function sqlBuiltins(): Builtin[] {
  return [
    {
      name: "sql",
      description:
        "Run SQL against a SQLite database file in the workspace, creating it if needed. Each database is its own " +
        "file, so use as many as you like (e.g. data/notes.db). A query returning rows gives the rows; any other " +
        "statement gives changes and lastInsertRowid. Without params or named, several statements separated by ; may " +
        "be run at once.",
      parameters: {
        type: "object",
        properties: {
          db: { type: "string", description: "Path of the database file, relative to the workspace." },
          query: { type: "string" },
          params: { type: "array", description: "Values for ? placeholders, in order." },
          named: { type: "object", description: 'Values for :name placeholders, e.g. {"name": "x"} for :name.' },
        },
        required: ["db", "query"],
      },
      async run(a, ctx) {
        const file = resolveDb(ctx.workspace, ctx.stateDb, String(a.db));
        if (file.startsWith("error:")) return file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const db = new DatabaseSync(file);
        try {
          return run(db, String(a.query), a.params, a.named);
        } catch (err) {
          return `error: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          db.close();
        }
      },
    },
  ];
}

/** A workspace-relative database path, or an `error:` string for a path outside the workspace or seven's own. */
export function resolveDb(workspace: string, stateDb: string, p: string): string {
  const file = path.resolve(workspace, p);
  const rel = path.relative(workspace, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return `error: "${p}" is outside the workspace; databases live in the workspace`;
  }
  if (sameFile(file, stateDb)) return `error: "${p}" is seven's own database; use another file`;
  return file;
}

/** Whether two paths name the same file, through symlinks. */
function sameFile(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

function run(db: DatabaseSync, query: string, params: unknown, named: unknown): string {
  const stmt = db.prepare(query);
  const positional = Array.isArray(params) ? (params as SQLInputValue[]) : [];
  const byName =
    named && typeof named === "object" && !Array.isArray(named) ? [named as Record<string, SQLInputValue>] : [];
  const bind = [...byName, ...positional] as SQLInputValue[];

  if (stmt.columns().length > 0) {
    const rows = stmt.all(...bind);
    const shown = rows.slice(0, MAX_ROWS);
    const more = rows.length > MAX_ROWS ? `\n… ${rows.length - MAX_ROWS} more rows` : "";
    return `${JSON.stringify(shown, jsonSafe, 2)}${more}`;
  }
  if (params === undefined && named === undefined && /;\s*\S/.test(query)) {
    db.exec(query);
    return "ok";
  }
  const r = stmt.run(...bind);
  return JSON.stringify({ changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) });
}

function jsonSafe(_key: string, v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return { base64: Buffer.from(v).toString("base64") };
  return v;
}
