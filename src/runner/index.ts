// The runner: every piece of code the model writes runs as a module in its own
// Node.js child process, killed — with anything it spawned — when the run ends.
//
// There is no permission model. A run has all of Node: the filesystem, child
// processes, the network, any npm package. The process boundary contains
// crashes, runaway loops, memory growth and leftover handles, not authority.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToChild, ToParent } from "./child.ts";
import { initHome, installDeps, type Package } from "./deps.ts";
import type { HostModules } from "./host.ts";

export type { Package } from "./deps.ts";
export { type HostFn, type HostModules, llmModule } from "./host.ts";

export interface RunnerOptions {
  /** $SEVEN_HOME: holds node_modules, and run files must live under it to resolve them. */
  home: string;
  /** The child's working directory; the agent's workspace. */
  cwd: string;
  /** Functions the child can call as `seven.<module>.<fn>()`. */
  host?: HostModules;
  /** Wall-clock budget of one run. */
  timeoutMs?: number;
  /** V8 heap cap of one run, in MiB. */
  memoryMb?: number;
}

export interface RunResult {
  ok: boolean;
  /** The default export's return value (or the export itself), JSON round-tripped. */
  value?: unknown;
  error?: string;
  /** stdout lines verbatim, stderr lines prefixed `[stderr] `, in arrival order. */
  logs: string[];
  durationMs: number;
}

/** A run in progress, or finished. */
export interface RunHandle {
  /** Resolves when the run ends, however it ends. Never rejects. */
  readonly done: Promise<RunResult>;
  /** `Date.now()` when the run was started. */
  readonly startedAt: number;
  /** `installing` (packages), `running` (the process), or `done`. */
  state(): "installing" | "running" | "done";
  /** Complete output lines so far; the final logs once done. */
  logs(): string[];
  /** Kill the run and everything it spawned; it fails with `killed`. No effect once done. */
  kill(): void;
}

export interface EvalOptions {
  args?: unknown;
  deps?: Record<string, string>;
  timeoutMs?: number;
}

export interface Runner {
  readonly home: string;
  /** Install the packages `source` imports (and `deps`). */
  install(source: string, deps?: Record<string, string>): Promise<Package[]>;
  /** Start a module file that is already under `home`. */
  startFile(file: string, args?: unknown, timeoutMs?: number): RunHandle;
  /** Install, write to a temporary file, run, delete. An install failure is a failed run. */
  startEval(source: string, opts?: EvalOptions): RunHandle;
  /** `startFile(...).done`. */
  runFile(file: string, args?: unknown, timeoutMs?: number): Promise<RunResult>;
  /** `startEval(...).done`. */
  eval(source: string, opts?: EvalOptions): Promise<RunResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY_MB = 1024;
/** Most output kept from one run; beyond it, lines are counted and dropped. */
const MAX_LOG_CHARS = 1_000_000;
const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));

export function createRunner(opts: RunnerOptions): Runner {
  const home = path.resolve(opts.home);
  const tmp = path.join(home, "tmp");
  initHome(home);
  fs.mkdirSync(tmp, { recursive: true });

  const runner: Runner = {
    home,
    install: (source, deps) => installDeps(home, source, deps),
    startFile: (file, args, timeoutMs) =>
      startChild({
        file: path.resolve(file),
        args,
        cwd: opts.cwd,
        host: opts.host ?? {},
        timeoutMs: timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        memoryMb: opts.memoryMb ?? DEFAULT_MEMORY_MB,
      }),
    startEval(source, { args, deps, timeoutMs } = {}) {
      // Installing comes first and can take a while, so the handle exists
      // before the process does; a kill during the install cancels the run.
      const startedAt = Date.now();
      let child: RunHandle | undefined;
      let killed = false;
      let finished = false;
      const done = (async (): Promise<RunResult> => {
        try {
          await runner.install(source, deps);
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err), logs: [], durationMs: 0 };
        }
        if (killed) return { ok: false, error: "killed", logs: [], durationMs: 0 };
        const file = path.join(tmp, `run-${randomUUID()}.ts`);
        fs.writeFileSync(file, source);
        try {
          child = runner.startFile(file, args, timeoutMs);
          return await child.done;
        } finally {
          fs.rmSync(file, { force: true });
        }
      })().finally(() => {
        finished = true;
      });
      return {
        done,
        startedAt,
        state: () => (finished ? "done" : child ? "running" : "installing"),
        logs: () => child?.logs() ?? [],
        kill: () => {
          killed = true;
          child?.kill();
        },
      };
    },
    runFile: (file, args, timeoutMs) => runner.startFile(file, args, timeoutMs).done,
    eval: (source, evalOpts) => runner.startEval(source, evalOpts).done,
  };
  return runner;
}

