"""Tool routes: the generated-tool CRUD, call/start, health, and /api/exec."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ...app import SevenApp
from ...tools import TOOL_NAME, ToolInUseError
from ...tools.builtins.code import _health, _trial_run
from ...tools.builtins.shared import await_run, format_run, start_generated
from ...tools.bundle import rebundle
from ..common import api_ctx, err
from ..deps import get_seven
from ..models import CallRequest, DefineToolRequest, DisableRequest, ExecRequest, RebundleRequest

router = APIRouter()


@router.get("/api/tools")
async def list_tools(seven: Annotated[SevenApp, Depends(get_seven)]):
    return seven.store.list()


@router.post("/api/tools", status_code=201)
async def define_tool(req: DefineToolRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    if not TOOL_NAME.match(req.name):
        raise err(400, f"name must match {TOOL_NAME.pattern}")
    pins = []
    if req.libs:
        try:
            pins = seven.libstore.resolve(req.libs)
        except ValueError as e:
            raise err(400, str(e))
    try:
        packages = await seven.runner.install(req.code, req.deps or {}, seven.log, skip={p["name"] for p in pins})
    except Exception as e:
        raise err(400, str(e))
    if req.test_args is not None:
        lmap = seven.libstore.libs_map(pins) if pins else None
        r = await _trial_run(api_ctx(seven), req.name, req.code, req.test_args, req.timeout_ms, lmap)
        if not r.ok:
            raise err(400, f"not saved: the trial run failed\n{format_run(r)}")
    meta = seven.store.save(name=req.name, description=req.description, parameters=req.parameters,
                            deps=req.deps or {}, packages=packages, source=req.code, timeout_ms=req.timeout_ms,
                            libs=pins, test_args=req.test_args)
    seven.log.info("tool saved", tool=req.name, revision=meta["revision"], source="api",
                   libs=[p["name"] for p in pins])
    return meta


@router.get("/api/tools/{name}")
async def get_tool(name: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    t = seven.store.get(name)
    if not t:
        raise err(404, f'no tool named "{name}"')
    return {**t, "used_by_skills": seven.state.skills_using_tool(name)}


@router.delete("/api/tools/{name}")
async def delete_tool(name: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    try:
        removed = seven.store.remove(name)
    except ToolInUseError as e:
        raise err(409, str(e))
    if not removed:
        raise err(404, f'no tool named "{name}"')
    return {"deleted": name}


@router.post("/api/tools/{name}/disable")
async def disable_tool(name: str, req: DisableRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    if not seven.store.set_disabled(name, req.reason):
        raise err(404, f'no tool named "{name}"')
    seven.log.warning("tool disabled", tool=name, reason=req.reason, source="api")
    return {"disabled": name}


@router.post("/api/tools/{name}/enable")
async def enable_tool(name: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    if not seven.store.set_disabled(name, None):
        raise err(404, f'no tool named "{name}"')
    return {"enabled": name}


@router.get("/api/tools/{name}/health")
async def tool_health(name: str, seven: Annotated[SevenApp, Depends(get_seven)], last: int = Query(10, ge=1, le=100)):
    t = seven.store.get(name)
    if not t:
        raise err(404, f'no tool named "{name}"')
    return {"report": _health(t, seven.store, last), "runs": seven.store.history(name)}


@router.post("/api/tools/{name}/call")
async def call_tool(name: str, req: CallRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    t = seven.store.get(name)
    if not t:
        raise err(404, f'no tool named "{name}"')
    if t["meta"].get("disabled"):
        raise err(409, f'tool "{name}" is disabled ({t["meta"]["disabled"]["reason"]})')
    handle = start_generated(api_ctx(seven), t, req.args, "sync", req.timeout_ms)
    r = await await_run(handle)
    return {"ok": r.ok, "value": r.value, "error": r.error, "logs": r.logs, "duration_ms": r.duration_ms}


@router.post("/api/tools/{name}/start", status_code=202)
async def start_tool(name: str, req: CallRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    t = seven.store.get(name)
    if not t:
        raise err(404, f'no tool named "{name}"')
    if t["meta"].get("disabled"):
        raise err(409, f'tool "{name}" is disabled ({t["meta"]["disabled"]["reason"]})')
    handle = start_generated(api_ctx(seven), t, req.args, "async", req.timeout_ms)
    rid = seven.supervisor.runs.add("user", name, handle)
    return {"run": rid}


@router.post("/api/tools/{name}/rebundle")
async def rebundle_tool(name: str, req: RebundleRequest | None = None,
                        seven: Annotated[SevenApp, Depends(get_seven)] = None):
    t = seven.store.get(name)
    if not t:
        raise err(404, f'no tool named "{name}"')
    try:
        return await rebundle(api_ctx(seven), name, req.libs if req else None)
    except ValueError as e:
        raise err(400, str(e))


@router.post("/api/exec")
async def exec_python(req: ExecRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    handle = seven.runner.start_eval(req.code, args=req.args, deps=req.deps, timeout_ms=req.timeout_ms, log=seven.log)
    r = await await_run(handle)
    return {"ok": r.ok, "value": r.value, "error": r.error, "logs": r.logs, "duration_ms": r.duration_ms}
