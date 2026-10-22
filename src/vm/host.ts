// The default host modules. There is no permission model: a guest can read and
// write any file, run any command and reach any URL the seven process can. The
// wasm boundary isolates crashes, runaway loops and memory, not authority.
//
// Every function takes and returns JSON-serialisable values; binary data crosses
// as base64 strings.

import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatModel } from "../llm/mistral.ts";
import type { HostModules } from "./quickjs.ts";
import { runWasi, type WasiOptions } from "./wasi.ts";

export interface HostOptions {
  /** Directory relative paths resolve against. */
  cwd: string;
}

type Encoding = "utf8" | "base64";

export function defaultHost({ cwd }: HostOptions): HostModules {
  const at = (p: string) => path.resolve(cwd, p);

  return {
    sys: {
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
    },

    net: {
      fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        const res = await fetch(url, init);
        return {
          status: res.status,
          statusText: res.statusText,
          url: res.url,
          headers: Object.fromEntries(res.headers),
          body: await res.text(),
        };
      },
    },

    fs: {
      readFile: (p: string, encoding: Encoding = "utf8") => fs.readFile(at(p), encoding),
      writeFile: async (p: string, data: string, encoding: Encoding = "utf8") => {
        await fs.mkdir(path.dirname(at(p)), { recursive: true });
        await fs.writeFile(at(p), data, encoding);
      },
      appendFile: (p: string, data: string) => fs.appendFile(at(p), data),
      readdir: async (p = ".") =>
        (await fs.readdir(at(p), { withFileTypes: true })).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
        })),
      mkdir: async (p: string) => {
        await fs.mkdir(at(p), { recursive: true });
      },
      rm: (p: string) => fs.rm(at(p), { recursive: true, force: true }),
      rename: (from: string, to: string) => fs.rename(at(from), at(to)),
      stat: async (p: string) => {
        const s = await fs.stat(at(p));
        return { size: s.size, type: s.isDirectory() ? "dir" : "file", mtime: s.mtime.toISOString() };
      },
      exists: (p: string) =>
        fs.access(at(p)).then(
          () => true,
          () => false,
        ),
    },

    shell: {
      run: (command: string, opts: { cwd?: string; input?: string; timeoutMs?: number } = {}) =>
        new Promise((resolve) => {
          const child = exec(
            command,
            { cwd: at(opts.cwd ?? "."), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => {
              const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
              resolve({ code, stdout, stderr });
            },
          );
          if (opts.input !== undefined) child.stdin?.end(opts.input);
        }),
    },

    env: {
      get: (name: string) => process.env[name] ?? null,
      all: () => ({ ...process.env }),
      cwd: () => cwd,
    },

    wasm: {
      /** Run a WASI preview1 command module, given a path or base64 bytes. */
      run: async (module: string | { base64: string }, opts: WasiOptions = {}) => {
        const bytes = typeof module === "string" ? await fs.readFile(at(module)) : Buffer.from(module.base64, "base64");
        return runWasi(bytes, { ...opts, cwd: opts.cwd ? at(opts.cwd) : cwd });
      },
    },
  };
}

/** `seven:llm`: one tool-less call to the model the agent runs on. */
export function llmModule(model: ChatModel): HostModules[string] {
  return {
    chat: async (prompt: string, system?: string) => {
      const { message } = await model.complete({
        messages: [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          { role: "user", content: prompt },
        ],
      });
      return message.content ?? "";
    },
  };
}
