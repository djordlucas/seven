import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Mistral } from "../src/llm/mistral.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(...responses: Response[]): RequestInit[] {
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(init ?? {});
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return r;
  };
  return requests;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("mistral", () => {
  const client = new Mistral({ apiKey: "k", model: "m" });

  it("sends tools as functions and parses tool calls", async () => {
    const requests = stub(
      json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: { content: "", tool_calls: [{ id: "abc123XYZ", function: { name: "f", arguments: { x: 1 } } }] },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    const out = await client.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "f", description: "d", parameters: { type: "object" } }],
    });

    const body = JSON.parse(String(requests[0]?.body));
    assert.deepEqual(body.tools, [
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
    ]);
    assert.equal(body.tool_choice, "auto");
    assert.deepEqual(out.message.tool_calls, [
      { id: "abc123XYZ", type: "function", function: { name: "f", arguments: '{"x":1}' } },
    ]);
    assert.equal(out.usage?.total_tokens, 3);
  });

  it("keeps text chunks and drops thinking chunks", async () => {
    stub(
      json({
        choices: [
          {
            message: {
              content: [
                { type: "thinking", thinking: [] },
                { type: "text", text: "answer" },
              ],
            },
          },
        ],
      }),
    );
    const out = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.message.content, "answer");
  });

  it("retries a 429, honouring retry-after", async () => {
    const requests = stub(
      json({ message: "slow down" }, 429, { "retry-after": "0.01" }),
      json({ choices: [{ message: { content: "ok" } }] }),
    );
    const out = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.message.content, "ok");
    assert.equal(requests.length, 2);
  });

  it("fails fast on a 400", async () => {
    stub(json({ message: "bad request" }, 400));
    await assert.rejects(client.complete({ messages: [{ role: "user", content: "hi" }] }), /mistral: 400/);
  });
});
