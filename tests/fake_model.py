"""A scripted model for tests: a queue of replies, no network."""

from __future__ import annotations

import json

from seven.compact import SUMMARIZER_PROMPT
from seven.llm import Completion
from seven.log import noop_logger


def tc(name: str, args: dict | None = None, call_id: str | None = None) -> dict:
    return {"id": call_id or f"call_{name}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(args or {})}}


def reply(content: str | None = None, tool_calls: list | None = None, prompt_tokens: int = 100) -> Completion:
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return Completion(message=msg, usage={"prompt_tokens": prompt_tokens, "completion_tokens": 10, "total_tokens": prompt_tokens + 10},
                      finish_reason="tool_calls" if tool_calls else "stop")


class ScriptedModel:
    def __init__(self, replies: list | None = None, summary: str = "summary of earlier messages"):
        self.replies = list(replies or [])
        self.summary = summary
        self.requests: list[dict] = []

    def push(self, r) -> None:
        self.replies.append(r)

    async def complete(self, *, messages, tools=None, max_tokens=None, abort=None, log=noop_logger) -> Completion:
        self.requests.append({"messages": messages, "tools": tools, "max_tokens": max_tokens})
        if abort is not None and abort.is_set():
            raise asyncio.CancelledError("aborted")
        first = messages[0] if messages else {}
        if first.get("role") == "system" and str(first.get("content", "")).startswith(SUMMARIZER_PROMPT[:60]):
            return reply(self.summary)
        if not self.replies:
            raise RuntimeError("scripted model ran out of replies")
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        if callable(r):
            out = r(messages=messages, tools=tools)
            if hasattr(out, "__await__"):
                out = await out
            return out
        if isinstance(r, str):
            return reply(r)
        if isinstance(r, Completion):
            return r
        raise TypeError(f"bad scripted reply: {r!r}")


import asyncio
