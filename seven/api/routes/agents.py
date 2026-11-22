"""Agent routes: list, spawn, conversation, messages, inbox/outbox, stop, compact."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ...agent.errors import RefusedError
from ...app import SevenApp
from ...core.state import ROOT_ID
from ..common import agent_view, err
from ..deps import get_seven
from ..models import MessageRequest, SpawnRequest, StopRequest

router = APIRouter()


@router.get("/api/agents")
async def list_agents(seven: Annotated[SevenApp, Depends(get_seven)], all: bool = False):
    return [agent_view(seven, r) for r in seven.supervisor.list(all)]


@router.post("/api/agents", status_code=201)
async def spawn_agent(req: SpawnRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    spec = {"name": req.name, "description": req.description, "instructions": req.instructions,
            "mode": req.mode, "tasks": req.tasks, "interval_s": req.interval_s, "max_steps": req.max_steps}
    try:
        row = seven.supervisor.spawn(ROOT_ID, spec)
    except RefusedError as e:
        raise err(409, str(e))
    return agent_view(seven, row)


@router.get("/api/agents/{agent_id}")
async def get_agent(agent_id: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    row = seven.state.get_agent(agent_id)
    if row is None:
        try:
            row = seven.supervisor.resolve(agent_id)
        except RefusedError as e:
            raise err(404, str(e))
    return agent_view(seven, row)


@router.get("/api/agents/{agent_id}/messages")
async def get_messages(agent_id: str, seven: Annotated[SevenApp, Depends(get_seven)], limit: int = Query(200, ge=1, le=2000), offset: int = Query(0, ge=0)):
    if not seven.state.get_agent(agent_id):
        raise err(404, f'no agent "{agent_id}"')
    return {"total": seven.state.transcript_count(agent_id), "messages": seven.state.transcript(agent_id, limit, offset)}


@router.post("/api/agents/{agent_id}/messages", status_code=202)
async def send_message(agent_id: str, req: MessageRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    try:
        return seven.supervisor.user_message(agent_id, req.text)
    except RefusedError as e:
        raise err(409, str(e))


@router.get("/api/agents/{agent_id}/inbox")
async def get_inbox(agent_id: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    if not seven.state.get_agent(agent_id):
        raise err(404, f'no agent "{agent_id}"')
    return seven.state.pending(agent_id)


@router.get("/api/agents/{agent_id}/outbox")
async def get_outbox(agent_id: str, seven: Annotated[SevenApp, Depends(get_seven)], limit: int = Query(100, ge=1, le=1000)):
    if not seven.state.get_agent(agent_id):
        raise err(404, f'no agent "{agent_id}"')
    return seven.state.list_outbox(agent_id, limit)


@router.post("/api/agents/{agent_id}/stop")
async def stop_agent(agent_id: str, seven: Annotated[SevenApp, Depends(get_seven)], req: StopRequest | None = None):
    out = seven.supervisor.stop(agent_id, "user", req.reason if req else None)
    if not out.startswith("stopped"):
        raise err(409, out)
    return {"stopped": agent_id}


@router.post("/api/agents/{agent_id}/compact")
async def compact_agent(agent_id: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    a = seven.supervisor.agent(agent_id)
    if not a:
        raise err(404, f'no agent "{agent_id}"')
    out = await a.compact("manual", seven.log.child(agent=agent_id))
    if out is None:
        raise err(409, "nothing to fold")
    return out


@router.delete("/api/agents/{agent_id}/conversation")
async def reset_conversation(agent_id: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    if not seven.state.get_agent(agent_id):
        raise err(404, f'no agent "{agent_id}"')
    seven.state.clear_conversation(agent_id)
    return {"cleared": agent_id}
