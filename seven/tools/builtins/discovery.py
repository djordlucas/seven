"""Tool discovery (R3b): the tool list sent every step is small on purpose —
list_tools shows what exists, describe_tool reveals one (persisted per agent,
so it stays callable)."""

from __future__ import annotations

import json

from .shared import Builtin, BuiltinContext

META_TOOLS = ("list_tools", "describe_tool", "list_skills", "load_skill", "unload_skill")


def _builtins():
    from . import builtins
    return builtins()


def discovery_builtins() -> list:
    return [
        Builtin(
            name="list_tools",
            description="List available tools: built-ins and generated tools, with descriptions. Not in your tool list "
                        "yet are marked; call describe_tool to make one callable. Tools in your loaded skills are marked.",
            parameters={"type": "object", "properties": {"query": {"type": "string", "description": "Only tools whose name or description contains every word."}}},
            run=_list_tools,
        ),
        Builtin(
            name="describe_tool",
            description="Show one tool's full argument schema and add it to your tool list from your next step on "
                        "(remembered across restarts).",
            parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            run=_describe_tool,
        ),
    ]


def _all_tools(ctx: BuiltinContext) -> list[dict]:
    out = []
    for b in _builtins().values():
        out.append({"name": b.name, "kind": "builtin", "description": b.description, "parameters": b.parameters})
    for t in ctx.store.list():
        out.append({"name": t["name"], "kind": "generated", "description": t["description"], "parameters": t["parameters"],
                    "disabled": bool(t.get("disabled")), "revision": t["revision"]})
    return out


async def _list_tools(a: dict, ctx: BuiltinContext) -> str:
    state = ctx.supervisor.opts.state
    row = state.get_agent(ctx.agent_id)
    revealed = set(row["revealed_tools"])
    loaded_tools: set[str] = set()
    for s in row["loaded_skills"]:
        sk = state.get_skill(s)
        if sk:
            loaded_tools.update(sk["tools"])
    query = str(a.get("query", "")).lower().split() if a.get("query") else []
    tools = _all_tools(ctx)
    if query:
        tools = [t for t in tools if all(w in (t["name"] + " " + t["description"]).lower() for w in query)]
    if not tools:
        return "no tools match"
    lines = []
    for t in tools:
        marks = []
        if t["name"] in revealed or t["name"] in loaded_tools:
            marks.append("in your tool list")
        if t.get("disabled"):
            marks.append(f'disabled: {t["disabled"]["reason"]}')
        lines.append(f'- {t["name"]} ({t["kind"]}){" — " + ", ".join(marks) if marks else ""}: {t["description"][:160]}')
    return "\n".join(lines)


async def _describe_tool(a: dict, ctx: BuiltinContext) -> str:
    state = ctx.supervisor.opts.state
    name = str(a.get("name", ""))
    bl = _builtins().get(name)
    own = None if bl else ctx.store.get(name)
    if not bl and not own:
        return f'error: no tool named "{name}"'
    if own and own["meta"].get("disabled"):
        return f'error: tool "{name}" is disabled ({own["meta"]["disabled"]["reason"]})'
    state.add_revealed_tool(ctx.agent_id, name)
    schema = bl.parameters if bl else own["meta"]["parameters"]
    return f"{name} is now in your tool list from your next step.\n{json.dumps(schema, indent=2)}"
