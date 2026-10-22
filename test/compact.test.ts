import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { cutIndex, isOverflow, render, summarizeConversation, TokenEstimator } from "../src/agent/compact.ts";
import type { Message } from "../src/llm/mistral.ts";
import { SCHEMA_VERSION, State } from "../src/state/db.ts";
import { call, type Harness, harness, type Reply, ScriptedModel, say } from "./helpers.ts";

const open: Harness[] = [];
after(async () => {
  for (const h of open) await h.close();
});
function start(scripts: Record<string, Reply[]>, opts?: Parameters<typeof harness>[1]): Harness {
  const h = harness(scripts, opts);
  open.push(h);
  return h;
}

const user = (content: string): Message => ({ role: "user", content });
const tool = (content: string): Message => ({ role: "tool", tool_call_id: "k", name: "run_js", content });
const contents = (ms: Message[]) => ms.map((m) => m.content);

// A request with no conversation is about 13,000 characters (system prompt and
// tools). With a 10,000-token window and 3 characters per token, compaction
// starts above 22,500 characters and keeps at most 7,500.
const SMALL_WINDOW = { SEVEN_CONTEXT_TOKENS: "10000" };
const big = (c: string) => c.repeat(6_000);

describe("cutting a conversation", () => {
  it("keeps the most recent messages that fit, preferably from a user message", () => {
    const ms = [user("u1"), say(big("a")), user("u2"), say("a2"), user("u3")];
    assert.equal(cutIndex(ms, 1_000), 2);
    assert.equal(cutIndex(ms, 100_000), 2);
    assert.equal(cutIndex([user("u1"), say("a1"), say("a2")], 100_000), 1);
  });

  it("never starts the kept part at a tool result", () => {
    const ms = [user("u1"), call("k", "run_js", {}), tool("r1"), tool("r2")];
    assert.equal(cutIndex(ms, 10), 1);
  });

  it("keeps the shortest valid part when nothing fits", () => {
    const ms = [user("u1"), say("a1"), user(big("x"))];
    assert.equal(cutIndex(ms, 10), 2);
  });

  it("folds nothing from a one-message conversation", () => {
    assert.equal(cutIndex([user(big("x"))], 10), 0);
    assert.equal(cutIndex([], 10), 0);
  });
});

describe("summarizing", () => {
  it("folds a long conversation chunk by chunk, each into the summary of the last", async () => {
    const model = new ScriptedModel({ summarizer: [say("S1"), say("S2"), say("S3")] });
    const out = await summarizeConversation(model, {
      previous: null,
      messages: [user(big("a").slice(0, 1_000)), user(big("b").slice(0, 1_000)), user(big("c").slice(0, 1_000))],
      contextTokens: 1_000, // 1,500-character chunks: one message each
      estimator: new TokenEstimator(),
    });
    assert.equal(out, "S3");
    const prompts = model.of("summarizer").map((s) => String(s.messages[1]?.content));
    assert.equal(prompts.length, 3);
    assert.doesNotMatch(prompts[0] as string, /summary so far/);
    assert.match(prompts[1] as string, /^The summary so far:\n\nS1\n\nThe conversation since then:\n\n\[user\]\nb/);
    assert.match(prompts[2] as string, /^The summary so far:\n\nS2\n/);
  });

  it("shows tool calls and cuts long results for the summarizer", () => {
    assert.equal(render(call("k", "sql", { db: "a.db" })), '[assistant]\n→ sql({"db":"a.db"})');
    const r = render(tool("x".repeat(10_000)));
    assert.ok(r.startsWith("[result of run_js]\nxxx"));
    assert.match(r, /\[6000 characters cut\]/);
  });

  it("recognises a context overflow", () => {
    assert.ok(isOverflow(new Error("mistral: 400 Bad Request: Prompt contains 40000 tokens, too large for model")));
    assert.ok(!isOverflow(new Error("mistral: 400 Bad Request: invalid tool schema")));
    assert.ok(!isOverflow(new Error("mistral: 503 Service Unavailable: overloaded, too many tokens")));
  });

  it("calibrates characters per token from reported usage, within bounds", () => {
    const e = new TokenEstimator();
    assert.equal(e.tokens(300), 100);
    e.calibrate(4_000, 1_000);
    assert.equal(e.tokens(4_000), 1_000);
    e.calibrate(100, 1_000);
    assert.equal(e.charsPerToken, 1.5);
  });
});

