// Context compaction. When an agent's next request nears the model's context
// window, the older part of its conversation is folded into a summary that the
// system prompt carries, and only the recent part is still sent message by
// message. Folded messages stay in the state database; they are no longer sent.

import type { ChatModel, Message, ToolDef } from "../llm/mistral.ts";
import type { Logger } from "../log.ts";

/** A request estimated above this share of the context window is compacted first. */
export const COMPACT_AT = 0.75;
/** After compaction, the recent messages kept verbatim fit in this share of the window. */
export const KEEP = 0.25;
/** One summarization request carries at most this share of the window of conversation. */
const CHUNK = 0.5;
/** The summary's own budget, as a share of the window. */
const SUMMARY = 0.08;
/** Longest piece of one message shown to the summarizer, in characters. */
const MAX_MESSAGE_CHARS = 4_000;

/** Prefix of the summarizer's system prompt; also how a scripted model in tests recognises it. */
export const SUMMARIZER_PROMPT = `You summarize an AI agent's conversation so the agent can continue its work without the original messages.

Write to the agent, in the second person. Keep:
- every request and instruction it was given (by the user or another agent), verbatim when short, and who gave it;
- the task in progress, what is done, and the next step;
- decisions and the reasons for them;
- facts it will need again: file and database paths, tool names, run ids, agent ids, commands, errors and how they were fixed;
- what is still open or promised.

Drop small talk, superseded attempts, and tool output that is no longer needed. When given a summary so far, merge it with the new part into one summary. Use short sections and bullet lists.`;

/** Turns request size in characters into tokens, calibrated on the token counts the model reports. */
export class TokenEstimator {
  /** Conservative until a reply reports its prompt tokens. */
  charsPerToken = 3;

  tokens(chars: number): number {
    return Math.ceil(chars / this.charsPerToken);
  }

  chars(tokens: number): number {
    return Math.floor(tokens * this.charsPerToken);
  }

  /** A request of `chars` characters was counted as `promptTokens` tokens. */
  calibrate(chars: number, promptTokens: number | undefined): void {
    if (!promptTokens || promptTokens <= 0 || chars <= 0) return;
    this.charsPerToken = Math.min(6, Math.max(1.5, chars / promptTokens));
  }
}

/** The size of a request as sent, in characters. */
export function requestChars(messages: Message[], tools: ToolDef[]): number {
  return JSON.stringify(messages).length + JSON.stringify(tools).length;
}

/**
 * Where to cut a conversation: the index of the first message kept. The kept
 * part starts at a user or assistant message (never a tool result, whose call
 * would be folded away), preferably at a user message, fits in `keepChars`
 * when it can, and is otherwise the shortest such part. 0 means nothing can be
 * folded.
 */
export function cutIndex(messages: Message[], keepChars: number): number {
  let size = 0;
  let atUser = 0;
  let atAny = 0;
  let last = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    size += JSON.stringify(messages[i]).length;
    const role = messages[i]?.role;
    if (role === "tool") continue;
    if (last === 0) last = i;
    if (size > keepChars) break;
    atAny = i;
    if (role === "user") atUser = i;
  }
  return atUser || atAny || last;
}

/** A model overflow error: the request did not fit the context window. */
export function isOverflow(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /\b(400|413|422)\b/.test(text) && /context|token|too (long|large)|length|exceed/i.test(text);
}

/**
 * Fold `messages` into `previous` (a summary of what came before them, or null).
 * The messages are sent in chunks that fit `chunkChars`; each chunk's summary
 * becomes the previous summary of the next.
 */
export async function summarizeConversation(
  model: ChatModel,
  opts: {
    previous: string | null;
    messages: Message[];
    contextTokens: number;
    estimator: TokenEstimator;
    signal?: AbortSignal;
    log?: Logger;
  },
): Promise<string> {
  const chunkChars = opts.estimator.chars(opts.contextTokens * CHUNK);
  const maxTokens = Math.max(256, Math.floor(opts.contextTokens * SUMMARY));
  let summary = opts.previous;
  for (const chunk of chunks(opts.messages.map(render), chunkChars)) {
    const prompt = `${summary ? `The summary so far:\n\n${summary}\n\n` : ""}The conversation${summary ? " since then" : ""}:\n\n${chunk}\n\nWrite the ${summary ? "merged " : ""}summary, in at most ${Math.floor(maxTokens * 0.6)} words.`;
    const { message } = await model.complete({
      messages: [
        { role: "system", content: SUMMARIZER_PROMPT },
        { role: "user", content: prompt },
      ],
      maxTokens,
      signal: opts.signal,
      log: opts.log,
    });
    const text = message.content?.trim();
    if (!text) throw new Error("the summarizer returned an empty summary");
    summary = text;
  }
  if (summary === null) throw new Error("nothing to summarize");
  return summary;
}

/** One message as the summarizer reads it. */
export function render(m: Message): string {
  switch (m.role) {
    case "system":
    case "user":
      return `[${m.role}]\n${clip(m.content)}`;
    case "assistant": {
      const calls = (m.tool_calls ?? []).map((c) => `→ ${c.function.name}(${clip(c.function.arguments, 1_000)})`);
      return [`[assistant]`, m.content ? clip(m.content) : "", ...calls].filter(Boolean).join("\n");
    }
    case "tool":
      return `[result of ${m.name}]\n${clip(m.content)}`;
  }
}

/** Groups of whole rendered messages, each at most `max` characters (a longer message is a group alone). */
function chunks(parts: string[], max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && cur.length + p.length + 2 > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

/** The start and end of a long text, with the middle cut. */
function clip(s: string, max = MAX_MESSAGE_CHARS): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n… [${s.length - max} characters cut] …\n${s.slice(-half)}`;
}
