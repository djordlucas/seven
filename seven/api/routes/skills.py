"""Skill routes (R4)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ...app import SevenApp
from ...tools import SKILL_NAME
from ..common import err
from ..deps import get_seven
from ..models import SkillRequest

router = APIRouter()


@router.get("/api/skills")
async def list_skills(seven: Annotated[SevenApp, Depends(get_seven)]):
    return seven.state.list_skills()


@router.post("/api/skills", status_code=201)
async def define_skill(req: SkillRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    if not SKILL_NAME.match(req.name):
        raise err(400, f"name must match {SKILL_NAME.pattern}")
    missing = [t for t in req.tools if not seven.store.get(t)]
    if missing:
        raise err(400, f"no such tool(s): {', '.join(missing)}")
    return seven.state.save_skill(name=req.name, description=req.description,
                                  instructions=req.instructions, tools=req.tools)


@router.get("/api/skills/{name}")
async def get_skill(name: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    s = seven.state.get_skill(name)
    if not s:
        raise err(404, f'no skill named "{name}"')
    return s


@router.delete("/api/skills/{name}")
async def delete_skill(name: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    if not seven.state.delete_skill(name):
        raise err(404, f'no skill named "{name}"')
    seven.supervisor.emit({"type": "skill_deleted", "skill": name})
    return {"deleted": name}


@router.post("/api/skills/{name}/load")
async def load_skill(name: str, seven: Annotated[SevenApp, Depends(get_seven)], agent: str = Query(..., description="agent id to load the skill for")):
    if not seven.state.get_skill(name):
        raise err(404, f'no skill named "{name}"')
    if not seven.state.get_agent(agent):
        raise err(404, f'no agent "{agent}"')
    row = seven.state.get_agent(agent)
    if name not in row["loaded_skills"]:
        seven.state.set_loaded_skills(agent, [*row["loaded_skills"], name])
    seven.supervisor.emit({"type": "skill_loaded", "skill": name, "agent": agent})
    return {"loaded": name, "agent": agent}


@router.post("/api/skills/{name}/unload")
async def unload_skill(name: str, seven: Annotated[SevenApp, Depends(get_seven)], agent: str = Query(...)):
    if not seven.state.get_agent(agent):
        raise err(404, f'no agent "{agent}"')
    row = seven.state.get_agent(agent)
    seven.state.set_loaded_skills(agent, [s for s in row["loaded_skills"] if s != name])
    seven.supervisor.emit({"type": "skill_unloaded", "skill": name, "agent": agent})
    return {"unloaded": name, "agent": agent}
