"""Server-level routes: health, config, logs, the SSE event stream."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from ... import __version__
from ...app import SevenApp
from ...core.log import read_log
from ...core.state import TERMINAL
from ..deps import get_seven

router = APIRouter()


@router.get("/api/health")
async def health(seven: Annotated[SevenApp, Depends(get_seven)]):
    return {"status": "ok", "version": __version__, "workspace": str(seven.config.workspace),
            "active_agents": sum(1 for r in seven.state.list_agents() if r["status"] not in TERMINAL),
            "uptime_s": round(time.time() - seven.started_at, 1)}


@router.get("/api/config")
async def config(seven: Annotated[SevenApp, Depends(get_seven)]):
    return seven.config.public()


@router.get("/api/logs")
async def logs(seven: Annotated[SevenApp, Depends(get_seven)], agent: str | None = None, turn: str | None = None, run: str | None = None,
               level: str | None = None, grep: str | None = None, tail: int = Query(100, ge=0, le=10000)):
    if seven.config.log_file is None:
        return []
    return read_log(seven.config.log_file, agent=agent, turn=turn, run=run, level=level, grep=grep, tail=tail)


@router.get("/api/events", include_in_schema=False)
async def events(seven: Annotated[SevenApp, Depends(get_seven)], agent: str | None = None):
    q = seven.subscribe()

    async def stream():
        try:
            while True:
                e = await q.get()
                if agent and agent not in (e.get("agent"), e.get("to"), e.get("from")):
                    continue
                yield f"event: {e.get('type', 'message')}\ndata: {json.dumps(e, default=str)}\n\n"
        except asyncio.CancelledError:
            raise
        finally:
            seven.unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
