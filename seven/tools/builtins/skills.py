"""Skills (R4): named bundles of generated tools plus description and
instructions, with full CRUD for agents. A tool used by a skill cannot be
deleted until the skill changes (enforced in the tool store)."""

from __future__ import annotations

import json

from ..store import SKILL_NAME
from .shared import Builtin, BuiltinContext


def skill_builtins() -> list:
    return [
        Builtin(
            name="define_skill",
            description="Create or replace a skill: a name, a description, standing instructions, and the generated tools "
                        "it bundles (all must exist). Loading it (load_skill) makes its tools callable and adds its "
                        "instructions to your system prompt.",
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": f"snake_case, matching {SKILL_NAME.pattern}."},
                    "description": {"type": "string", "description": "What the skill is for; shown by list_skills."},
                    "instructions": {"type": "string", "description": "Standing instructions added to the system prompt while loaded."},
                    "tools": {"type": "array", "items": {"type": "string"}, "description": "Generated tool names the skill bundles."},
                },
                "required": ["name", "description", "tools"],
            },
            run=_define_skill,
        ),
        Builtin(
            name="read_skill",
            description="Show one skill: description, instructions, tools, and whether you have it loaded.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            run=_read_skill,
        ),
        Builtin(
            name="list_skills",
            description="List all skills with their tools, marking the ones you have loaded.",
            parameters={"type": "object", "properties": {}},
            run=_list_skills,
        ),
        Builtin(
            name="delete_skill",
            description="Delete a skill for everyone; loaded copies are unloaded.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            run=_delete_skill,
        ),
        Builtin(
            name="load_skill",
            description="Load a skill for yourself: its tools become callable from your next step and its instructions join your system prompt. Persisted across restarts.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            run=_load_skill,
        ),
        Builtin(
            name="unload_skill",
            description="Unload a skill: its tools leave your tool list and its instructions leave your system prompt.",
            parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
            run=_unload_skill,
        ),
    ]


async def _define_skill(a: dict, ctx: BuiltinContext) -> str:
    state = ctx.state
    name = str(a.get("name", ""))
    if not SKILL_NAME.match(name):
        return f"error: name must match {SKILL_NAME.pattern}"
    tools = [str(t) for t in a.get("tools", [])] if isinstance(a.get("tools"), list) else []
    missing = [t for t in tools if not ctx.store.get(t)]
    if missing:
        return f'error: no such tool(s): {", ".join(missing)}'
    state.save_skill(name=name, description=str(a.get("description", "")),
                     instructions=str(a.get("instructions", "")), tools=tools)
    ctx.log.info("skill defined", skill=name, tools=tools)
    ctx.supervisor.emit({"type": "skill_defined", "skill": name, "tools": tools})
    return f"saved skill {name} (tools: {', '.join(tools) or 'none'})"


async def _read_skill(a: dict, ctx: BuiltinContext) -> str:
    state = ctx.state
    s = state.get_skill(str(a.get("name", "")))
    if not s:
        return f'error: no skill named "{a.get("name")}"'
    loaded = s["name"] in state.get_agent(ctx.agent_id)["loaded_skills"]
    return json.dumps({**s, "loaded_by_you": loaded}, indent=2)


async def _list_skills(a: dict, ctx: BuiltinContext) -> str:
    state = ctx.state
    skills = state.list_skills()
    if not skills:
        return "no skills yet — define_skill to create one"
    loaded = set(state.get_agent(ctx.agent_id)["loaded_skills"])
    return "\n".join(f'- {s["name"]}{" (loaded)" if s["name"] in loaded else ""}: {s["description"]} [tools: {", ".join(s["tools"]) or "none"}]' for s in skills)


async def _delete_skill(a: dict, ctx: BuiltinContext) -> str:
    name = str(a.get("name", ""))
    if not ctx.state.delete_skill(name):
        return f'error: no skill named "{name}"'
    ctx.log.info("skill deleted", skill=name)
    ctx.supervisor.emit({"type": "skill_deleted", "skill": name})
    return f"deleted skill {name}"


async def _load_skill(a: dict, ctx: BuiltinContext) -> str:
    state = ctx.state
    name = str(a.get("name", ""))
    if not state.get_skill(name):
        return f'error: no skill named "{name}"'
    row = state.get_agent(ctx.agent_id)
    if name in row["loaded_skills"]:
        return f"{name} is already loaded"
    state.set_loaded_skills(ctx.agent_id, [*row["loaded_skills"], name])
    ctx.supervisor.emit({"type": "skill_loaded", "skill": name, "agent": ctx.agent_id})
    return f"loaded {name}; its tools are callable from your next step"


async def _unload_skill(a: dict, ctx: BuiltinContext) -> str:
    state = ctx.state
    name = str(a.get("name", ""))
    row = state.get_agent(ctx.agent_id)
    if name not in row["loaded_skills"]:
        return f"{name} is not loaded"
    state.set_loaded_skills(ctx.agent_id, [s for s in row["loaded_skills"] if s != name])
    ctx.supervisor.emit({"type": "skill_unloaded", "skill": name, "agent": ctx.agent_id})
    return f"unloaded {name}"
