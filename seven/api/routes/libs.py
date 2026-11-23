"""Library routes: generated-library CRUD plus rebundling dependents of a library."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ...app import SevenApp
from ...tools import TOOL_NAME, LibInUseError
from ...tools.bundle import rebundle
from ..common import api_ctx, err
from ..deps import get_seven
from ..models import DefineLibRequest

router = APIRouter()


@router.get("/api/libs")
async def list_libs(seven: Annotated[SevenApp, Depends(get_seven)]):
    return seven.libstore.list()


@router.post("/api/libs", status_code=201)
async def define_lib(req: DefineLibRequest, seven: Annotated[SevenApp, Depends(get_seven)]):
    if not TOOL_NAME.match(req.name):
        raise err(400, f"name must match {TOOL_NAME.pattern}")
    try:
        meta = seven.libstore.save(name=req.name, description=req.description, source=req.code)
    except ValueError as e:
        raise err(400, str(e))
    except SyntaxError as e:
        raise err(400, f"syntax error: {e}")
    seven.log.info("library saved", lib=req.name, revision=meta["revision"], source="api")
    return meta


@router.get("/api/libs/{name}")
async def get_lib(name: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    lib = seven.libstore.get(name)
    if not lib:
        raise err(404, f'no library named "{name}"')
    return {**lib, "dependents": seven.libstore.dependents(name)}


@router.delete("/api/libs/{name}")
async def delete_lib(name: str, seven: Annotated[SevenApp, Depends(get_seven)], force: bool = False):
    try:
        removed = seven.libstore.remove(name, force=force)
    except LibInUseError as e:
        raise err(409, str(e))
    if not removed:
        raise err(404, f'no library named "{name}"')
    return {"deleted": name}


@router.post("/api/libs/{name}/revalidate")
async def revalidate_lib(name: str, seven: Annotated[SevenApp, Depends(get_seven)],
                         libs: list[str] | None = None, apply: bool = Query(True)):
    """Rebundle every tool that pins this library against its latest revision
    (or the given specs). With apply=true (default) passing tools keep the new pins."""
    if not seven.libstore.get(name):
        raise err(404, f'no library named "{name}"')
    ctx = api_ctx(seven)
    out = []
    for dep in seven.libstore.dependents(name):
        try:
            report = await rebundle(ctx, dep["tool"], libs)
            if not apply and report["updated"]:
                # dry run: roll the pin back
                seven.store.set_libs(dep["tool"], report["from"])
                report["updated"] = False
                report["dry_run"] = True
            out.append(report)
        except ValueError as e:
            out.append({"tool": dep["tool"], "error": str(e), "updated": False})
    return {"library": name, "results": out}
