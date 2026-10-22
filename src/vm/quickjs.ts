// The QuickJS guest: one fresh runtime per run, torn down when the run returns.
//
// The interpreter is QuickJS compiled to wasm (quickjs-emscripten). The guest
// reaches the host through exactly one async primitive, `call(name, argsJSON)`,
// which resolves to `{ok, value}` or `{ok: false, error}` JSON. Everything the
// guest sees — console, fetch, timers, the `seven:*` modules — is built on that
// primitive by PRELUDE below, so adding a host function never touches this file.

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";

/** A host function the guest can call. Arguments and result cross as JSON. */
export type HostFn = (...args: never[]) => unknown;

/** Host functions grouped by module: `{ fs: { readFile } }` is `seven:fs`. */
export type HostModules = Record<string, Record<string, HostFn>>;

export interface RunOptions {
  /** ESM source with no imports left but `seven:*` (see bundle.ts). */
  source: string;
  /** Passed as the first argument to the module's default export. */
  args?: unknown;
  host?: HostModules;
  /** Wall-clock budget for the whole run, CPU and awaits together. */
  timeoutMs?: number;
  memoryLimitBytes?: number;
}

export interface RunResult {
  ok: boolean;
  /** The default export's return value (or the export itself), JSON round-tripped. */
  value?: unknown;
  error?: string;
  /** console output, one entry per call, prefixed by level when not `log`. */
  logs: string[];
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT = 256 * 1024 * 1024;
const MAX_STACK_BYTES = 4 * 1024 * 1024;

let quickjs: Promise<QuickJSWASMModule> | undefined;
function engine(): Promise<QuickJSWASMModule> {
  quickjs ??= getQuickJS();
  return quickjs;
}

const ENTRY = "seven:entry";
const HARNESS = "seven:harness";

/** Run `source` in a fresh QuickJS runtime and return what its default export produced. */
export async function runModule(opts: RunOptions): Promise<RunResult> {
  const started = performance.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const host = opts.host ?? {};
  const logs: string[] = [];

  const rt = (await engine()).newRuntime();
  rt.setMemoryLimit(opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT);
  rt.setMaxStackSize(MAX_STACK_BYTES);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const vm = rt.newContext();

  const run = new GuestRun(rt, vm, host, logs);
  const finish = (r: Omit<RunResult, "logs" | "durationMs">): RunResult => ({
    ...r,
    logs,
    durationMs: Math.round(performance.now() - started),
  });

  try {
    rt.setModuleLoader(
      (name) => {
        if (name === ENTRY) return opts.source;
        if (name === HARNESS) return HARNESS_SOURCE;
        const mod = name.startsWith("seven:") ? host[name.slice(6)] : undefined;
        if (mod) return moduleSource(name.slice(6), Object.keys(mod));
        return { error: new Error(`module not found: ${name} (bundle npm packages; host modules are seven:*)`) };
      },
      (_base, requested) => requested,
    );

    run.install(opts.args);
    const prelude = vm.evalCode(PRELUDE, "seven:prelude");
    if (prelude.error) return finish({ ok: false, error: run.describe(prelude.error) });
    prelude.value.dispose();

    const evaluated = vm.evalCode(`import "${HARNESS}";`, "seven:main", { type: "module" });
    if (evaluated.error) return finish({ ok: false, error: run.describe(evaluated.error) });
    return finish(await evaluated.value.consume((p) => run.wait(timeoutMs, p)));
  } catch (err) {
    return finish({ ok: false, error: errorText(err) });
  } finally {
    run.teardown();
    vm.dispose();
    rt.dispose();
  }
}

/** The live state of one run: in-flight host calls and the settled result. */
class GuestRun {
  private readonly pending = new Set<QuickJSDeferredPromise>();
  private settled?: { ok: boolean; value?: unknown; error?: string };
  private wake: () => void = () => {};
  private disposed = false;

  private readonly rt: QuickJSRuntime;
  private readonly vm: QuickJSContext;
  private readonly host: HostModules;
  private readonly logs: string[];

  constructor(rt: QuickJSRuntime, vm: QuickJSContext, host: HostModules, logs: string[]) {
    this.rt = rt;
    this.vm = vm;
    this.host = host;
    this.logs = logs;
  }

