import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Agent } from "../src/agent/agent.ts";
import type { ChatModel, Completion, Message, ToolDef } from "../src/llm/mistral.ts";
import { createRunner } from "../src/runner/index.ts";
import { ToolStore } from "../src/tools/store.ts";

/** A model that plays back fixed replies and records what it was shown. */
class ScriptedModel implements ChatModel {
  readonly seen: { messages: Message[]; tools: ToolDef[] }[] = [];
  private readonly replies: Completion["message"][];

  constructor(replies: Completion["message"][]) {
    this.replies = replies;
  }

  async complete(req: { messages: Message[]; tools?: ToolDef[] }): Promise<Completion> {
    this.seen.push({ messages: structuredClone(req.messages), tools: req.tools ?? [] });
    const message = this.replies.shift();
    if (!message) throw new Error("script exhausted");
    return { message };
  }
}

const call = (id: string, name: string, args: unknown) => ({
  role: "assistant" as const,
  content: null,
  tool_calls: [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});

function setup(replies: Completion["message"][]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "seven-agent-test-"));
  const store = new ToolStore(path.join(home, "tools"));
  const runner = createRunner({ home, cwd: home });
  const model = new ScriptedModel(replies);
  return { store, model, agent: new Agent({ model, runner, store, workspace: home, maxSteps: 10 }) };
}

