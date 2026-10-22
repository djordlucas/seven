// Turning model-written source into something the guest can load: one ESM
// module with no imports left but `seven:*`.
//
// esbuild does the work. TypeScript is stripped, and every bare import is an
// npm package: it is installed with npm into one shared cache directory, then
// inlined. Install scripts never run (--ignore-scripts). Nothing is allowlisted.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { build, type Plugin } from "esbuild";

const run = promisify(execFile);

export interface BundleOptions {
  /** Directory holding the shared node_modules for guest dependencies. */
  depsDir: string;
  /** Explicit version ranges; a package imported but not listed gets `latest`. */
  deps?: Record<string, string>;
}

export interface BundleResult {
  code: string;
  /** Top-level packages the module imports, with the version installed. */
  packages: { name: string; version: string }[];
}

const NODE_BUILTINS = new Set((await import("node:module")).builtinModules.filter((m) => !m.startsWith("_")));

export async function bundle(source: string, opts: BundleOptions): Promise<BundleResult> {
  const imported = await scanImports(source);
  const names = [...new Set([...imported, ...Object.keys(opts.deps ?? {})])].sort();

  for (const name of names) {
    if (name.startsWith("node:") || NODE_BUILTINS.has(name)) {
      throw new Error(`"${name}" is a Node built-in, which the guest does not have; use the seven:* host modules`);
    }
  }
  if (names.length > 0) await install(names, opts);

  const out = await build({
    stdin: { contents: source, loader: "ts", resolveDir: opts.depsDir, sourcefile: "tool.ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    conditions: ["import", "module", "default"],
    nodePaths: [path.join(opts.depsDir, "node_modules")],
    external: ["seven:*"],
    logLevel: "silent",
  }).catch((err: unknown) => {
    throw new Error(`bundle failed: ${formatEsbuildError(err)}`);
  });

  const packages = names.map((name) => ({ name, version: installedVersion(opts.depsDir, name) ?? "unknown" }));
  return { code: out.outputFiles[0]?.text ?? "", packages };
}

/** The npm package names `source` imports, without resolving anything. */
async function scanImports(source: string): Promise<string[]> {
  const found = new Set<string>();
  const collect: Plugin = {
    name: "collect-bare-imports",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return undefined;
        const spec = args.path;
        if (spec.startsWith("seven:") || spec.startsWith(".") || spec.startsWith("/")) {
          return { path: spec, external: true };
        }
        found.add(packageName(spec));
        return { path: spec, external: true };
      });
    },
  };
  await build({
    stdin: { contents: source, loader: "ts", sourcefile: "tool.ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    plugins: [collect],
    logLevel: "silent",
  }).catch((err: unknown) => {
    throw new Error(`bundle failed: ${formatEsbuildError(err)}`);
  });
  return [...found];
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

function installedVersion(depsDir: string, name: string): string | undefined {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(depsDir, "node_modules", name, "package.json"), "utf8"));
    return typeof pj.version === "string" ? pj.version : undefined;
  } catch {
    return undefined;
  }
}

// npm is not safe to run concurrently against one prefix; installs queue here.
let installs: Promise<unknown> = Promise.resolve();

async function install(names: string[], opts: BundleOptions): Promise<void> {
  const missing = names.filter((n) => opts.deps?.[n] !== undefined || !installedVersion(opts.depsDir, n));
  if (missing.length === 0) return;

  const job = installs.then(async () => {
    fs.mkdirSync(opts.depsDir, { recursive: true });
    const pj = path.join(opts.depsDir, "package.json");
    if (!fs.existsSync(pj)) fs.writeFileSync(pj, `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
    const specs = missing.map((n) => `${n}@${opts.deps?.[n] ?? "latest"}`);
    try {
      await run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", ...specs], {
        cwd: opts.depsDir,
        timeout: 180_000,
      });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      throw new Error(`npm install ${specs.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
    }
  });
  installs = job.catch(() => {});
  await job;
}

function formatEsbuildError(err: unknown): string {
  const errors = (err as { errors?: { text: string; location?: { line: number; column: number } | null }[] }).errors;
  if (!errors?.length) return err instanceof Error ? err.message : String(err);
  return errors.map((e) => (e.location ? `${e.location.line}:${e.location.column}: ${e.text}` : e.text)).join("\n");
}