  /** Install the host primitives the prelude captures and then deletes. */
  install(args: unknown): void {
    const { vm } = this;
    const fns: Record<string, (...h: QuickJSHandle[]) => QuickJSHandle | undefined> = {
      __seven_log: (level, text) => {
        const l = vm.getString(level);
        const t = vm.getString(text);
        this.logs.push(l === "log" ? t : `[${l}] ${t}`);
        return undefined;
      },
      __seven_call: (name, argsJSON) => this.call(vm.getString(name), vm.getString(argsJSON)),
      __seven_settle: (ok, payload) => {
        const text = vm.getString(payload);
        this.settled = vm.dump(ok) ? { ok: true, value: JSON.parse(text) } : { ok: false, error: text };
        this.wake();
        return undefined;
      },
    };
    for (const [name, impl] of Object.entries(fns)) {
      vm.newFunction(name, impl).consume((fn) => vm.setProp(vm.global, name, fn));
    }
    vm.newString(JSON.stringify(args ?? {})).consume((s) => vm.setProp(vm.global, "__seven_args", s));
  }

  /** Start a host call and hand the guest a promise for its JSON envelope. */
  private call(name: string, argsJSON: string): QuickJSHandle {
    const deferred = this.vm.newPromise();
    this.pending.add(deferred);
    const [mod, fn] = splitName(name);
    const impl = this.host[mod]?.[fn];

    void (async () => {
      let envelope: string;
      try {
        if (!impl) throw new Error(`no host function ${name}`);
        const value = await (impl as (...a: unknown[]) => unknown)(...(JSON.parse(argsJSON) as unknown[]));
        envelope = JSON.stringify({ ok: true, value: value ?? null });
      } catch (err) {
        envelope = JSON.stringify({ ok: false, error: errorText(err) });
      }
      if (this.disposed) return;
      this.vm.newString(envelope).consume((s) => deferred.resolve(s));
      this.pending.delete(deferred);
      deferred.dispose();
      this.pump();
    })();

    return deferred.handle;
  }

  /** Run queued guest jobs. A job that throws is reported, not swallowed. */
  private pump(): void {
    if (this.disposed) return;
    const res = this.rt.executePendingJobs();
    if (res.error) {
      const text = this.describe(res.error);
      this.settled ??= { ok: false, error: text };
    }
    this.wake();
  }

  /** Drive the guest until it settles, deadlocks, or runs out of time. `evaluation` is the entry module's promise. */
  async wait(timeoutMs: number, evaluation: QuickJSHandle): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    this.pump();
    const deadline = Date.now() + timeoutMs;
    while (!this.settled) {
      if (this.pending.size === 0) {
        // Evaluation can fail outside the harness's try — an interrupt, a
        // module that throws while loading — and lands as a rejection here.
        const state = this.vm.getPromiseState(evaluation);
        if (state.type === "rejected") return { ok: false, error: this.describe(state.error) };
        return { ok: false, error: "the module's promise never settled (nothing left to await)" };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, error: `timed out after ${timeoutMs}ms` };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return this.settled;
  }

  describe(handle: QuickJSHandle): string {
    const dumped = handle.consume((h) => this.vm.dump(h)) as unknown;
    if (dumped && typeof dumped === "object" && "message" in dumped) {
      const e = dumped as { name?: string; message?: string; stack?: string };
      return [`${e.name ?? "Error"}: ${e.message}`, e.stack?.trimEnd()].filter(Boolean).join("\n");
    }
    return String(dumped);
  }

