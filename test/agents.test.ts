import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { State } from "../src/state/db.ts";
import { call, type Harness, harness, type Reply, say, until } from "./helpers.ts";

const open: Harness[] = [];
after(async () => {
  for (const h of open) await h.close();
});
function start(scripts: Record<string, Reply[]>, opts?: Parameters<typeof harness>[1]): Harness {
  const h = harness(scripts, opts);
  open.push(h);
  return h;
}
const userMessages = (h: Harness, agent: string, i = -1) =>
  (h.model.of(agent).at(i)?.messages ?? []).filter((m) => m.role === "user").map((m) => m.content);

describe("agents", () => {
  it("runs a request agent and sends its answer to the parent", async () => {
    const h = start({
      seven: [
        call("s1", "spawn_agent", {
          name: "calc",
          description: "Adds numbers.",
          instructions: "Answer with the sum only.",
          mode: "request",
          tasks: ["2+2?"],
        }),
        call("s2", "wait_message", { from: "calc", timeout_ms: 10_000 }),
        say("4"),
      ],
      a1: [say("4")],
    });
    assert.equal(await h.supervisor.root().turn({ text: "add 2 and 2 with a helper" }), "4");

    assert.deepEqual(h.model.toolResults("seven"), [
      'spawned a1 "calc" (request); its final answer will be sent to you as a message',
      '[message from a1 "calc"]\nfinished:\n4',
    ]);
    const a1 = h.state.getAgent("a1");
    assert.equal(a1?.status, "done");
    assert.equal(a1?.result, "4");
    assert.deepEqual(userMessages(h, "a1"), ["2+2?"]);
    const system = String(h.model.of("a1")[0]?.messages[0]?.content);
    assert.match(system, /^You are agent a1 "calc", spawned by seven\. Adds numbers\.\n\nYou handle one task\./);
    assert.match(system, /Your instructions:\nAnswer with the sum only\./);
    assert.ok(h.events.some((e) => e.type === "finished" && e.agent === "a1" && e.status === "done"));
  });

  it("runs a sequence agent's tasks in order, one turn each", async () => {
    const h = start({ a1: [say("1"), say("2")] });
    h.supervisor.spawn("seven", {
      name: "seq",
      description: "Counts.",
      instructions: "",
      mode: "sequence",
      tasks: ["one", "two"],
      intervalS: null,
      maxSteps: null,
    });
    await until(() => h.state.getAgent("a1")?.status === "done");
    assert.equal(h.state.getAgent("a1")?.result, "2");
    assert.deepEqual(userMessages(h, "a1"), ["one", "two"]);
    assert.equal(h.state.pending("seven")[0]?.text, "finished:\n2");
  });

  it("messages a continuous agent, gets its reply, and stops it", async () => {
    const h = start({
      seven: [
        call("s1", "spawn_agent", {
          name: "echo",
          description: "Echoes.",
          instructions: "Reply to the sender with pong.",
          mode: "continuous",
        }),
        call("s2", "send_message", { to: "echo", text: "ping" }),
        call("s3", "wait_message", { from: "echo", timeout_ms: 10_000 }),
        call("s4", "stop_agent", { agent: "echo", reason: "no longer needed" }),
        call("s5", "list_agents", {}),
        call("s6", "send_message", { to: "echo", text: "still there?" }),
        say("ok"),
      ],
      a1: [call("e1", "send_message", { to: "seven", text: "pong: ping" }), say("replied")],
    });
    await h.supervisor.root().turn({ text: "go" });

    const r = h.model.toolResults("seven");
    assert.equal(r[0], 'spawned a1 "echo" (continuous)');
    assert.equal(r[1], 'sent to a1 "echo"');
    assert.equal(r[2], '[message from a1 "echo"]\npong: ping');
    assert.equal(r[3], 'stopped a1 "echo"');
    assert.match(String(r[4]), /^seven "seven" · interactive · running · The root agent/);
    assert.doesNotMatch(String(r[4]), /a1/);
    assert.equal(r[5], 'error: a1 "echo" is stopped and reads no more messages');
    assert.deepEqual(userMessages(h, "a1", 0), ['[message from seven "seven"]\nping']);
    assert.equal(h.state.getAgent("a1")?.error, "stopped by seven: no longer needed");
    assert.ok(
      (h.model.of("seven").at(-1)?.messages ?? []).some(
        (m) =>
          m.role === "user" && m.content === '[message from a1 "echo"]\nstopped:\nstopped by seven: no longer needed',
      ),
      "the parent is told, at its next step",
    );
  });

  it("finds agents, reports status, and refuses bad requests", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = start(
      {
        seven: [
          call("s1", "spawn_agent", {
            name: "researcher",
            description: "Finds papers on marine biology.",
            instructions: "Search, then summarise.",
            mode: "request",
            tasks: ["find papers"],
          }),
          call("s2", "find_agents", { query: "Biology papers" }),
          call("s3", "find_agents", { query: "astronomy" }),
          call("s4", "agent_status", { agent: "researcher" }),
          call("s5", "spawn_agent", {
            name: "researcher",
            description: "again",
            instructions: "",
            mode: "request",
            tasks: ["x"],
          }),
          call("s6", "spawn_agent", { name: "other", description: "d", instructions: "", mode: "request", tasks: [] }),
          call("s7", "send_message", { to: "nobody", text: "hi" }),
          call("s8", "stop_agent", { agent: "seven" }),
          say("ok"),
        ],
        a1: [
          async () => {
            await gate;
            return say("found 3");
          },
        ],
      },
      { env: { SEVEN_MAX_AGENTS: "1" } },
    );
    await h.supervisor.root().turn({ text: "go" });
    release();

    const r = h.model.toolResults("seven");
    assert.match(String(r[1]), /^a1 "researcher" · request · running · from seven · Finds papers on marine biology\.$/);
    assert.equal(r[2], 'no agent matches "astronomy"');
    assert.match(String(r[3]), /^a1 "researcher" · request · running · spawned by seven\ndescription: Finds papers/);
    assert.match(String(r[3]), /\ninstructions: Search, then summarise\.\n/);
    assert.equal(r[4], 'error: an active agent is already named "researcher"');
    assert.equal(r[5], "error: a request agent takes exactly one task");
    assert.equal(r[6], 'error: no agent "nobody"');
    assert.equal(r[7], "error: the root agent cannot be stopped");
    await until(() => h.state.getAgent("a1")?.status === "done");
  });

  it("caps the number of active agents", async () => {
    const h = start({}, { env: { SEVEN_MAX_AGENTS: "1" } });
    const spec = {
      description: "d",
      instructions: "",
      mode: "continuous" as const,
      tasks: [],
      intervalS: null,
      maxSteps: null,
    };
    assert.equal(typeof h.supervisor.spawn("seven", { ...spec, name: "one" }), "object");
    assert.equal(
      h.supervisor.spawn("seven", { ...spec, name: "two" }),
      "1 agents are already active, the most allowed (SEVEN_MAX_AGENTS)",
    );
  });

  it("delivers a message into a turn in progress, at the next step", async () => {
    const h = start({
      seven: [
        call("s1", "spawn_agent", {
          name: "worker",
          description: "Works.",
          instructions: "",
          mode: "continuous",
          tasks: ["start"],
        }),
        call("s2", "run_js", { code: "await new Promise((r) => setTimeout(r, 300))" }),
        call("s3", "send_message", { to: "worker", text: "also do this" }),
        say("ok"),
      ],
      a1: [call("w1", "run_js", { code: "await new Promise((r) => setTimeout(r, 1500))" }), say("saw it")],
    });
    await h.supervisor.root().turn({ text: "go" });
    await until(() => h.model.of("a1").length === 2);

    const second = h.model.of("a1")[1]?.messages ?? [];
    assert.deepEqual(
      second.slice(-2).map((m) => [m.role, m.content]),
      [
        ["tool", "null"],
        ["user", '[message from seven "seven"]\nalso do this'],
      ],
    );
  });

  it("wakes a continuous agent on its interval", async () => {
    const h = start({ a1: [say("tick 1"), say("tick 2")] });
    h.supervisor.spawn("seven", {
      name: "cron",
      description: "Periodic.",
      instructions: "Check the queue.",
      mode: "continuous",
      tasks: [],
      intervalS: 1,
      maxSteps: null,
    });
    await until(() => h.model.of("a1").length >= 2, 5000);
    assert.deepEqual(userMessages(h, "a1", 1), [
      "[scheduled wake-up] Continue with your standing instructions.",
      "[scheduled wake-up] Continue with your standing instructions.",
    ]);
    assert.match(String(h.model.of("a1")[0]?.messages[0]?.content), /you wake up every 1s when idle/);
  });

  it("fails a request agent whose model call fails, and tells the parent", async () => {
    const h = start({ a1: [] });
    h.supervisor.spawn("seven", {
      name: "doomed",
      description: "d",
      instructions: "",
      mode: "request",
      tasks: ["x"],
      intervalS: null,
      maxSteps: null,
    });
    await until(() => h.state.getAgent("a1")?.status === "failed");
    assert.equal(h.state.getAgent("a1")?.error, "script exhausted for a1");
    assert.equal(h.state.pending("seven")[0]?.text, "failed:\nscript exhausted for a1");
  });

  it("receives a message written by another process", async () => {
    const h = start({ a1: [say("got it")] });
    h.supervisor.spawn("seven", {
      name: "listener",
      description: "d",
      instructions: "",
      mode: "continuous",
      tasks: [],
      intervalS: null,
      maxSteps: null,
    });
    const other = new State(h.state.path);
    other.enqueue("a1", { sender: "user", kind: "message", text: "hi from outside" });
    other.close();
    await until(() => h.model.of("a1").length === 1);
    assert.deepEqual(userMessages(h, "a1"), ["[message from the user]\nhi from outside"]);
  });
});

