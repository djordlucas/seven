import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ChatModel, Message } from "../src/llm/mistral.ts";
import { createRunner, llmModule } from "../src/runner/index.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "seven-runner-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "seven-runner-work-"));
const runner = createRunner({
  home,
  cwd: work,
  host: {
    math: {
      add: (a: number, b: number) => a + b,
      fail: () => {
        throw new Error("boom");
      },
      slow: (ms: number, v: string) => new Promise((r) => setTimeout(() => r(v), ms)),
    },
  },
});

/** Run source and return its value, failing the test on a run error. */
async function value(source: string, args?: unknown): Promise<unknown> {
  const r = await runner.eval(source, { args });
  assert.ok(r.ok, r.error);
  return r.value;
}

describe("results", () => {
  it("calls the default export with args", async () => {
    assert.deepEqual(await value(`export default (a: { x: number }) => ({ doubled: a.x * 2 })`, { x: 21 }), {
      doubled: 42,
    });
  });

  it("uses a non-function default export as the result, and null without one", async () => {
    assert.deepEqual(await value(`export default [1, "two"]`), [1, "two"]);
    assert.equal(await value(`const x = 1;`), null);
    assert.equal(await value(`export default () => undefined`), null);
  });

  it("runs TypeScript, including syntax that needs transforming", async () => {
    assert.equal(await value(`enum Color { Red = "red" } export default (): string => Color.Red`), "red");
  });

  it("captures stdout and stderr, marking stderr", async () => {
    const r = await runner.eval(`console.log("out", { a: 1 }); console.error("err"); export default 1`);
    assert.deepEqual(r.logs, ["out { a: 1 }", "[stderr] err"]);
  });

  it("reports a thrown error with its stack", async () => {
    const r = await runner.eval(`export default () => { throw new TypeError("bad input") }`);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /^TypeError: bad input\n\s+at /);
  });

  it("reports a result that is not JSON-serialisable", async () => {
    const r = await runner.eval(`export default () => 10n`);
    assert.match(r.error ?? "", /BigInt/);
  });

  it("reports a syntax error before starting a process", async () => {
    const r = await runner.eval(`export default (`);
    assert.match(r.error ?? "", /^syntax error: 1:\d+:/);
    assert.equal(r.durationMs, 0);
  });
});

