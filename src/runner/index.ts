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

export interface Runner {
  readonly home: string;
  /** Install the packages `source` imports (and `deps`). */
  install(source: string, deps?: Record<string, string>): Promise<Package[]>;
  /** Run a module file that is already under `home`. */
  runFile(file: string, args?: unknown, timeoutMs?: number): Promise<RunResult>;
  /** Install, write to a temporary file, run, delete. An install failure is a failed run. */
  eval(
    source: string,
    opts?: { args?: unknown; deps?: Record<string, string>; timeoutMs?: number },
  ): Promise<RunResult>;
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
    runFile: (file, args, timeoutMs) =>
      runChild({
        file: path.resolve(file),
        args,
        cwd: opts.cwd,
        host: opts.host ?? {},
        timeoutMs: timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        memoryMb: opts.memoryMb ?? DEFAULT_MEMORY_MB,
      }),
    async eval(source, { args, deps, timeoutMs } = {}) {
      try {
        await runner.install(source, deps);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), logs: [], durationMs: 0 };
      }
      const file = path.join(tmp, `run-${randomUUID()}.ts`);
      fs.writeFileSync(file, source);
      try {
        return await runner.runFile(file, args, timeoutMs);
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  };
  return runner;
}

interface ChildRun {
  file: string;
  args: unknown;
  cwd: string;
  host: HostModules;
  timeoutMs: number;
  memoryMb: number;
}

function runChild(run: ChildRun): Promise<RunResult> {
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

  const logs = new LogCollector();
  child.stdout?.on("data", (b: Buffer) => logs.add("", b));
  child.stderr?.on("data", (b: Buffer) => logs.add("[stderr] ", b));

  let outcome: { ok: boolean; value?: unknown; error?: string } | undefined;
  let timedOut = false;
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

  return new Promise((resolve) => {
    // "close" fires after stdio has drained, so the logs are complete.
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      logs.flush();
      let result = outcome;
      if (!result) {
        if (timedOut) result = { ok: false, error: `timed out after ${run.timeoutMs}ms` };
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
      resolve({ ok: false, error: `could not start the run: ${err.message}`, logs: [], durationMs: 0 });
    });
  });
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