describe("agent", () => {
  it("defines a tool and calls it on the next step", async () => {
    const { agent, model, store } = setup([
      call("a1", "define_tool", {
        name: "shout",
        description: "Upper-cases text.",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        code: "export default async ({ text }: { text: string }) => text.toUpperCase() + '!'",
        test_args: { text: "test" },
      }),
      call("a2", "shout", { text: "hello" }),
      { role: "assistant", content: "HELLO!" },
    ]);

    assert.equal(await agent.send("shout hello"), "HELLO!");
    assert.equal(store.get("shout")?.meta.revision, 1);

    const [first, second, third] = model.seen;
    assert.ok(!first?.tools.some((t) => t.name === "shout"), "not offered before it exists");
    assert.ok(
      second?.tools.some((t) => t.name === "shout"),
      "offered on the step after definition",
    );
    const result = third?.messages.at(-1);
    assert.deepEqual(result, { role: "tool", tool_call_id: "a2", name: "shout", content: "HELLO!" });
  });

  it("refuses to save a tool whose trial run fails", async () => {
    const { agent, model, store } = setup([
      call("b1", "define_tool", {
        name: "broken",
        description: "Always throws.",
        parameters: { type: "object" },
        code: "export default () => { throw new Error('nope') }",
        test_args: {},
      }),
      { role: "assistant", content: "done" },
    ]);
    await agent.send("try");
    assert.equal(store.get("broken"), undefined);
    assert.match(
      String(model.seen[1]?.messages.at(-1)?.content),
      /^not saved: the trial run failed\nerror: Error: nope/,
    );
  });

  it("will not let a generated tool shadow a built-in", async () => {
    const { agent, model } = setup([
      call("c1", "define_tool", { name: "run_js", description: "x", parameters: {}, code: "export default 1" }),
      { role: "assistant", content: "ok" },
    ]);
    await agent.send("try");
    assert.match(String(model.seen[1]?.messages.at(-1)?.content), /is a built-in tool/);
  });

  it("reports an unknown tool to the model instead of throwing", async () => {
    const { agent, model } = setup([call("d1", "nope", {}), { role: "assistant", content: "ok" }]);
    await agent.send("try");
    assert.equal(model.seen[1]?.messages.at(-1)?.content, 'error: no tool named "nope"');
  });

  it("stops after maxSteps", async () => {
    const replies = Array.from({ length: 10 }, (_, i) => call(`e${i}`, "run_js", { code: "export default 1" }));
    const { agent } = setup(replies);
    assert.match(await agent.send("loop"), /Stopped after 10 steps/);
  });

  it("starts a run in the background, waits for it, and reports it", async () => {
    const { agent, model } = setup([
      call("f1", "start_tool", {
        tool: "run_js",
        args: { code: `console.log("working"); await new Promise((r) => setTimeout(r, 200)); export default "fin"` },
      }),
      call("f2", "wait_run", { id: "r1", timeout_ms: 10_000 }),
      call("f3", "list_runs", {}),
      { role: "assistant", content: "done" },
    ]);
    await agent.send("go");

    const results = model.seen
      .at(-1)
      ?.messages.filter((m) => m.role === "tool")
      .map((m) => m.content);
    assert.equal(results?.[0], "started r1 (run_js)");
    assert.match(
      String(results?.[1]),
      /^r1 run_js: finished in \d+\.\ds, ok\nfin\n--- output \(1 lines\) ---\nworking$/,
    );
    assert.match(String(results?.[2]), /^r1 run_js: finished in \d+\.\ds, ok$/, "checked, so no longer flagged");
  });

  it("shows a running run's status, kills it, and lists it in the system prompt meanwhile", async () => {
    const { agent, model } = setup([
      call("g1", "start_tool", {
        tool: "run_js",
        args: { code: `setInterval(() => console.log("tick"), 20); export default new Promise(() => {})` },
      }),
      call("g2", "wait_run", { id: "r1", timeout_ms: 500 }),
      call("g3", "kill_run", { id: "r1" }),
      { role: "assistant", content: "stopped it" },
    ]);
    await agent.send("go");

    const tool = (i: number) => String(model.seen[i]?.messages.at(-1)?.content);
    assert.match(tool(2), /^r1 run_js: running for \d+\.\ds\n--- output \(\d+ lines\) ---\ntick/);
    assert.match(tool(3), /^killed r1\nr1 run_js: finished in \d+\.\ds, failed: killed\nerror: killed/);
    assert.match(String(model.seen[2]?.messages[0]?.content), /## Your background runs[\s\S]*- r1 run_js: running for/);
    assert.doesNotMatch(String(model.seen[3]?.messages[0]?.content), /## Your background runs/);
  });

  it("starts one of its own tools in the background", async () => {
    const { agent, model } = setup([
      call("h1", "define_tool", {
        name: "add",
        description: "Adds.",
        parameters: { type: "object" },
        code: "export default ({ a, b }: { a: number; b: number }) => a + b",
      }),
      call("h2", "start_tool", { tool: "add", args: { a: 2, b: 3 } }),
      call("h3", "wait_run", { id: "r1" }),
      call("h4", "start_tool", { tool: "define_tool", args: {} }),
      call("h5", "run_status", { id: "r9" }),
      { role: "assistant", content: "5" },
    ]);
    await agent.send("go");
    const results = model.seen
      .at(-1)
      ?.messages.filter((m) => m.role === "tool")
      .map((m) => m.content);
    assert.match(String(results?.[2]), /^r1 add: finished in .*, ok\n5$/);
    assert.equal(results?.[3], 'error: no tool named "define_tool" that can run in the background');
    assert.equal(results?.[4], 'error: no run "r9"');
  });

  it("records every run of a tool and reports it in tool_health", async () => {
    const flaky = {
      name: "flaky",
      description: "Fails on odd input.",
      parameters: { type: "object" },
      code: "export default ({ n }: { n: number }) => { if (n % 2) throw new Error(`odd ${n}`); return n }",
    };
    const { agent, model, store } = setup([
      call("i1", "define_tool", flaky),
      call("i2", "flaky", { n: 2 }),
      call("i3", "flaky", { n: 3 }),
      call("i4", "start_tool", { tool: "flaky", args: { n: 4 } }),
      call("i5", "wait_run", { id: "r1" }),
      call("i6", "tool_health", { name: "flaky" }),
      { role: "assistant", content: "ok" },
    ]);
    await agent.send("go");

    assert.deepEqual(
      store.history("flaky").map(({ mode, ok, error, revision }) => ({ mode, ok, error, revision })),
      [
        { mode: "sync", ok: true, error: undefined, revision: 1 },
        { mode: "sync", ok: false, error: "Error: odd 3", revision: 1 },
        { mode: "async", ok: true, error: undefined, revision: 1 },
      ],
    );
    const report = String(model.seen.at(-1)?.messages.at(-1)?.content);
    assert.match(report, /^flaky \(revision 1\): enabled\nrun limit: default\nlast 3 runs: 2 ok, 1 failed; median /);
    assert.match(report, /\n- \S+ r1 sync \d+\.\ds failed: Error: odd 3\n/);
  });

  it("disables a tool: hidden, refused, named in the prompt, then re-enabled", async () => {
    const tool = { name: "bad", description: "Misbehaves.", parameters: { type: "object" }, code: "export default 1" };
    const { agent, model, store } = setup([
      call("j1", "define_tool", tool),
      call("j2", "disable_tool", { name: "bad", reason: "deletes files" }),
      call("j3", "bad", {}),
      call("j4", "start_tool", { tool: "bad" }),
      call("j5", "enable_tool", { name: "bad" }),
      call("j6", "disable_tool", { name: "bad", reason: "still bad" }),
      call("j7", "define_tool", tool),
      { role: "assistant", content: "ok" },
    ]);
    await agent.send("go");

    const offered = (i: number) => model.seen[i]?.tools.some((t) => t.name === "bad");
    const prompt = (i: number) => String(model.seen[i]?.messages[0]?.content);
    const result = (i: number) => String(model.seen[i]?.messages.at(-1)?.content);
    assert.equal(offered(2), false);
    assert.match(prompt(2), /Disabled, and not in your tool list: bad \(deletes files\)/);
    assert.equal(
      result(3),
      'error: tool "bad" is disabled (deletes files). Fix it with define_tool, or enable_tool to use it as is.',
    );
    assert.equal(result(4), result(3));
    assert.equal(offered(5), true, "enable_tool brings it back");
    assert.equal(offered(6), false);
    assert.equal(offered(7), true, "a new definition clears disabled");
    assert.equal(store.get("bad")?.meta.revision, 2);
    assert.equal(store.get("bad")?.meta.disabled, undefined);
  });

  it("applies a tool's own timeout_ms and keeps history across redefinition", async () => {
    const slow = {
      name: "slow",
      description: "Never returns.",
      parameters: { type: "object" },
      code: "export default () => new Promise(() => {})",
      timeout_ms: 300,
    };
    const { agent, model, store } = setup([
      call("k1", "define_tool", slow),
      call("k2", "slow", {}),
      call("k3", "define_tool", { ...slow, code: "export default 'fixed'", timeout_ms: undefined }),
      call("k4", "slow", {}),
      call("k5", "tool_health", { name: "slow" }),
      { role: "assistant", content: "ok" },
    ]);
    await agent.send("go");

    assert.equal(String(model.seen[2]?.messages.at(-1)?.content), "error: timed out after 300ms");
    assert.deepEqual(
      store.history("slow").map((r) => [r.revision, r.ok]),
      [
        [1, false],
        [2, true],
      ],
    );
    assert.match(
      String(model.seen[5]?.messages.at(-1)?.content),
      /^slow \(revision 2\): enabled\nrun limit: default\n/,
    );
  });
});
