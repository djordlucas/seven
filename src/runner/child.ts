// The entry point of every run's child process. The parent sends one `start`
// message naming a module file; this imports it, calls its default export, and
// sends the result back. stdout and stderr are the parent's to capture.

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export type ToChild =
  | { type: "start"; file: string; args: unknown }
  | { type: "reply"; id: number; ok: boolean; value?: unknown; error?: string };

export type ToParent =
  | { type: "call"; id: number; name: string; args: unknown[] }
  | { type: "result"; ok: true; json: string }
  | { type: "result"; ok: false; error: string };

const send = (m: ToParent) => process.send?.(m);
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 0;

// seven.<module>.<fn>(...args) → a host call over IPC. `then` is excluded at
// both levels so that awaiting `seven` or `seven.llm` does not look like a promise.
const module_ = (mod: string) =>
  new Proxy(
    {},
    {
      get: (_, fn) =>
        typeof fn !== "string" || fn === "then"
          ? undefined
          : (...args: unknown[]) =>
              new Promise((resolve, reject) => {
                const id = ++nextId;
                pending.set(id, { resolve, reject });
                send({ type: "call", id, name: `${mod}.${fn}`, args });
              }),
    },
  );
// seven.db(path): a SQLite database in the workspace (the working directory),
// opened here in the child rather than over IPC so it is synchronous like any
// node:sqlite database. Seven's own state database is refused.
function openDb(file: string): DatabaseSync {
  const workspace = process.cwd();
  const abs = path.resolve(workspace, file);
  const rel = path.relative(workspace, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`seven.db: "${file}" is outside the workspace; databases live in the workspace`);
  }
  if (process.env.SEVEN_STATE_DB && sameFile(abs, process.env.SEVEN_STATE_DB)) {
    throw new Error(`seven.db: "${file}" is seven's own database; use another file`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return new DatabaseSync(abs);
}

/** Whether two paths name the same file, through symlinks (/var vs /private/var on macOS). */
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

Object.defineProperty(globalThis, "seven", {
  value: new Proxy(
    {},
    {
      get: (_, mod) => (mod === "db" ? openDb : typeof mod !== "string" || mod === "then" ? undefined : module_(mod)),
    },
  ),
});

process.on("message", async (m: ToChild) => {
  if (m.type === "reply") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) p?.resolve(m.value);
    else p?.reject(new Error(m.error));
    return;
  }

  try {
    const mod = await import(pathToFileURL(m.file).href);
    // A non-function default export may itself be a promise; it is awaited too.
    const out = await (typeof mod.default === "function" ? mod.default(m.args) : mod.default);
    send({ type: "result", ok: true, json: JSON.stringify(out === undefined ? null : out) ?? "null" });
  } catch (err) {
    send({ type: "result", ok: false, error: describe(err) });
  }
});

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // A stack already starts with "Name: message".
  return err.stack ?? `${err.name}: ${err.message}`;
}