// Every live run's process, so none outlives seven itself.
const live = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of live) killGroup(child);
});

interface ChildRun {
  file: string;
  args: unknown;
  cwd: string;
  host: HostModules;
  timeoutMs: number;
  memoryMb: number;
}

function startChild(run: ChildRun): RunHandle {
  const startedAt = Date.now();
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-transform-types",
      `--max-old-space-size=${run.memoryMb}`,
      CHILD,
    ],
    {
      cwd: run.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // Its own process group, so the whole group — including anything the
      // run spawned — can be killed at once.
      detached: true,
    },
  );

  live.add(child);
  const logs = new LogCollector();
  child.stdout?.on("data", (b: Buffer) => logs.add("", b));
  child.stderr?.on("data", (b: Buffer) => logs.add("[stderr] ", b));

  let outcome: { ok: boolean; value?: unknown; error?: string } | undefined;
  let timedOut = false;
  let killed = false;
  let finished = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child);
  }, run.timeoutMs);

  child.on("message", (m: ToParent) => {
    if (m.type === "call") {
      void callHost(run.host, m.name, m.args).then((reply) => {
        if (child.connected) child.send({ type: "reply", id: m.id, ...reply } satisfies ToChild);
      });
      return;
    }
    outcome = m.ok ? { ok: true, value: JSON.parse(m.json) } : { ok: false, error: m.error };
    // The module may have left timers, sockets or servers open; the run is
    // over regardless.
    killGroup(child);
  });

  child.send({ type: "start", file: run.file, args: run.args ?? {} } satisfies ToChild);

  const done = new Promise<RunResult>((resolve) => {
    // "close" fires after stdio has drained, so the logs are complete.
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      live.delete(child);
      finished = true;
      logs.flush();
      let result = outcome;
      if (!result) {
        if (killed) result = { ok: false, error: "killed" };
        else if (timedOut) result = { ok: false, error: `timed out after ${run.timeoutMs}ms` };
        else {
          const how = signal ? `signal ${signal}` : `code ${code}`;
          const tail = logs.stderrTail(20);
          result = { ok: false, error: `process exited (${how}) before returning a result${tail ? `\n${tail}` : ""}` };
        }
      }
      resolve({ ...result, logs: logs.lines, durationMs: Math.round(performance.now() - started) });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      live.delete(child);
      finished = true;
      resolve({ ok: false, error: `could not start the run: ${err.message}`, logs: [], durationMs: 0 });
    });
  });

  return {
    done,
    startedAt,
    state: () => (finished ? "done" : "running"),
    logs: () => [...logs.lines],
    kill: () => {
      if (finished || outcome) return;
      killed = true;
      killGroup(child);
    },
  };
}

async function callHost(
  host: HostModules,
  name: string,
  args: unknown[],
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const dot = name.indexOf(".");
  const impl = host[name.slice(0, dot)]?.[name.slice(dot + 1)] as ((...a: unknown[]) => unknown) | undefined;
  try {
    if (!impl) throw new Error("no such host function");
    return { ok: true, value: (await impl(...args)) ?? null };
  } catch (err) {
    return { ok: false, error: `seven.${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL"); // the group is already gone, or was never created
  }
  // A grandchild that moved to its own process group can hold the pipes open
  // and keep "close" from firing; stop reading after a grace period.
  setTimeout(() => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, 2000).unref();
}

/** Splits output into lines, interleaving stdout and stderr in arrival order. */
class LogCollector {
  readonly lines: string[] = [];
  private readonly partial = new Map<string, string>();
  private chars = 0;
  private dropped = 0;

  add(prefix: string, chunk: Buffer): void {
    const text = (this.partial.get(prefix) ?? "") + chunk.toString("utf8");
    const parts = text.split("\n");
    this.partial.set(prefix, parts.pop() ?? "");
    for (const p of parts) this.push(prefix + p);
  }

  flush(): void {
    for (const [prefix, rest] of this.partial) if (rest) this.push(prefix + rest);
    this.partial.clear();
    if (this.dropped > 0) this.lines.push(`… ${this.dropped} more lines dropped`);
  }

  stderrTail(n: number): string {
    return this.lines
      .filter((l) => l.startsWith("[stderr] "))
      .slice(-n)
      .map((l) => l.slice(9))
      .join("\n");
  }

  private push(line: string): void {
    if (this.chars + line.length > MAX_LOG_CHARS) {
      this.dropped++;
      return;
    }
    this.chars += line.length;
    this.lines.push(line);
  }
}
