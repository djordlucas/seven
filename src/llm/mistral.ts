// A client for Mistral's chat completions API, trimmed to what the agent loop
// uses: messages, function tools, one non-streamed reply.

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

export interface ChatModel {
  complete(req: {
    messages: Message[];
    tools?: ToolDef[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<Completion>;
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
  }: {
    messages: Message[];
    tools?: ToolDef[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<Completion> {
    const body = JSON.stringify({
      model: this.opts.model,
      messages,
      ...(tools.length > 0 && {
        tools: tools.map((t) => ({ type: "function", function: t })),
        tool_choice: "auto",
      }),
      ...(maxTokens && { max_tokens: maxTokens }),
    });

    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${this.opts.endpoint}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body,
        signal,
      });

      if (res.ok) return parseCompletion((await res.json()) as RawCompletion);

      const retryable = res.status === 429 || res.status >= 500;
      const text = await res.text();
      if (!retryable || attempt >= this.opts.maxAttempts) {
        throw new Error(`mistral: ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
      }
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1), signal);
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}
