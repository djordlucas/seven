"""The Mistral client: reply parsing and the completion path, including tool calls."""

from __future__ import annotations

import httpx

from seven.core.llm import Mistral, parse_completion

TOOL_CALL_REPLY = {
    "choices": [
        {
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "list_files", "arguments": '{"path": "."}'}}
                ],
            },
            "finish_reason": "tool_calls",
        }
    ],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
}


def test_parse_completion_tool_calls_are_dicts():
    out = parse_completion(TOOL_CALL_REPLY)
    call = out.message["tool_calls"][0]
    assert call["function"]["name"] == "list_files"
    assert call["function"]["arguments"] == '{"path": "."}'
    assert call["id"] == "call_1"


def test_parse_completion_object_arguments_are_serialized():
    raw = {
        "choices": [
            {"message": {"role": "assistant", "content": None,
                         "tool_calls": [{"id": "c", "type": "function",
                                         "function": {"name": "f", "arguments": {"a": 1}}}]},
             "finish_reason": "tool_calls"}
        ]
    }
    out = parse_completion(raw)
    assert out.message["tool_calls"][0]["function"]["arguments"] == '{"a": 1}'


async def test_complete_with_tool_call_does_not_crash():
    """Regression: the reply's log line read c.name off dict tool_calls."""
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=TOOL_CALL_REPLY)))
    model = Mistral(api_key="test-key", model="test-model", endpoint="http://test", client=client)
    out = await model.complete(messages=[{"role": "user", "content": "list files"}])
    assert out.message["tool_calls"][0]["function"]["name"] == "list_files"
    assert out.finish_reason == "tool_calls"
    await model.close()
