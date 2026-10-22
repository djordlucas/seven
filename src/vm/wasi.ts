// Raw wasm execution: a WASI preview1 command module run by Node's own wasm
// engine, for code compiled from a language other than JavaScript.
//
// node:wasi needs real file descriptors for stdio, so stdin/stdout/stderr are
// temp files read back after the module exits.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WASI } from "node:wasi";

// @types/node declares the WebAssembly namespace's types but not its values
// without the DOM lib; this is the slice used here.
const wasm = (
  globalThis as unknown as {
    WebAssembly: {
      compile(bytes: Uint8Array): Promise<object>;
      instantiate(module: object, imports: object): Promise<object>;
    };
  }
).WebAssembly;

export interface WasiOptions {
  /** argv[1..]; argv[0] is "module.wasm". */
  args?: string[];
  env?: Record<string, string>;
  stdin?: string;
  /** Host directory pre-opened as "/" in the guest. */
  cwd?: string;
}

export interface WasiResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runWasi(bytes: Uint8Array, opts: WasiOptions = {}): Promise<WasiResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seven-wasi-"));
  const file = (name: string, content = "") => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };
  const paths = { in: file("stdin", opts.stdin ?? ""), out: file("stdout"), err: file("stderr") };
  const fds = { in: fs.openSync(paths.in, "r"), out: fs.openSync(paths.out, "w"), err: fs.openSync(paths.err, "w") };

  try {
    const wasi = new WASI({
      version: "preview1",
      args: ["module.wasm", ...(opts.args ?? [])],
      env: opts.env ?? {},
      preopens: opts.cwd ? { "/": opts.cwd } : {},
      stdin: fds.in,
      stdout: fds.out,
      stderr: fds.err,
      returnOnExit: true,
    });
    const module = await wasm.compile(bytes);
    const instance = await wasm.instantiate(module, wasi.getImportObject());
    const code = wasi.start(instance);
    return { code, stdout: fs.readFileSync(paths.out, "utf8"), stderr: fs.readFileSync(paths.err, "utf8") };
  } finally {
    for (const fd of Object.values(fds)) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
