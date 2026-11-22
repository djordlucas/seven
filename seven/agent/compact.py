"""Context compaction: fold the older part of a conversation into a summary
carried in the system prompt; folded messages stay in the database."""

from __future__ import annotations

import asyncio
import json
import math
import re

from ..core.llm import ChatModel, Message
from ..core.log import Logger, noop_logger

COMPACT_AT = 0.75
KEEP = 0.25
CHUNK = 0.5
SUMMARY = 0.08
MAX_MESSAGE_CHARS = 4_000

SUMMARIZER_PROMPT = """You summarize an AI agent's conversation so the agent can continue its work without the original messages.

Write to the agent, in the second person. Keep:
- every request and instruction it was given (by the user or another agent), verbatim when short, and who gave it;
- the task in progress, what is done, and the next step;
- decisions and the reasons for them;
- facts it will need again: file and database paths, tool names, run ids, agent ids, commands, errors and how they were fixed;
- what is still open or promised.

Drop small talk, superseded attempts, and tool output that is no longer needed. When given a summary so far, merge it with the new part into one summary. Use short sections and bullet lists."""


class TokenEstimator:
    def __init__(self) -> None:
        self.chars_per_token = 3.0

    def tokens(self, chars: float) -> int:
        return math.ceil(chars / self.chars_per_token)

    def chars(self, tokens: float) -> int:
        return math.floor(tokens * self.chars_per_token)

    def calibrate(self, chars: int, prompt_tokens: int | None) -> None:
        if not prompt_tokens or prompt_tokens <= 0 or chars <= 0:
            return
        self.chars_per_token = min(6.0, max(1.5, chars / prompt_tokens))


def request_chars(messages: list[Message], tools: list) -> int:
    return len(json.dumps(messages, default=str)) + len(json.dumps([t if isinstance(t, dict) else vars(t) for t in tools], default=str))


def cut_index(messages: list[Message], keep_chars: int) -> int:
    size = 0
    at_user = 0
    at_any = 0
    last = 0
    for i in range(len(messages) - 1, 0, -1):
        size += len(json.dumps(messages[i], default=str))
        role = messages[i].get("role")
        if role == "tool":
            continue
        if last == 0:
            last = i
        if size > keep_chars:
            break
        at_any = i
        if role == "user":
            at_user = i
    return at_user or at_any or last


_OVERFLOW = re.compile(r"\b(400|413|422)\b.*(context|token|too (long|large)|length|exceed)", re.IGNORECASE)


def is_overflow(err: BaseException) -> bool:
    text = str(err)
    return bool(_OVERFLOW.search(text)) or bool(re.search(r"(context|token|too (long|large)|length|exceed).*\b(400|413|422)\b", text, re.IGNORECASE))


async def summarize_conversation(model: ChatModel, *, previous: str | None, messages: list[Message],
                                 context_tokens: int, estimator: TokenEstimator,
                                 abort: asyncio.Event | None = None, log: Logger = noop_logger) -> str:
    chunk_chars = estimator.chars(context_tokens * CHUNK)
    max_tokens = max(256, math.floor(context_tokens * SUMMARY))
    summary = previous
    for chunk in _chunks([render(m) for m in messages], chunk_chars):
        prompt = (f"The summary so far:\n\n{summary}\n\n" if summary else "") + \
                 f"The conversation{' since then' if summary else ''}:\n\n{chunk}\n\nWrite the {'merged ' if summary else ''}summary, in at most {math.floor(max_tokens * 0.6)} words."
        out = await model.complete(
            messages=[{"role": "system", "content": SUMMARIZER_PROMPT}, {"role": "user", "content": prompt}],
            max_tokens=max_tokens, abort=abort, log=log,
        )
        text = (out.message.get("content") or "").strip()
        if not text:
            raise RuntimeError("the summarizer returned an empty summary")
        summary = text
    if summary is None:
        raise RuntimeError("nothing to summarize")
    return summary


def render(m: Message) -> str:
    role = m.get("role")
    if role in ("system", "user"):
        return f"[{role}]\n{_clip(m.get('content') or '')}"
    if role == "assistant":
        calls = [f"→ {c['function']['name']}({_clip(c['function']['arguments'], 1000)})" for c in m.get("tool_calls", [])]
        return "\n".join(["[assistant]", _clip(m.get("content") or "")] + calls).strip("\n")
    return f"[result of {m.get('name')}]\n{_clip(m.get('content') or '')}"


def _chunks(parts: list[str], max_chars: int) -> list[str]:
    out: list[str] = []
    cur = ""
    for p in parts:
        if cur and len(cur) + len(p) + 2 > max_chars:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{p}" if cur else p
    if cur:
        out.append(cur)
    return out


def _clip(s: str, max_chars: int = MAX_MESSAGE_CHARS) -> str:
    if len(s) <= max_chars:
        return s
    half = max_chars // 2
    return f"{s[:half]}\n… [{len(s) - max_chars} characters cut] …\n{s[-half:]}"
