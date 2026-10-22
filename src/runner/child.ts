// The entry point of every run's child process. The parent sends one `start`
// message naming a module file; this imports it, calls its default export, and
// sends the result back. stdout and stderr are the parent's to capture.

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
Object.defineProperty(globalThis, "seven", {
  value: new Proxy({}, { get: (_, mod) => (typeof mod !== "string" || mod === "then" ? undefined : module_(mod)) }),
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
