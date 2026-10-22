import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createVM } from "../src/vm/index.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "seven-vm-test-"));
const vm = createVM({
  cwd: work,
  depsDir: path.join(work, "deps"),
  host: { math: { add: (a: number, b: number) => a + b } },
});

describe("vm", () => {
  it("calls the default export with args and returns its value", async () => {
    const r = await vm.eval(`export default (a: { x: number }) => ({ doubled: a.x * 2 })`, { args: { x: 21 } });
    assert.deepEqual(r.value, { doubled: 42 });
    assert.equal(r.ok, true);
  });

  it("captures console output, including module top-level code", async () => {
    const r = await vm.eval(`console.log("top", { a: 1 }); console.warn("careful"); export default 1`);
    assert.deepEqual(r.logs, ['top {"a":1}', "[warn] careful"]);
  });

  it("runs a module with no default export for its side effects", async () => {
    const r = await vm.eval(`const xs = [1, 2, 3]; console.log(xs.reduce((a, b) => a + b));`);
    assert.equal(r.ok, true);
    assert.equal(r.value, null);
    assert.deepEqual(r.logs, ["6"]);
  });

  it("awaits host functions imported from seven:* modules", async () => {
    const r = await vm.eval(`import { add } from "seven:math"; export default async () => await add(40, 2)`);
    assert.equal(r.value, 42);
  });

  it("supports timers and top-level await", async () => {
    const r = await vm.eval(
      `await new Promise((r) => setTimeout(r, 5)); const t = setTimeout(() => { throw new Error("cleared") }, 1); clearTimeout(t); export default "slept"`,
    );
    assert.equal(r.value, "slept");
  });

  it("reads and writes files relative to cwd", async () => {
    const r = await vm.eval(
      `import { writeFile, readFile, readdir } from "seven:fs";
       await writeFile("sub/hello.txt", "hi");
       export default { text: await readFile("sub/hello.txt"), entries: await readdir("sub") }`,
    );
    assert.deepEqual(r.value, { text: "hi", entries: [{ name: "hello.txt", type: "file" }] });
    assert.equal(fs.readFileSync(path.join(work, "sub/hello.txt"), "utf8"), "hi");
  });

  it("runs shell commands", async () => {
    const r = await vm.eval(`import { run } from "seven:shell"; export default await run("echo seven")`);
    assert.deepEqual(r.value, { code: 0, stdout: "seven\n", stderr: "" });
  });

  it("turns a host failure into a guest exception", async () => {
    const r = await vm.eval(
      `import { readFile } from "seven:fs"; export default await readFile("missing").catch((e) => e.message)`,
    );
    assert.match(String(r.value), /^fs\.readFile: ENOENT/);
  });

  it("reports a thrown error with its stack", async () => {
    const r = await vm.eval(`export default () => { throw new TypeError("bad input") }`);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /^TypeError: bad input\n\s+at /);
  });

  it("interrupts a runaway loop at the deadline", async () => {
    const r = await vm.eval(`export default () => { for (;;) {} }`, { timeoutMs: 200 });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /interrupted/);
  });

  it("fails a promise that can never settle instead of hanging", async () => {
    const r = await vm.eval(`export default () => new Promise(() => {})`);
    assert.match(r.error ?? "", /never settled/);
  });

  it("times out a run stuck awaiting the host", async () => {
    const r = await vm.eval(`export default () => new Promise((r) => setTimeout(r, 10_000))`, { timeoutMs: 100 });
    assert.match(r.error ?? "", /timed out after 100ms/);
  });

  it("enforces the memory limit", async () => {
    const r = await vm.eval(`const a = []; for (;;) a.push(new Array(1e6).fill(1));`, { timeoutMs: 10_000 });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /out of memory|InternalError/i);
  });

  it("refuses Node built-ins at bundle time", async () => {
    const r = await vm.eval(`import fs from "node:fs"; export default fs.readFileSync("x")`);
    assert.match(r.error ?? "", /Node built-in/);
  });

  it("reports a syntax error from the bundler", async () => {
    const r = await vm.eval(`export default (`);
    assert.match(r.error ?? "", /^bundle failed: 1:\d+:/);
  });

  it("polyfills TextEncoder, TextDecoder, atob and btoa", async () => {
    const r = await vm.eval(
      `export default { s: new TextDecoder().decode(new TextEncoder().encode("héllo ✓ 𝄞")), b: atob(btoa("seven")) }`,
    );
    assert.deepEqual(r.value, { s: "héllo ✓ 𝄞", b: "seven" });
  });

  it("removes the host primitives from the global object", async () => {
    const r = await vm.eval(
      `export default ["__seven_call", "__seven_log", "__seven_settle", "__seven_args"].filter((k) => k in globalThis)`,
    );
    assert.deepEqual(r.value, []);
  });

  it("isolates runs from each other", async () => {
    await vm.eval(`globalThis.leak = 1`);
    const r = await vm.eval(`export default typeof globalThis.leak`);
    assert.equal(r.value, "undefined");
  });

  it("bundles npm dependencies", { skip: !process.env.SEVEN_NET_TEST && "set SEVEN_NET_TEST=1" }, async () => {
    const r = await vm.eval(`import { kebabCase } from "lodash-es"; export default kebabCase("Seven Builds Itself")`, {
      deps: { "lodash-es": "^4.17.21" },
    });
    assert.equal(r.value, "seven-builds-itself", r.error);
  });
});