describe("persistence", () => {
  it("resumes an interrupted agent after a restart and marks its lost runs", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "seven-restart-"));
    const first = harness(
      {
        seven: [
          call("s1", "spawn_agent", {
            name: "slow",
            description: "d",
            instructions: "",
            mode: "request",
            tasks: ["work"],
          }),
          call("s2", "start_tool", {
            tool: "run_js",
            args: { code: "await new Promise((r) => setTimeout(r, 30_000))" },
          }),
          say("started"),
        ],
        a1: [call("w1", "run_js", { code: "await new Promise((r) => setTimeout(r, 30_000))" })],
      },
      { workspace },
    );
    await first.supervisor.root().turn({ text: "go" });
    await until(() => first.model.of("a1").length === 1);
    await new Promise((r) => setTimeout(r, 300)); // the run is under way
    await first.close();

    const second = start({ a1: [say("resumed")] }, { workspace });
    await until(() => second.state.getAgent("a1")?.status === "done");
    assert.equal(second.state.getAgent("a1")?.result, "resumed");
    const resumed = second.model.of("a1")[0]?.messages ?? [];
    assert.deepEqual(
      resumed.slice(1).map((m) => m.role),
      ["user", "assistant", "tool"],
      "the conversation continues from the interrupted call",
    );
    assert.equal(second.state.getRun("r1")?.status, "lost");
    assert.equal(second.state.getRun("r1")?.error, "lost: seven restarted while it ran");
    assert.deepEqual(
      second.state.listAgents().map((a) => [a.id, a.status]),
      [
        ["seven", "idle"],
        ["a1", "done"],
      ],
    );
  });

  it("holds one lease per workspace", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seven-lease-")), "seven.db");
    const a = new State(file);
    const b = new State(file);
    assert.deepEqual(a.acquireLease(process.pid), { ok: true });
    assert.deepEqual(b.acquireLease(process.ppid), { ok: false, pid: process.pid });
    a.releaseLease(process.pid);
    assert.deepEqual(b.acquireLease(process.ppid), { ok: true });
    a.close();
    b.close();
  });
});

