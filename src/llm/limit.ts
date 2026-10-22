// A cap on concurrent model calls. Every agent shares one model client, and a
// hosted API rate-limits by concurrency as much as by volume.

import type { ChatModel } from "./mistral.ts";

export function limitConcurrency(model: ChatModel, max: number): ChatModel {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < max) {
        active++;
        resolve();
      } else waiting.push(resolve);
    });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return {
    async complete(req) {
      await acquire();
      try {
        return await model.complete(req);
      } finally {
        release();
      }
    },
  };
}
