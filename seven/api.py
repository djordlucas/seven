"""The FastAPI app: the API that controls seven, and the companion UI."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .app import SevenApp
from .builtins.code import _health
from .builtins.shared import BuiltinContext, await_run, format_run, start_generated
from .config import load_config
from .log import read_log
from .runs import describe
from .state import ROOT_ID, TERMINAL

UI_DIR = Path(__file__).resolve().parent / "ui"


class SpawnRequest(BaseModel):
    name: str
    description: str = ""
    instructions: str = ""
    mode: str = "request"
    tasks: list[str] = Field(default_factory=list)
    interval_s: int | None = None
    max_steps: int | None = None


class MessageRequest(BaseModel):
    text: str


class StopRequest(BaseModel):
    reason: str | None = None


class DefineToolRequest(BaseModel):
    name: str
    description: str
    parameters: dict = Field(default_factory=lambda: {"type": "object"})
    code: str
    deps: dict[str, str] | None = None
    test_args: dict | None = None
    timeout_ms: int | None = None


class DisableRequest(BaseModel):
    reason: str


class CallRequest(BaseModel):
    args: dict = Field(default_factory=dict)
    timeout_ms: int | None = None


class ExecRequest(BaseModel):
    code: str
    args: dict | None = None
    deps: dict[str, str] | None = None
    timeout_ms: int | None = None


def _err(status: int, msg: str) -> HTTPException:
    return HTTPException(status, detail=msg)


def _agent_view(app: SevenApp, row: dict) -> dict:
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


def create_app(seven: SevenApp | None = None) -> FastAPI:
    seven = seven or SevenApp(load_config())

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await seven.start()
        yield
        await seven.shutdown()

    app = FastAPI(title="seven", version=__version__, lifespan=lifespan)
    app.state.seven = seven

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(UI_DIR / "index.html")

    app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "version": __version__, "workspace": str(seven.config.workspace),
                "active_agents": sum(1 for r in seven.state.list_agents() if r["status"] not in TERMINAL),
                "uptime_s": round(__import__("time").time() - seven.started_at, 1)}

    @app.get("/api/config")
    async def config():
        return seven.config.public()

    @app.get("/api/agents")
    async def list_agents(all: bool = False):
        return [_agent_view(seven, r) for r in seven.supervisor.list(all)]

    @app.post("/api/agents", status_code=201)
    async def spawn_agent(req: SpawnRequest):
        spec = {"name": req.name, "description": req.description, "instructions": req.instructions,
                "mode": req.mode, "tasks": req.tasks, "interval_s": req.interval_s, "max_steps": req.max_steps}
        row = seven.supervisor.spawn(ROOT_ID, spec)
        if isinstance(row, str):
            raise _err(409, row)
        return _agent_view(seven, row)

    @app.get("/api/agents/{agent_id}")
    async def get_agent(agent_id: str):
        row = seven.state.get_agent(agent_id) or seven.supervisor.resolve(agent_id)
        if isinstance(row, str) or row is None:
            raise _err(404, row or f'no agent "{agent_id}"')
        return _agent_view(seven, row)

    @app.get("/api/agents/{agent_id}/messages")
    async def get_messages(agent_id: str, limit: int = Query(200, ge=1, le=2000), offset: int = Query(0, ge=0)):
        if not seven.state.get_agent(agent_id):
            raise _err(404, f'no agent "{agent_id}"')
        return {"total": seven.state.transcript_count(agent_id), "messages": seven.state.transcript(agent_id, limit, offset)}

    @app.post("/api/agents/{agent_id}/messages", status_code=202)
    async def send_message(agent_id: str, req: MessageRequest):
        out = seven.supervisor.user_message(agent_id, req.text)
        if isinstance(out, str):
            raise _err(409, out)
        return out

    @app.get("/api/agents/{agent_id}/inbox")
    async def get_inbox(agent_id: str):
        if not seven.state.get_agent(agent_id):
            raise _err(404, f'no agent "{agent_id}"')
        return seven.state.pending(agent_id)

    @app.post("/api/agents/{agent_id}/stop")
    async def stop_agent(agent_id: str, req: StopRequest | None = None):
        out = seven.supervisor.stop(agent_id, "user", req.reason if req else None)
        if not out.startswith("stopped"):
            raise _err(409, out)
        return {"stopped": agent_id}

    @app.post("/api/agents/{agent_id}/compact")
    async def compact_agent(agent_id: str):
        a = seven.supervisor.agent(agent_id)
        if not a:
            raise _err(404, f'no agent "{agent_id}"')
        out = await a.compact("manual", seven.log.child(agent=agent_id))
        if out is None:
            raise _err(409, "nothing to fold")
        return out

    @app.delete("/api/agents/{agent_id}/conversation")
    async def reset_conversation(agent_id: str):
        if not seven.state.get_agent(agent_id):
            raise _err(404, f'no agent "{agent_id}"')
        seven.state.clear_conversation(agent_id)
        return {"cleared": agent_id}

    @app.get("/api/tools")
    async def list_tools():
        return seven.store.list()

    @app.post("/api/tools", status_code=201)
    async def define_tool(req: DefineToolRequest):
        ctx = _api_ctx(seven)
        from .tools import TOOL_NAME
        if not TOOL_NAME.match(req.name):
            raise _err(400, f"name must match {TOOL_NAME.pattern}")
        try:
            packages = await seven.runner.install(req.code, req.deps or {}, seven.log)
        except Exception as err:
            raise _err(400, str(err))
        if req.test_args is not None:
            from .builtins.code import _trial_run
            r = await _trial_run(ctx, req.name, req.code, req.test_args, req.timeout_ms)
            if not r.ok:
                raise _err(400, f"not saved: the trial run failed\n{format_run(r)}")
        meta = seven.store.save(name=req.name, description=req.description, parameters=req.parameters,
                                deps=req.deps or {}, packages=packages, source=req.code, timeout_ms=req.timeout_ms)
        seven.log.info("tool saved", tool=req.name, revision=meta["revision"], source="api")
        return meta

    @app.get("/api/tools/{name}")
    async def get_tool(name: str):
        t = seven.store.get(name)
        if not t:
            raise _err(404, f'no tool named "{name}"')
        return t

    @app.delete("/api/tools/{name}")
    async def delete_tool(name: str):
        if not seven.store.remove(name):
            raise _err(404, f'no tool named "{name}"')
        return {"deleted": name}

    @app.post("/api/tools/{name}/disable")
    async def disable_tool(name: str, req: DisableRequest):
        if not seven.store.set_disabled(name, req.reason):
            raise _err(404, f'no tool named "{name}"')
        seven.log.warning("tool disabled", tool=name, reason=req.reason, source="api")
        return {"disabled": name}

    @app.post("/api/tools/{name}/enable")
    async def enable_tool(name: str):
        if not seven.store.set_disabled(name, None):
            raise _err(404, f'no tool named "{name}"')
        return {"enabled": name}

    @app.get("/api/tools/{name}/health")
    async def tool_health(name: str, last: int = Query(10, ge=1, le=100)):
        t = seven.store.get(name)
        if not t:
            raise _err(404, f'no tool named "{name}"')
        return {"report": _health(t, seven.store, last), "runs": seven.store.history(name)}

    @app.post("/api/tools/{name}/call")
    async def call_tool(name: str, req: CallRequest):
        t = seven.store.get(name)
        if not t:
            raise _err(404, f'no tool named "{name}"')
        if t["meta"].get("disabled"):
            raise _err(409, f'tool "{name}" is disabled ({t["meta"]["disabled"]["reason"]})')
        ctx = _api_ctx(seven)
        handle = start_generated(ctx, t, req.args, "sync", req.timeout_ms)
        r = await await_run(handle)
        return {"ok": r.ok, "value": r.value, "error": r.error, "logs": r.logs, "duration_ms": r.duration_ms}

    @app.post("/api/tools/{name}/start", status_code=202)
    async def start_tool(name: str, req: CallRequest):
        t = seven.store.get(name)
        if not t:
            raise _err(404, f'no tool named "{name}"')
        if t["meta"].get("disabled"):
            raise _err(409, f'tool "{name}" is disabled ({t["meta"]["disabled"]["reason"]})')
        ctx = _api_ctx(seven)
        handle = start_generated(ctx, t, req.args, "async", req.timeout_ms)
        rid = seven.supervisor.runs.add("user", name, handle)
        return {"run": rid}

    @app.post("/api/exec")
    async def exec_python(req: ExecRequest):
        handle = seven.runner.start_eval(req.code, args=req.args, deps=req.deps, timeout_ms=req.timeout_ms, log=seven.log)
        r = await await_run(handle)
        return {"ok": r.ok, "value": r.value, "error": r.error, "logs": r.logs, "duration_ms": r.duration_ms}

    @app.get("/api/runs")
    async def list_runs(agent: str | None = None, limit: int = Query(100, ge=1, le=1000)):
        return seven.state.list_runs(agent, limit)

    @app.get("/api/runs/{rid}")
    async def run_status(rid: str, tail: int = Query(50, ge=1, le=500)):
        out = describe(seven.supervisor.runs, rid, tail)
        if out is None:
            raise _err(404, f'no run "{rid}"')
        run = seven.state.get_run(rid)
        return {"summary": out, "run": run}

    @app.post("/api/runs/{rid}/kill")
    async def kill_run(rid: str):
        run = seven.supervisor.runs.get(rid)
        if not run:
            raise _err(404, f'no run "{rid}"')
        live = seven.supervisor.runs.handle(rid)
        if not live:
            raise _err(409, f"{rid} is not running")
        live.kill()
        await seven.supervisor.runs.settled(rid)
        return {"killed": rid, "status": seven.state.get_run(rid)}

    @app.get("/api/logs")
    async def logs(agent: str | None = None, turn: str | None = None, run: str | None = None,
                   level: str | None = None, grep: str | None = None, tail: int = Query(100, ge=0, le=10000)):
        if seven.config.log_file is None:
            return []
        return read_log(seven.config.log_file, agent=agent, turn=turn, run=run, level=level, grep=grep, tail=tail)

    @app.get("/api/events", include_in_schema=False)
    async def events(agent: str | None = None):
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

    return app


def _api_ctx(seven: SevenApp) -> BuiltinContext:
    return BuiltinContext(agent_id="user", runner=seven.runner, store=seven.store,
                          runs=seven.supervisor.runs, supervisor=seven.supervisor,
                          workspace=str(seven.config.workspace), state_db=seven.state.path,
                          abort=None, log=seven.log.child(agent="user"))