describe("databases", () => {
  it("runs SQL on workspace databases, from the sql built-in and from runs", async () => {
    const h = start({
      seven: [
        call("q1", "sql", { db: "data/a.db", query: "CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);" }),
        call("q2", "sql", { db: "data/a.db", query: "SELECT x FROM t WHERE x > ?", params: [1] }),
        call("q3", "sql", { db: "data/a.db", query: "INSERT INTO t VALUES (:v)", named: { v: 5 } }),
        call("q4", "sql", { db: "../outside.db", query: "SELECT 1" }),
        call("q5", "sql", { db: ".seven/seven.db", query: "SELECT 1" }),
        call("q6", "run_js", {
          code: `const db = seven.db("data/b.db"); db.exec("CREATE TABLE k (v)"); db.prepare("INSERT INTO k VALUES (?)").run(7); export default db.prepare("SELECT v FROM k").all()`,
        }),
        call("q7", "run_js", { code: `seven.db(".seven/seven.db")` }),
        say("ok"),
      ],
    });
    await h.supervisor.root().turn({ text: "go" });

    const r = h.model.toolResults("seven");
    assert.equal(r[0], "ok");
    assert.deepEqual(JSON.parse(String(r[1])), [{ x: 2 }]);
    assert.deepEqual(JSON.parse(String(r[2])), { changes: 1, lastInsertRowid: 3 });
    assert.equal(r[3], 'error: "../outside.db" is outside the workspace; databases live in the workspace');
    assert.equal(r[4], `error: ".seven/seven.db" is seven's own database; use another file`);
    assert.deepEqual(JSON.parse(String(r[5])), [{ v: 7 }]);
    assert.match(String(r[6]), /^error: Error: seven\.db: "\.seven\/seven\.db" is seven's own database/);
    assert.ok(fs.existsSync(path.join(h.workspace, "data/a.db")));
    assert.ok(fs.existsSync(path.join(h.workspace, "data/b.db")));
  });

  it("keeps all of seven's data in the workspace", async () => {
    const h = start({ seven: [say("hi")] });
    await h.supervisor.root().turn({ text: "hello" });
    assert.equal(h.state.path, path.join(h.workspace, ".seven", "seven.db"));
    assert.equal(h.runner.home, path.join(h.workspace, ".seven"));
    assert.equal(h.store.dir, path.join(h.workspace, ".seven", "tools"));
  });
});
