"""Background-run routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ...app import SevenApp
from ...execution.runs import describe
from ..common import err
from ..deps import get_seven

router = APIRouter()


@router.get("/api/runs")
async def list_runs(seven: Annotated[SevenApp, Depends(get_seven)], agent: str | None = None, limit: int = Query(100, ge=1, le=1000)):
    return seven.state.list_runs(agent, limit)


@router.get("/api/runs/{rid}")
async def run_status(rid: str, seven: Annotated[SevenApp, Depends(get_seven)], tail: int = Query(50, ge=1, le=500)):
    out = describe(seven.supervisor.runs, rid, tail)
    if out is None:
        raise err(404, f'no run "{rid}"')
    run = seven.state.get_run(rid)
    return {"summary": out, "run": run}


@router.post("/api/runs/{rid}/kill")
async def kill_run(rid: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    run = seven.supervisor.runs.get(rid)
    if not run:
        raise err(404, f'no run "{rid}"')
    live = seven.supervisor.runs.handle(rid)
    if not live:
        raise err(409, f"{rid} is not running")
    live.kill()
    await seven.supervisor.runs.settled(rid)
    return {"killed": rid, "status": seven.state.get_run(rid)}
