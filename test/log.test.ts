import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Mistral } from "../src/llm/mistral.ts";
import { createLogger, fileSink } from "../src/log.ts";
import { format, type LogRecord, matches, parse } from "../src/logs.ts";
import { call, type Harness, harness, say, until } from "./helpers.ts";

const memory = () => {
  const lines: LogRecord[] = [];
  return { lines, sink: (l: string) => lines.push(JSON.parse(l) as LogRecord) };
};

describe("logger", () => {
  it("drops lines below its level, and children carry their bindings", () => {
    const m = memory();
    const log = createLogger({ level: "info", sinks: [m.sink], bindings: { pid: 1 } });
    log.debug("hidden");
    log.child({ agent: "a1" }).child({ turn: "t1" }).info("shown", { n: 2 });
    assert.equal(m.lines.length, 1);
    const { t, ...rest } = m.lines[0] as LogRecord;
    assert.match(t, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(rest, { level: "info", msg: "shown", pid: 1, agent: "a1", turn: "t1", n: 2 });
    assert.equal(log.enabled("debug"), false);
  });

  it("writes errors as message and stack", () => {
    const m = memory();
    createLogger({ level: "debug", sinks: [m.sink] }).error("boom", { error: new Error("bad") });
    assert.equal(m.lines[0]?.error, "bad");
    assert.match(String(m.lines[0]?.error_stack), /^Error: bad\n/);
  });

  it("rotates the log file past its size cap", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seven-log-")), "logs", "seven.log");
    const log = createLogger({ level: "info", sinks: [fileSink(file, 300)] });
    for (let i = 0; i < 10; i++) log.info("line", { i, pad: "x".repeat(40) });
    assert.ok(fs.existsSync(`${file}.1`));
    const all = [...fs.readFileSync(`${file}.1`, "utf8").split("\n"), ...fs.readFileSync(file, "utf8").split("\n")]
      .filter(Boolean)
      .map((l) => JSON.parse(l).i);
    assert.ok(fs.statSync(file).size <= 300);
    assert.equal(all.at(-1), 9);
  });
});

describe("seven logs", () => {
  const line = JSON.stringify({
    t: "2026-10-21T14:05:09.123Z",
    level: "warn",
    msg: "tool called",
    agent: "a1",
    turn: "3f2a1b9c",
    step: 2,
    tool: "run_js",
    run_id: "ab12cd34",
    error: "error: timed out",
  });
  const r = parse(line) as LogRecord;

  it("filters by agent, turn, run, level and text", () => {
    assert.equal(matches(r, line, { agent: "a1", turn: "3f2a1b9c", run: "ab12cd34", level: "warn" }), true);
    assert.equal(matches(r, line, { agent: "a2" }), false);
    assert.equal(matches(r, line, { level: "error" }), false);
    assert.equal(matches(r, line, { grep: "TIMED OUT" }), true);
    assert.equal(parse("not json"), undefined);
  });

  it("prints a line with its context first", () => {
    assert.equal(
      format(r),
      '14:05:09.123  WARN   a1 #3f2a1b9c s2  tool called  tool=run_js run_id=ab12cd34 error="error: timed out"',
    );
  });
});

describe("component logging", () => {
  const open: Harness[] = [];
  after(async () => {
    for (const h of open) await h.close();
  });

  it("traces a turn through the agent loop, model, runner and supervisor", async () => {
    const h = harness(
      {
        seven: [
          call("c1", "run_js", { code: "console.log('hi'); export default 1" }),
          call("c2", "spawn_agent", { name: "kid", description: "d", instructions: "", mode: "request", tasks: ["x"] }),
          say("done"),
        ],
        a1: [say("kid done")],
      },
      { logLevel: "debug" },
    );
    open.push(h);
    await h.supervisor.root().turn({ text: "go" });
    await until(() => h.logs.some((l) => l.msg === "agent ended"));

    const find = (msg: string, where: Partial<LogRecord> = {}) =>
      h.logs.find((l) => l.msg === msg && Object.entries(where).every(([k, v]) => l[k] === v));
    const started = find("turn started", { agent: "seven" });
    assert.equal(started?.input, "user");
    const turn = started?.turn;
    assert.ok(turn);

    const tool = find("tool called", { tool: "run_js" });
    assert.equal(tool?.turn, turn);
    assert.equal(tool?.step, 1);
    assert.equal(tool?.ok, true);
    assert.equal(tool?.kind, "builtin");

    const run = find("run finished", { agent: "seven", turn });
    assert.equal(run?.outcome, "ok");
    assert.equal(run?.output_lines, 1);
    assert.equal(run?.component, "runner");
    assert.equal(find("run started", { run_id: run?.run_id })?.turn, turn);

    assert.equal(find("agent spawned")?.agent, "a1");
    assert.equal(find("turn started", { agent: "a1" })?.input, "task");
    assert.equal(find("agent ended", { agent: "a1" })?.status, "done");
    assert.equal(find("turn finished", { agent: "seven" })?.outcome, "answered");
  });

  it("never logs the API key", async () => {
    const m = memory();
    const log = createLogger({ level: "debug", sinks: [m.sink] });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    try {
      await new Mistral({ apiKey: "SECRET-KEY-123", model: "m" }).complete({
        messages: [{ role: "user", content: "hi" }],
        log,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(m.lines.some((l) => l.msg === "model replied"));
    assert.ok(!JSON.stringify(m.lines).includes("SECRET-KEY-123"));
  });
});
