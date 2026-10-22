// One test per host function, each called from inside the guest, so the whole
// path — guest wrapper, JSON bridge, Node implementation — is exercised.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import wabtInit from "wabt";
import type { ChatModel, Message } from "../src/llm/mistral.ts";
import { llmModule } from "../src/vm/host.ts";
import { createVM, runWasi } from "../src/vm/index.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "seven-host-test-"));
const vm = createVM({ cwd: work, depsDir: path.join(work, "deps") });

/** Run guest source and return its value, failing the test on a guest error. */
async function guest(source: string): Promise<unknown> {
  const r = await vm.eval(source);
  assert.ok(r.ok, r.error);
  return r.value;
}

describe("seven:fs", () => {
  it("round-trips base64 data byte for byte", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]).toString("base64");
    const back = await guest(`import { writeFile, readFile } from "seven:fs";
      await writeFile("bin/data", "${bytes}", "base64");
      export default await readFile("bin/data", "base64")`);
    assert.equal(back, bytes);
    assert.deepEqual([...fs.readFileSync(path.join(work, "bin/data"))], [0, 1, 2, 250, 255]);
  });

  it("appends to a file", async () => {
    const text = await guest(`import { writeFile, appendFile, readFile } from "seven:fs";
      await writeFile("log.txt", "a"); await appendFile("log.txt", "b"); await appendFile("log.txt", "c");
      export default await readFile("log.txt")`);
    assert.equal(text, "abc");
  });

  it("makes nested directories and lists them with their type", async () => {
    const entries = await guest(`import { mkdir, writeFile, readdir } from "seven:fs";
      await mkdir("tree/a/b"); await writeFile("tree/f.txt", "");
      export default await readdir("tree")`);
    assert.deepEqual(entries, [
      { name: "a", type: "dir" },
      { name: "f.txt", type: "file" },
    ]);
  });

  it("renames, stats and checks existence", async () => {
    const out = (await guest(`import fs from "seven:fs";
      await fs.writeFile("old.txt", "12345");
      await fs.rename("old.txt", "new.txt");
      export default { old: await fs.exists("old.txt"), now: await fs.exists("new.txt"), stat: await fs.stat("new.txt") }`)) as {
      old: boolean;
      now: boolean;
      stat: { size: number; type: string; mtime: string };
    };
    assert.equal(out.old, false);
    assert.equal(out.now, true);
    assert.equal(out.stat.size, 5);
    assert.equal(out.stat.type, "file");
    assert.ok(!Number.isNaN(Date.parse(out.stat.mtime)), out.stat.mtime);
  });

  it("removes recursively and ignores a missing path", async () => {
    const out = await guest(`import { mkdir, writeFile, rm, exists } from "seven:fs";
      await mkdir("gone/deep"); await writeFile("gone/deep/x", "x");
      await rm("gone"); await rm("never-existed");
      export default await exists("gone")`);
    assert.equal(out, false);
  });

  it("resolves absolute paths as-is", async () => {
    const abs = path.join(work, "abs.txt");
    await guest(`import { writeFile } from "seven:fs"; await writeFile(${JSON.stringify(abs)}, "abs")`);
    assert.equal(fs.readFileSync(abs, "utf8"), "abs");
  });
});

describe("seven:shell", () => {
  it("runs in a cwd relative to the workspace", async () => {
    fs.mkdirSync(path.join(work, "here"), { recursive: true });
    const r = (await guest(`import { run } from "seven:shell"; export default await run("pwd", { cwd: "here" })`)) as {
      stdout: string;
    };
    assert.equal(fs.realpathSync(r.stdout.trim()), fs.realpathSync(path.join(work, "here")));
  });

  it("feeds input to stdin", async () => {
    const r = await guest(
      `import { run } from "seven:shell"; export default await run("tr a-z A-Z", { input: "seven" })`,
    );
    assert.deepEqual(r, { code: 0, stdout: "SEVEN", stderr: "" });
  });

  it("returns a non-zero exit code and stderr instead of throwing", async () => {
    const r = await guest(`import { run } from "seven:shell"; export default await run("echo oops >&2; exit 7")`);
    assert.deepEqual(r, { code: 7, stdout: "", stderr: "oops\n" });
  });

  it("kills a command that outlives timeoutMs", async () => {
    const started = Date.now();
    const r = (await guest(
      `import { run } from "seven:shell"; export default await run("sleep 5", { timeoutMs: 100 })`,
    )) as {
      code: number;
    };
    assert.notEqual(r.code, 0);
    assert.ok(Date.now() - started < 3000);
  });
});

describe("seven:env", () => {
  it("reads one variable, all of them, and the workspace", async () => {
    process.env.SEVEN_TEST_VAR = "hello";
    const out = (await guest(`import env from "seven:env";
      const all = await env.all();
      export default { one: await env.get("SEVEN_TEST_VAR"), missing: await env.get("SEVEN_TEST_UNSET"),
        inAll: all.SEVEN_TEST_VAR, cwd: await env.cwd() }`)) as Record<string, unknown>;
    assert.deepEqual(out, { one: "hello", missing: null, inAll: "hello", cwd: work });
  });
});

