"""The model client: one non-streamed Mistral chat completion per call, with
function tools, retries on 429/5xx, and a shared concurrency cap."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from .config import DEFAULT_ENDPOINT
from .log import Logger, noop_logger, preview

Message = dict[str, Any]


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class Completion:
    message: Message
    usage: dict | None = None
    finish_reason: str | None = None


@dataclass
class ToolDef:
    name: str
    description: str
    parameters: dict


class ChatModel(Protocol):
    async def complete(self, *, messages: list[Message], tools: list[ToolDef] | None = None,
                       max_tokens: int | None = None, abort: asyncio.Event | None = None,
                       log: Logger = noop_logger) -> Completion: ...

    async def close(self) -> None: ...


@dataclass
class Mistral:
    api_key: str
    model: str
    endpoint: str = DEFAULT_ENDPOINT
    max_attempts: int = 5
    concurrency: int = 4
    client: httpx.AsyncClient | None = field(default=None, repr=False)
    _sem: asyncio.Semaphore = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._sem = asyncio.Semaphore(self.concurrency)

    def _http(self) -> httpx.AsyncClient:
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))
        return self.client

    async def close(self) -> None:
        if self.client is not None:
            await self.client.aclose()
            self.client = None

    async def complete(self, *, messages: list[Message], tools: list[ToolDef] | None = None,
                       max_tokens: int | None = None, abort: asyncio.Event | None = None,
                       log: Logger = noop_logger) -> Completion:
        async with self._sem:
            return await self._complete_locked(messages=messages, tools=tools, max_tokens=max_tokens, abort=abort, log=log)

    async def _complete_locked(self, *, messages: list[Message], tools: list[ToolDef] | None,
                               max_tokens: int | None, abort: asyncio.Event | None, log: Logger) -> Completion:
        if not self.api_key:
            raise RuntimeError("mistral: no API key; set SEVEN_LLM_API_KEY (or MISTRAL_API_KEY)")
        body = json.dumps({
            "model": self.model,
            "messages": messages,
            **({"tools": [{"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}} for t in tools],
                 "tool_choice": "auto"} if tools else {}),
            **({"max_tokens": max_tokens} if max_tokens else {}),
        })
        log.debug("model request", model=self.model, messages=len(messages), tools=len(tools or []), request_bytes=len(body),
                  last_message=preview(messages[-1].get("content") if messages else None))
        for attempt in range(1, self.max_attempts + 1):
            started = asyncio.get_running_loop().time()
            try:
                res = await self._http().post(
                    f"{self.endpoint}/chat/completions",
                    headers={"content-type": "application/json", "authorization": f"Bearer {self.api_key}"},
                    content=body,
                )
            except httpx.HTTPError as err:
                if abort is not None and abort.is_set():
                    log.debug("model call aborted", attempt=attempt)
                else:
                    log.error("model call failed", attempt=attempt, error=err)
                raise
            ms = round((asyncio.get_running_loop().time() - started) * 1000)
            if res.status_code == 200:
                out = parse_completion(res.json())
                log.info("model replied", model=self.model, duration_ms=ms, attempt=attempt,
                         finish_reason=out.finish_reason,
                         tool_calls=[c["function"]["name"] for c in out.message.get("tool_calls", [])],
                         prompt_tokens=(out.usage or {}).get("prompt_tokens"),
                         completion_tokens=(out.usage or {}).get("completion_tokens"))
                if log.enabled("debug") and out.message.get("content"):
                    log.debug("model reply content", content=preview(out.message["content"]))
                return out
            retryable = res.status_code == 429 or res.status_code >= 500
            text = res.text
            if not retryable or attempt >= self.max_attempts:
                log.error("model call failed", status=res.status_code, attempt=attempt, duration_ms=ms, body=preview(text))
                raise RuntimeError(f"mistral: {res.status_code} {res.reason_phrase}: {text[:500]}")
            after = res.headers.get("retry-after")
            try:
                delay = float(after) if after else 0.0
            except ValueError:
                delay = 0.0
            delay_ms = int(delay * 1000) if delay > 0 else 1000 * 2 ** (attempt - 1)
            log.warning("model call retried", status=res.status_code, attempt=attempt, delay_ms=delay_ms, duration_ms=ms)
            await self._sleep(delay_ms / 1000, abort)
        raise RuntimeError("mistral: unreachable")

    @staticmethod
    async def _sleep(seconds: float, abort: asyncio.Event | None) -> None:
        if abort is None:
            await asyncio.sleep(seconds)
            return
        try:
            await asyncio.wait_for(abort.wait(), timeout=seconds)
        except TimeoutError:
            return
        raise asyncio.CancelledError("aborted")


def parse_completion(raw: dict) -> Completion:
    choice = (raw.get("choices") or [{}])[0]
    message = choice.get("message")
    if not message:
        raise RuntimeError(f"mistral: reply has no message: {json.dumps(raw)[:500]}")
    content = message.get("content")
    if isinstance(content, list):
        content = "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text") or None
    calls = [
        ToolCall(id=c["id"], name=c["function"]["name"],
                 arguments=c["function"]["arguments"] if isinstance(c["function"]["arguments"], str) else json.dumps(c["function"]["arguments"]))
        for c in (message.get("tool_calls") or [])
    ]
    tool_calls = [
        {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
        for c in calls
    ]
    msg: Message = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return Completion(message=msg, usage=raw.get("usage"), finish_reason=choice.get("finish_reason"))
