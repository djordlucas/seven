// The VM: bundle model-written source, then run it in a fresh QuickJS-in-wasm
// runtime with the host modules attached.

import * as path from "node:path";
import { type BundleResult, bundle } from "./bundle.ts";
import { defaultHost } from "./host.ts";
import { type HostModules, type RunResult, runModule } from "./quickjs.ts";

export type { BundleResult } from "./bundle.ts";
export type { HostFn, HostModules, RunResult } from "./quickjs.ts";
export { runWasi } from "./wasi.ts";

export interface VMOptions {
  /** Where relative paths in the guest resolve; the agent's workspace. */
  cwd: string;
  /** Shared npm cache for guest dependencies. */
  depsDir: string;
  /** Extra host modules, merged over the defaults (a key here replaces a default module). */
  host?: HostModules;
  timeoutMs?: number;
}

export interface VM {
  readonly host: HostModules;
  bundle(source: string, deps?: Record<string, string>): Promise<BundleResult>;
  /** Run already-bundled code. */
  run(code: string, args?: unknown, timeoutMs?: number): Promise<RunResult>;
  /** Bundle and run in one step; a bundle failure is returned as a failed run. */
  eval(
    source: string,
    opts?: { args?: unknown; deps?: Record<string, string>; timeoutMs?: number },
  ): Promise<RunResult>;
}

export function createVM(opts: VMOptions): VM {
  const host: HostModules = { ...defaultHost({ cwd: opts.cwd }), ...opts.host };
  const depsDir = path.resolve(opts.depsDir);

  const vm: VM = {
    host,
    bundle: (source, deps) => bundle(source, { depsDir, deps }),
    run: (code, args, timeoutMs = opts.timeoutMs) => runModule({ source: code, args, host, timeoutMs }),
    async eval(source, { args, deps, timeoutMs } = {}) {
      let code: string;
      try {
        code = (await vm.bundle(source, deps)).code;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), logs: [], durationMs: 0 };
      }
      return vm.run(code, args, timeoutMs);
    },
  };
  return vm;
}
