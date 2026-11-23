"""Shared helpers for the API routes."""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

from ..app import SevenApp
from ..core.state import AgentRow
from ..tools.builtins.shared import BuiltinContext

UI_DIR = Path(__file__).resolve().parent / "ui"


def err(status: int, msg: str) -> HTTPException:
    return HTTPException(status, detail=msg)


def agent_view(app: SevenApp, row: AgentRow) -> dict:
    pending = app.state.pending(row["id"])
    a = app.supervisor.agent(row["id"])
    return {
        **row,
        "busy": bool(a and a.busy),
        "inbox_pending": len(pending),
        "inbox_tasks": sum(1 for p in pending if p["kind"] == "task"),
        "inbox_messages": sum(1 for p in pending if p["kind"] == "message"),
        "last_answer": a.last_answer() if a else None,
    }


def api_ctx(seven: SevenApp) -> BuiltinContext:
    return BuiltinContext(agent_id="user", runner=seven.runner, store=seven.store, libstore=seven.libstore,
                          runs=seven.supervisor.runs, supervisor=seven.supervisor, state=seven.state,
                          workspace=str(seven.config.workspace), state_db=seven.state.path,
                          abort=None, log=seven.log.child(agent="user"))