describe("compaction in the agent loop", () => {
  it("compacts near the window, sends the summary, and keeps every message on record", async () => {
    const h = start(
      {
        seven: [say(big("A")), say(big("B")), say("three"), say("four")],
        summarizer: [say("SUMMARY-1")],
      },
      { env: SMALL_WINDOW, logLevel: "info" },
    );
    const root = h.supervisor.root();
    await root.turn({ text: "first request" });
    await root.turn({ text: "second" });
    assert.equal(h.model.of("summarizer").length, 0);

    await root.turn({ text: "third" });
    const folded = String(h.model.of("summarizer")[0]?.messages[1]?.content);
    assert.match(folded, /^The conversation:\n\n\[user\]\nfirst request\n\n\[assistant\]\nAAA/);

    const sent = h.model.of("seven").at(-1)?.messages ?? [];
    assert.match(String(sent[0]?.content), /## Earlier in this conversation\n\n.*\n\nSUMMARY-1$/);
    assert.equal(sent[1]?.content, "second");
    assert.deepEqual(contents(h.state.history("seven")).slice(-2), ["third", "three"]);
    assert.equal(h.state.transcriptLength("seven"), 6);
    assert.equal(h.state.getAgent("seven")?.compactions, 1);

    const line = h.logs.find((l) => l.msg === "context compacted");
    assert.equal(line?.reason, "threshold");
    assert.equal(line?.folded, 2);
    assert.equal(line?.kept, 3);
    assert.ok(h.events.some((e) => e.type === "compacted" && e.agent === "seven" && e.folded === 2));

    // The summary survives a restart.
    await h.close();
    open.splice(open.indexOf(h), 1);
    const h2 = start({ seven: [say("again")] }, { workspace: h.workspace, env: SMALL_WINDOW });
    await h2.supervisor.root().turn({ text: "fourth" });
    assert.match(String(h2.model.of("seven")[0]?.messages[0]?.content), /SUMMARY-1$/);
  });

  it("compacts and retries once when the model refuses the request as too long", async () => {
    const overflow: Reply = () => {
      throw new Error("mistral: 400 Bad Request: Prompt contains 140000 tokens, too large for the context length");
    };
    const h = start({ seven: [say("one"), overflow, say("two")], summarizer: [say("SUMMARY")] }, { logLevel: "info" });
    const root = h.supervisor.root();
    await root.turn({ text: "first" });
    assert.equal(await root.turn({ text: "second" }), "two");

    assert.equal(h.model.of("summarizer").length, 1);
    const retry = h.model.of("seven").at(-1)?.messages ?? [];
    assert.match(String(retry[0]?.content), /SUMMARY$/);
    assert.deepEqual(contents(retry.slice(1)), ["second"]);
    assert.ok(h.logs.some((l) => l.msg === "context overflowed"));
    assert.equal(h.logs.find((l) => l.msg === "context compacted")?.reason, "overflow");
  });

  it("merges a second compaction into the first summary", async () => {
    const h = start({ seven: [say("one"), say("two")], summarizer: [say("S1"), say("S2")] });
    const root = h.supervisor.root();
    await root.turn({ text: "first" });
    await root.compact("manual");
    await root.turn({ text: "second" });
    await root.compact("manual");
    assert.match(String(h.model.of("summarizer")[1]?.messages[1]?.content), /^The summary so far:\n\nS1\n/);
    assert.equal(h.state.getAgent("seven")?.summary, "S2");
    assert.equal(h.state.getAgent("seven")?.compactions, 2);
  });

  it("leads with a user message when the cut falls inside a turn", async () => {
    const h = start(
      {
        seven: [call("k1", "no_such_tool", {}), call("k2", "no_such_tool", {}), say("done")],
        summarizer: [say("S")],
      },
      { env: { SEVEN_CONTEXT_TOKENS: "1000" } },
    );
    // A tiny window: every step compacts down to the last assistant message.
    await h.supervisor.root().turn({ text: "go" });
    const last = h.model.of("seven").at(-1)?.messages ?? [];
    assert.equal(last[1]?.role, "user");
    assert.match(String(last[1]?.content), /summarized in the system prompt/);
    assert.equal(last[2]?.role, "assistant");
  });

  it("goes on with the full conversation when compaction fails", async () => {
    const h = start({ seven: [say(big("A")), say(big("B")), say("three")] }, { env: SMALL_WINDOW, logLevel: "info" });
    const root = h.supervisor.root();
    await root.turn({ text: "first" });
    await root.turn({ text: "second" });
    assert.equal(await root.turn({ text: "third" }), "three"); // the summarizer has no script: it throws
    assert.ok(h.logs.some((l) => l.msg === "context compaction failed" && l.level === "error"));
    assert.equal(h.state.history("seven").length, 6);
  });

  it("forgets the summary on reset", async () => {
    const h = start({ seven: [say("one")], summarizer: [say("S")] });
    await h.supervisor.root().turn({ text: "first" });
    await h.supervisor.root().compact("manual");
    h.state.clearHistory("seven");
    assert.equal(h.state.getAgent("seven")?.summary, null);
    assert.deepEqual(h.state.history("seven"), []);
  });
});

describe("schema migration", () => {
  it("upgrades a version 1 database in place", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seven-migrate-"));
    const file = path.join(dir, "seven.db");
    new State(file).close();
    const raw = new DatabaseSync(file);
    for (const col of ["summary", "context_from", "compactions"]) raw.exec(`ALTER TABLE agents DROP COLUMN ${col}`);
    raw.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    raw.close();

    const state = new State(file);
    assert.equal(state.getAgent("seven")?.compactions, 0);
    const v = state.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    assert.equal(Number(v.value), SCHEMA_VERSION);
    state.close();
  });

  it("refuses a database from a newer seven", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seven-migrate-"));
    const file = path.join(dir, "seven.db");
    const s = new State(file);
    s.db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    s.close();
    assert.throws(() => new State(file), /schema version 99/);
  });
});
