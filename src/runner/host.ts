// Host functions: what a run can ask the seven process to do over the IPC
// channel, as `seven.<module>.<fn>(...args)` in the child. A run already has
// all of Node, so this is only for what lives in the parent — the model client,
// and whatever an embedding program adds through the `host` option.

import type { ChatModel } from "../llm/mistral.ts";

/** A host function. Arguments and result cross the IPC channel as JSON. */
export type HostFn = (...args: never[]) => unknown;

/** Host functions grouped by module: `{ llm: { chat } }` is `seven.llm.chat`. */
export type HostModules = Record<string, Record<string, HostFn>>;

/** `seven.llm`: one tool-less call to the model the agent runs on. */
export function llmModule(model: ChatModel): HostModules[string] {
  return {
    chat: async (prompt: string, system?: string) => {
      const { message } = await model.complete({
        messages: [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          { role: "user", content: prompt },
        ],
      });
      return message.content ?? "";
    },
  };
}