describe("fetch (net.fetch)", () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        if (req.url === "/json") {
          res.writeHead(200, { "content-type": "application/json", "x-test": "yes" });
          res.end(JSON.stringify({ hi: 1 }));
        } else if (req.url === "/echo") {
          res.writeHead(201, { "content-type": "text/plain" });
          res.end(`${req.method} ${req.headers["content-type"] ?? "-"} ${body}`);
        } else {
          res.writeHead(404, "Nope");
          res.end("missing");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  it("returns status, headers and a JSON body", async () => {
    const out = await guest(`const r = await fetch("${base}/json");
      export default { ok: r.ok, status: r.status, header: r.headers.get("X-Test"), has: r.headers.has("x-test"),
        absent: r.headers.get("x-none"), body: await r.json() }`);
    assert.deepEqual(out, { ok: true, status: 200, header: "yes", has: true, absent: null, body: { hi: 1 } });
  });

  it("sends a method, headers and a JSON-encoded object body", async () => {
    const out = await guest(`const r = await fetch("${base}/echo", { method: "POST",
        headers: { "content-type": "application/json" }, body: { a: 1 } });
      export default { status: r.status, text: await r.text() }`);
    assert.deepEqual(out, { status: 201, text: 'POST application/json {"a":1}' });
  });

  it("resolves a 404 with ok false rather than throwing", async () => {
    const out = await guest(`const r = await fetch("${base}/missing");
      export default { ok: r.ok, status: r.status, statusText: r.statusText, text: await r.text() }`);
    assert.deepEqual(out, { ok: false, status: 404, statusText: "Nope", text: "missing" });
  });

  it("rejects on a connection failure", async () => {
    const out = await guest(
      `export default await fetch("http://127.0.0.1:1/").then(() => "resolved", (e) => e.message)`,
    );
    assert.match(String(out), /^net\.fetch: /);
  });
});

describe("seven:wasm", () => {
  // Writes its argv buffer then its environ buffer to stdout, copies stdin to
  // stderr, and exits 3. Each buffer is NUL-separated, as WASI lays it out.
  const PROBE = `(module
    (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes (param i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "args_get" (func $args (param i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "environ_sizes_get" (func $env_sizes (param i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "environ_get" (func $env (param i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
    (memory (export "memory") 1)
    ;; write(fd, ptr, len) through the iovec at 16; bytes written land at 24
    (func $out (param $fd i32) (param $ptr i32) (param $len i32)
      (i32.store (i32.const 16) (local.get $ptr))
      (i32.store (i32.const 20) (local.get $len))
      (drop (call $write (local.get $fd) (i32.const 16) (i32.const 1) (i32.const 24))))
    (func (export "_start")
      (drop (call $args_sizes (i32.const 0) (i32.const 4)))
      (drop (call $args (i32.const 256) (i32.const 1024)))
      (call $out (i32.const 1) (i32.const 1024) (i32.load (i32.const 4)))
      (drop (call $env_sizes (i32.const 0) (i32.const 8)))
      (drop (call $env (i32.const 512) (i32.const 2048)))
      (call $out (i32.const 1) (i32.const 2048) (i32.load (i32.const 8)))
      ;; read up to 1024 bytes of stdin into 4096 via the iovec at 32, count at 40
      (i32.store (i32.const 32) (i32.const 4096))
      (i32.store (i32.const 36) (i32.const 1024))
      (drop (call $read (i32.const 0) (i32.const 32) (i32.const 1) (i32.const 40)))
      (call $out (i32.const 2) (i32.const 4096) (i32.load (i32.const 40)))
      (call $exit (i32.const 3))))`;

  let probe: Uint8Array;
  before(async () => {
    const wabt = await wabtInit();
    probe = wabt.parseWat("probe.wat", PROBE).toBinary({}).buffer;
    fs.writeFileSync(path.join(work, "probe.wasm"), probe);
  });

  const expected = { code: 3, stdout: "module.wasm\0one\0two\0K=V\0", stderr: "piped" };
  const opts = { args: ["one", "two"], env: { K: "V" }, stdin: "piped" };

  it("passes args, env and stdin, and returns the exit code", async () => {
    assert.deepEqual(await runWasi(probe, opts), expected);
  });

  it("runs a module by workspace path from the guest", async () => {
    const out = await guest(
      `import { run } from "seven:wasm"; export default await run("probe.wasm", ${JSON.stringify(opts)})`,
    );
    assert.deepEqual(out, expected);
  });

  it("runs a module from base64 from the guest", async () => {
    const b64 = Buffer.from(probe).toString("base64");
    const out = await guest(
      `import { run } from "seven:wasm"; export default await run({ base64: "${b64}" }, ${JSON.stringify(opts)})`,
    );
    assert.deepEqual(out, expected);
  });

  it("rejects bytes that are not a wasm module", async () => {
    const out = await guest(
      `import { run } from "seven:wasm"; export default await run({ base64: "AAAA" }).then(() => "ran", (e) => e.message)`,
    );
    assert.match(String(out), /^wasm\.run: /);
  });
});

describe("seven:llm", () => {
  it("sends the prompt, with an optional system message, and returns the text", async () => {
    const seen: Message[][] = [];
    const model: ChatModel = {
      async complete({ messages }) {
        seen.push(messages);
        return { message: { role: "assistant", content: `reply ${seen.length}` } };
      },
    };
    const llmVM = createVM({ cwd: work, depsDir: path.join(work, "deps"), host: { llm: llmModule(model) } });
    const r = await llmVM.eval(`import { chat } from "seven:llm";
      export default [await chat("first"), await chat("second", "be terse")]`);

    assert.deepEqual(r.value, ["reply 1", "reply 2"]);
    assert.deepEqual(seen, [
      [{ role: "user", content: "first" }],
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "second" },
      ],
    ]);
  });

  it("returns an empty string when the model replies with no content", async () => {
    const model: ChatModel = { complete: async () => ({ message: { role: "assistant", content: null } }) };
    const llmVM = createVM({ cwd: work, depsDir: path.join(work, "deps"), host: { llm: llmModule(model) } });
    assert.equal((await llmVM.eval(`import { chat } from "seven:llm"; export default await chat("x")`)).value, "");
  });
});