  /** Dispose every promise still owed to the guest, so the runtime frees cleanly. */
  teardown(): void {
    this.disposed = true;
    for (const d of this.pending) d.dispose();
    this.pending.clear();
  }
}

function splitName(name: string): [string, string] {
  const dot = name.indexOf(".");
  return dot < 0 ? ["", name] : [name.slice(0, dot), name.slice(dot + 1)];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `seven:<mod>`: one named export per host function, plus a default object of all of them. */
function moduleSource(mod: string, names: string[]): string {
  const host = `globalThis[Symbol.for("seven.host")]`;
  const lines = names.map((n) => `export const ${n} = ${host}(${JSON.stringify(`${mod}.${n}`)});`);
  lines.push(`export default { ${names.join(", ")} };`);
  return lines.join("\n");
}

// Runs as a script before any module. It captures the host primitives into
// closures, removes them from the global object, and builds the web-platform
// pieces QuickJS lacks (it implements ECMAScript only): console, timers, fetch,
// TextEncoder/TextDecoder, atob/btoa.
// biome-ignore lint/complexity/noUselessStringRaw: guest source is raw so an escape added later reaches QuickJS intact.
const PRELUDE = String.raw`
(() => {
  const call = globalThis.__seven_call;
  const log = globalThis.__seven_log;
  const settle = globalThis.__seven_settle;
  const argsJSON = globalThis.__seven_args;
  for (const k of ["__seven_call", "__seven_log", "__seven_settle", "__seven_args"]) delete globalThis[k];

  const host = (name) => async (...args) => {
    const res = JSON.parse(await call(name, JSON.stringify(args)));
    if (!res.ok) throw new Error(name + ": " + res.error);
    return res.value;
  };
  globalThis[Symbol.for("seven.host")] = host;
  globalThis[Symbol.for("seven.settle")] = settle;
  globalThis[Symbol.for("seven.args")] = () => JSON.parse(argsJSON);

  const fmt = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.name + ": " + v.message;
    try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
  };
  const logAt = (level) => (...a) => log(level, a.map(fmt).join(" "));
  globalThis.console = {
    log: logAt("log"), info: logAt("info"), debug: logAt("debug"),
    warn: logAt("warn"), error: logAt("error"),
  };

  const sleep = host("sys.sleep");
  let nextTimer = 0;
  const live = new Set();
  globalThis.setTimeout = (fn, ms = 0, ...a) => {
    const id = ++nextTimer;
    live.add(id);
    sleep(ms).then(() => { if (live.delete(id)) fn(...a); });
    return id;
  };
  globalThis.clearTimeout = (id) => { live.delete(id); };
  globalThis.queueMicrotask ??= (fn) => { Promise.resolve().then(fn); };

  const utf8 = {
    encode(s = "") {
      const out = [];
      for (const ch of String(s)) {
        let c = ch.codePointAt(0);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    },
    decode(b) {
      const u = b instanceof Uint8Array ? b : new Uint8Array(b?.buffer ?? b ?? []);
      let s = "";
      for (let i = 0; i < u.length; ) {
        const x = u[i++];
        let c;
        if (x < 0x80) c = x;
        else if (x < 0xe0) c = ((x & 31) << 6) | (u[i++] & 63);
        else if (x < 0xf0) c = ((x & 15) << 12) | ((u[i++] & 63) << 6) | (u[i++] & 63);
        else c = ((x & 7) << 18) | ((u[i++] & 63) << 12) | ((u[i++] & 63) << 6) | (u[i++] & 63);
        s += String.fromCodePoint(c);
      }
      return s;
    },
  };
  globalThis.TextEncoder ??= class TextEncoder { get encoding() { return "utf-8"; } encode(s) { return utf8.encode(s); } };
  globalThis.TextDecoder ??= class TextDecoder { get encoding() { return "utf-8"; } decode(b) { return utf8.decode(b); } };

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  globalThis.btoa ??= (bin) => {
    let out = "";
    for (let i = 0; i < bin.length; i += 3) {
      const n = (bin.charCodeAt(i) << 16) | ((bin.charCodeAt(i + 1) || 0) << 8) | (bin.charCodeAt(i + 2) || 0);
      out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bin.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bin.length ? B64[n & 63] : "=");
    }
    return out;
  };
  globalThis.atob ??= (s) => {
    s = String(s).replace(/[^A-Za-z0-9+/]/g, "");
    let out = "";
    for (let i = 0; i < s.length; i += 4) {
      const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
      out += String.fromCharCode(n >> 16);
      if (s[i + 2]) out += String.fromCharCode((n >> 8) & 255);
      if (s[i + 3]) out += String.fromCharCode(n & 255);
    }
    return out;
  };

  const netFetch = host("net.fetch");
  globalThis.fetch = async (input, init = {}) => {
    let body = init.body;
    if (body !== undefined && typeof body !== "string") body = JSON.stringify(body);
    const r = await netFetch(String(input), { method: init.method, headers: init.headers, body });
    const headers = new Map(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText, url: r.url,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null, has: (k) => headers.has(String(k).toLowerCase()), entries: () => headers.entries() },
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
    };
  };
})();
`;

// The entry module: imports the author's module (its top-level code runs after
// the prelude, so console already exists), calls the default export, settles.
const HARNESS_SOURCE = String.raw`
import * as mod from "${ENTRY}";
const settle = globalThis[Symbol.for("seven.settle")];
const args = globalThis[Symbol.for("seven.args")]();
try {
  const out = typeof mod.default === "function" ? await mod.default(args) : mod.default;
  settle(true, JSON.stringify(out === undefined ? null : out) ?? "null");
} catch (e) {
  settle(false, e instanceof Error ? [e.name + ": " + e.message, e.stack].filter(Boolean).join("\n").trimEnd() : String(e));
}
`;
