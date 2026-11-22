"""Agents working with agents: spawning, finding, messaging, stopping."""

from __future__ import annotations

from .shared import Builtin, BuiltinContext, positive

MAX_WAIT_MS = 600_000


def agent_builtins() -> list:
    return [
        Builtin(
            name="spawn_agent",
            description="Start another agent to work in parallel with you. It has the same built-ins and tools as you, its own "
                        "conversation, and runs at the same time as every other agent. Modes: request (one task, then done), "
                        "sequence (its tasks in order, then done) — for both, its final answer is sent to you as a message — and "
                        "continuous (keeps running, handling every message it receives, and waking every interval_s if set, until "
                        "stopped). Returns its id at once.",
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short and unique among active agents, e.g. researcher."},
                    "description": {"type": "string", "description": "What it is for; what other agents see in list_agents."},
                    "instructions": {"type": "string", "description": "Standing instructions: its role, how to work, what to return."},
                    "mode": {"type": "string", "enum": ["request", "sequence", "continuous"]},
                    "tasks": {"type": "array", "items": {"type": "string"}, "description": "request: exactly one; sequence: one or more, in order; continuous: optional first tasks."},
                    "interval_s": {"type": "integer", "description": "continuous only: wake up this often when idle."},
                    "max_steps": {"type": "integer", "description": "Model calls per task. Defaults to seven's setting."},
                },
                "required": ["name", "description", "instructions", "mode"],
            },
            run=_spawn_agent,
        ),
        Builtin(
            name="list_agents",
            description="List agents: id, name, mode, status, who spawned it, and what it is for.",
            parameters={"type": "object", "properties": {"all": {"type": "boolean", "description": "Include finished, failed and stopped agents. Default false."}}},
            run=_list_agents,
        ),
        Builtin(
            name="find_agents",
            description="Find agents whose name, description or instructions contain every word of the query, active ones first.",
            parameters={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            run=_find_agents,
        ),
        Builtin(
            name="agent_status",
            description="Show one agent in detail: status, mode, instructions, pending inbox, its last answer, and its result or error.",
            parameters={"type": "object", "properties": {"agent": {"type": "string", "description": "An id or a name."}}, "required": ["agent"]},
            run=_agent_status,
        ),
        Builtin(
            name="send_message",
            description="Send a message to another agent. A busy agent sees it at its next step; an idle continuous agent wakes up "
                        "to handle it. Its reply, if any, arrives as a message to you: see wait_message.",
            parameters={"type": "object", "properties": {"to": {"type": "string", "description": "An id or a name."}, "text": {"type": "string"}}, "required": ["to", "text"]},
            run=_send_message,
        ),
        Builtin(
            name="wait_message",
            description="Wait for the next message sent to you — from one agent if `from` is given — up to timeout_ms, and return it. "
                        "Messages you do not wait for still reach you, at the start of your next step.",
            parameters={"type": "object", "properties": {"from": {"type": "string", "description": "An id or a name. Default: anyone."}, "timeout_ms": {"type": "integer", "description": f"Default 60000, at most {MAX_WAIT_MS}."}}},
            run=_wait_message,
        ),
        Builtin(
            name="stop_agent",
            description="Stop an agent and kill its background runs. Its parent is told. The root agent cannot be stopped.",
            parameters={"type": "object", "properties": {"agent": {"type": "string", "description": "An id or a name."}, "reason": {"type": "string"}}, "required": ["agent"]},
            run=_stop_agent,
        ),
    ]


async def _spawn_agent(a: dict, ctx: BuiltinContext) -> str:
    r = ctx.supervisor.spawn(ctx.agent_id, {
        "name": str(a.get("name", "")),
        "description": str(a.get("description", "")),
        "instructions": str(a.get("instructions", "")),
        "mode": str(a.get("mode", "")),
        "tasks": [str(t) for t in a["tasks"]] if isinstance(a.get("tasks"), list) else [],
        "interval_s": positive(a.get("interval_s"), 0) or None,
        "max_steps": positive(a.get("max_steps"), 0) or None,
    })
    if isinstance(r, str):
        return f"error: {r}"
    reply = "" if r["mode"] == "continuous" else "; its final answer will be sent to you as a message"
    return f'spawned {r["id"]} "{r["name"]}" ({r["mode"]}){reply}'


async def _list_agents(a: dict, ctx: BuiltinContext) -> str:
    rows = ctx.supervisor.list(a.get("all") is True)
    return "\n".join(_line(r) for r in rows) if rows else "no agents"


async def _find_agents(a: dict, ctx: BuiltinContext) -> str:
    rows = ctx.supervisor.find(str(a.get("query", "")))
    return "\n".join(_line(r) for r in rows) if rows else f'no agent matches "{a.get("query")}"'


async def _agent_status(a: dict, ctx: BuiltinContext) -> str:
    r = ctx.supervisor.resolve(str(a.get("agent", "")))
    return f"error: {r}" if isinstance(r, str) else ctx.supervisor.status(r)


async def _send_message(a: dict, ctx: BuiltinContext) -> str:
    r = ctx.supervisor.send(ctx.agent_id, str(a.get("to", "")), str(a.get("text", "")))
    return r if r.startswith("sent") else f"error: {r}"


async def _wait_message(a: dict, ctx: BuiltinContext) -> str:
    frm = None
    if a.get("from") is not None:
        r = ctx.supervisor.resolve(str(a["from"]))
        if isinstance(r, str):
            return f"error: {r}"
        frm = r["id"]
    timeout_ms = min(positive(a.get("timeout_ms"), 60_000), MAX_WAIT_MS)
    import time
    started = time.time()
    msg = await ctx.supervisor.wait_message(ctx.agent_id, frm, timeout_ms, ctx.abort)
    ctx.log.info("waited for a message", frm=frm or "anyone", got=msg["sender"] if msg else None,
                 waited_ms=round((time.time() - started) * 1000))
    return ctx.supervisor.format_inbox(msg) if msg else f"no message within {timeout_ms}ms"


async def _stop_agent(a: dict, ctx: BuiltinContext) -> str:
    r = ctx.supervisor.resolve(str(a.get("agent", "")))
    if isinstance(r, str):
        return f"error: {r}"
    out = ctx.supervisor.stop(r["id"], ctx.agent_id, None if a.get("reason") is None else str(a["reason"]))
    return out if out.startswith("stopped") else f"error: {out}"


def _line(r: dict) -> str:
    parent = f" · from {r['parent']}" if r.get("parent") else ""
    return f'{r["id"]} "{r["name"]}" · {r["mode"]} · {r["status"]}{parent} · {r["description"]}'