describe("Node", () => {
  it("has node:fs, with relative paths in the workspace", async () => {
    await value(`import { writeFileSync } from "node:fs"; writeFileSync("hello.txt", "hi")`);
    assert.equal(fs.readFileSync(path.join(work, "hello.txt"), "utf8"), "hi");
  });

  it("has child processes", async () => {
    assert.equal(
      await value(`import { execSync } from "node:child_process"; export default execSync("echo seven").toString()`),
      "seven\n",
    );
  });

  it("has the environment", async () => {
    process.env.SEVEN_TEST_VAR = "visible";
    assert.equal(await value(`export default process.env.SEVEN_TEST_VAR`), "visible");
  });

  describe("fetch", () => {
    let server: http.Server;
    let base: string;
    before(async () => {
      server = http.createServer((req, res) => res.end(`${req.method} ${req.url}`));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => {
      server.close();
    });

    it("reaches the network", async () => {
      assert.equal(
        await value(`export default await (await fetch("${base}/x", { method: "POST" })).text()`),
        "POST /x",
      );
    });
  });

  it("isolates runs from each other", async () => {
    await value(`(globalThis as any).leak = 1`);
    assert.equal(await value(`export default typeof (globalThis as any).leak`), "undefined");
  });
});

describe("process lifetime", () => {
  it("ends the run when the default export returns, despite open handles", async () => {
    const r = await runner.eval(
      `import { createServer } from "node:http"; setInterval(() => {}, 1000); createServer().listen(0); export default "done"`,
    );
    assert.equal(r.value, "done");
    assert.ok(r.durationMs < 5000, `${r.durationMs}ms`);
  });

  it("kills a runaway loop at the timeout", async () => {
    const r = await runner.eval(`export default () => { for (;;) {} }`, { timeoutMs: 300 });
    assert.equal(r.error, "timed out after 300ms");
  });

  it("kills processes the run spawned", async () => {
    const marker = `${10_000 + Math.floor(Math.random() * 1000)}.5`;
    await runner.eval(
      `import { spawn } from "node:child_process"; spawn("sleep", ["${marker}"]); export default () => { for (;;) {} }`,
      { timeoutMs: 500 },
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(execSync(`pgrep -f "sleep ${marker}" || true`).toString().trim(), "");
  });

  it("reports a process that exits before returning", async () => {
    const r = await runner.eval(`console.error("leaving"); process.exit(3)`);
    assert.equal(r.error, "process exited (code 3) before returning a result\nleaving");
  });

  it("reports a crash from an unhandled rejection outside the default export", async () => {
    const r = await runner.eval(
      `setTimeout(() => Promise.reject(new Error("late")), 0); export default () => new Promise(() => {})`,
    );
    assert.match(r.error ?? "", /^process exited \(code 1\) before returning a result\n[\s\S]*late/);
  });

  it("enforces the heap cap", async () => {
    const small = createRunner({ home, cwd: work, memoryMb: 64 });
    const r = await small.eval(`const a: number[][] = []; for (;;) a.push(new Array(1e6).fill(1));`, {
      timeoutMs: 30_000,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /^process exited/);
    assert.ok(
      r.logs.some((l) => /heap out of memory/i.test(l)),
      r.logs.join("\n"),
    );
  });
});

describe("host functions", () => {
  it("calls the parent as seven.<module>.<fn>", async () => {
    assert.equal(await value(`export default await seven.math.add(40, 2)`), 42);
  });

  it("runs concurrent calls", async () => {
    assert.deepEqual(
      await value(`export default await Promise.all([seven.math.slow(50, "a"), seven.math.slow(10, "b")])`),
      ["a", "b"],
    );
  });

  it("rejects with the function's name when it fails or is missing", async () => {
    assert.deepEqual(
      await value(`const msg = (p) => p.then(() => "resolved", (e) => e.message);
        export default [await msg(seven.math.fail()), await msg(seven.nope.nothing())]`),
      ["seven.math.fail: boom", "seven.nope.nothing: no such host function"],
    );
  });

  it("does not make seven or a module look like a promise", async () => {
    assert.equal(await value(`await seven; await seven.math; export default "awaited"`), "awaited");
  });

  it("exposes the model as seven.llm.chat", async () => {
    const seen: Message[][] = [];
    const model: ChatModel = {
      async complete({ messages }) {
        seen.push(messages);
        return { message: { role: "assistant", content: seen.length === 1 ? "reply" : null } };
      },
    };
    const llm = createRunner({ home, cwd: work, host: { llm: llmModule(model) } });
    const r = await llm.eval(
      `export default [await seven.llm.chat("first"), await seven.llm.chat("second", "be terse")]`,
    );

    assert.deepEqual(r.value, ["reply", ""]);
    assert.deepEqual(seen, [
      [{ role: "user", content: "first" }],
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "second" },
      ],
    ]);
  });
});

describe("npm packages", { skip: !process.env.SEVEN_NET_TEST && "set SEVEN_NET_TEST=1" }, () => {
  it("installs and imports a CommonJS package", async () => {
    assert.deepEqual(await value(`import _ from "lodash"; export default _.chunk([1, 2, 3], 2)`), [[1, 2], [3]]);
  });

  it("installs a Node-only package at the requested range", async () => {
    const r = await runner.eval(
      `import fse from "fs-extra"; await fse.outputFile("deep/er/file.txt", "ok"); export default await fse.readFile("deep/er/file.txt", "utf8")`,
      { deps: { "fs-extra": "^11" } },
    );
    assert.equal(r.value, "ok", r.error);
    const pj = JSON.parse(fs.readFileSync(path.join(home, "node_modules/fs-extra/package.json"), "utf8"));
    assert.match(pj.version, /^11\./);
  });
});
