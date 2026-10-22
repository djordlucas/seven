import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Agent } from "../src/agent/agent.ts";
import type { ChatModel, Completion, Message, ToolDef } from "../src/llm/mistral.ts";
import { ToolStore } from "../src/tools/store.ts";
import { createVM } from "../src/vm/index.ts";

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
  const vm = createVM({ cwd: home, depsDir: path.join(home, "deps") });
  const model = new ScriptedModel(replies);
  return { store, model, agent: new Agent({ model, vm, store, workspace: home, maxSteps: 10 }) };
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
});
