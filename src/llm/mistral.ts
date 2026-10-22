// A client for Mistral's chat completions API, trimmed to what the agent loop
// uses: messages, function tools, one non-streamed reply.

import { type Logger, noopLogger, preview } from "../log.ts";

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface Completion {
  message: Extract<Message, { role: "assistant" }>;
  usage?: Usage;
  finishReason?: string;
}

export interface CompletionRequest {
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** The caller's logger (its agent, turn and step), for this call's lines. */
  log?: Logger;
}

export interface ChatModel {
  complete(req: CompletionRequest): Promise<Completion>;
}

export interface MistralOptions {
  apiKey: string;
  model: string;
  endpoint?: string;
  /** Attempts for a 429 or 5xx before giving up. */
  maxAttempts?: number;
}

export const DEFAULT_ENDPOINT = "https://api.mistral.ai/v1";

export class Mistral implements ChatModel {
  private readonly opts: Required<MistralOptions>;

  constructor(opts: MistralOptions) {
    this.opts = { endpoint: DEFAULT_ENDPOINT, maxAttempts: 5, ...opts };
  }

  async complete({
    messages,
    tools = [],
    maxTokens,
    signal,
    log = noopLogger,
  }: CompletionRequest): Promise<Completion> {
    const body = JSON.stringify({
      model: this.opts.model,
      messages,
      ...(tools.length > 0 && {
        tools: tools.map((t) => ({ type: "function", function: t })),
        tool_choice: "auto",
      }),
      ...(maxTokens && { max_tokens: maxTokens }),
    });

    log.debug("model request", {
      model: this.opts.model,
      messages: messages.length,
      tools: tools.length,
      request_bytes: body.length,
      last_message: preview(lastContent(messages)),
    });

    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      let res: Response;
      try {
        res = await fetch(`${this.opts.endpoint}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
          body,
          signal,
        });
      } catch (err) {
        if (signal?.aborted) log.debug("model call aborted", { attempt });
        else log.error("model call failed", { attempt, error: err });
        throw err;
      }
      const ms = Math.round(performance.now() - started);

      if (res.ok) {
        const out = parseCompletion((await res.json()) as RawCompletion);
        log.info("model replied", {
          model: this.opts.model,
          duration_ms: ms,
          attempt,
          finish_reason: out.finishReason,
          tool_calls: out.message.tool_calls?.map((c) => c.function.name),
          prompt_tokens: out.usage?.prompt_tokens,
          completion_tokens: out.usage?.completion_tokens,
        });
        if (log.enabled("debug") && out.message.content) {
          log.debug("model reply content", { content: preview(out.message.content) });
        }
        return out;
      }

      const retryable = res.status === 429 || res.status >= 500;
      const text = await res.text();
      if (!retryable || attempt >= this.opts.maxAttempts) {
        log.error("model call failed", { status: res.status, attempt, duration_ms: ms, body: preview(text) });
        throw new Error(`mistral: ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
      }
      const after = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1);
      log.warn("model call retried", { status: res.status, attempt, delay_ms: delay, duration_ms: ms });
      await sleep(delay, signal);
    }
  }
}

interface RawCompletion {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | { type: string; text?: string }[] | null;
      tool_calls?: { id: string; function: { name: string; arguments: string | object } }[];
    };
  }[];
  usage?: Usage;
}

function parseCompletion(raw: RawCompletion): Completion {
  const choice = raw.choices?.[0];
  if (!choice?.message) throw new Error(`mistral: reply has no message: ${JSON.stringify(raw).slice(0, 500)}`);
  const { content, tool_calls } = choice.message;

  // Content is a string, or a list of chunks when the model emits thinking
  // traces; only text chunks are the answer.
  const text = Array.isArray(content)
    ? content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("")
    : (content ?? null);

  const calls = tool_calls?.map(
    (c): ToolCall => ({
      id: c.id,
      type: "function",
      function: {
        name: c.function.name,
        arguments:
          typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments),
      },
    }),
  );

  return {
    message: { role: "assistant", content: text, ...(calls?.length && { tool_calls: calls }) },
    usage: raw.usage,
    finishReason: choice.finish_reason,
  };
}

function lastContent(messages: Message[]): string | null {
  const last = messages.at(-1);
  return last ? last.content : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}
