"""Job routes (R1)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from ...agent.errors import RefusedError
from ...app import SevenApp
from ..common import err
from ..deps import get_seven
from ..models import JobRequest, StopRequest

router = APIRouter()


@router.get("/api/jobs")
async def list_jobs(seven: Annotated[SevenApp, Depends(get_seven)], all: bool = False):
    return seven.state.list_jobs(all)


@router.post("/api/jobs", status_code=201)
async def start_job(req: JobRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    spec = {"task": req.task, "goal": req.goal, "instructions": req.instructions,
            "interval_s": req.interval_s, "max_turns": req.max_turns}
    try:
        return seven.supervisor.start_job("user", req.kind, spec, agent=req.agent)
    except RefusedError as e:
        raise err(409, str(e))


@router.get("/api/jobs/{jid}")
async def get_job(jid: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    job = seven.state.get_job(jid)
    if not job:
        raise err(404, f'no job "{jid}"')
    return job


@router.post("/api/jobs/{jid}/stop")
async def stop_job(jid: str, seven: Annotated[SevenApp, Depends(get_seven)], req: StopRequest | None = None):
    out = seven.supervisor.stop_job(jid, "user", req.reason if req else None)
    if not out.startswith("stopped"):
        raise err(409, out)
    return {"stopped": jid}


@router.post("/api/jobs/{jid}/pause")
async def pause_job(jid: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    out = seven.supervisor.pause_job(jid)
    if not out.startswith("paused"):
        raise err(409, out)
    return {"paused": jid}


@router.post("/api/jobs/{jid}/resume")
async def resume_job(jid: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    out = seven.supervisor.resume_job(jid)
    if not out.startswith("running"):
        raise err(409, out)
    return {"running": jid}
