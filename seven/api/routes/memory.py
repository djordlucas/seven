"""Memory routes: spilled outputs (R3a) plus the per-agent key/value store
(remember/recall/forget) that the Data view shows."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ...app import SevenApp
from ..common import err
from ..deps import get_seven

router = APIRouter()

KV_KEY = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
KV_MAX_CHARS = 64 * 1024


@router.get("/api/memory")
async def list_memory(seven: Annotated[SevenApp, Depends(get_seven)]):
    return seven.state.query("SELECT * FROM outputs ORDER BY created_at DESC, id DESC LIMIT 200")


@router.get("/api/memory/{oid}")
async def read_memory(oid: str, seven: Annotated[SevenApp, Depends(get_seven)], offset: int = Query(0, ge=0), limit: int = Query(4000, ge=1, le=100000)):
    out = seven.state.get_output(oid)
    if not out:
        raise err(404, f'no memory "{oid}"')
    p = Path(out["path"])
    if not p.is_file():
        raise err(404, f'memory "{oid}" file is missing')
    text = p.read_text(encoding="utf-8", errors="replace")
    window = text[offset:offset + limit]
    return {"id": oid, "total_chars": len(text), "offset": offset, "next_offset": offset + len(window) if offset + len(window) < len(text) else None, "chunk": window}


# ── per-agent key/value memory ──


class KvIn(BaseModel):
    value: str


def _check_kv_key(key: str):
    if not KV_KEY.match(key):
        raise err(400, f'invalid key "{key}" (use 1-64 chars of [A-Za-z0-9_.-])')


@router.get("/api/kv")
async def list_kv(seven: Annotated[SevenApp, Depends(get_seven)], agent: str = Query("")):
    return seven.state.kv_list(agent or None)


@router.get("/api/kv/{agent}/{key}")
async def get_kv(agent: str, key: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    _check_kv_key(key)
    row = seven.state.kv_get(agent, key)
    if not row:
        raise err(404, f'no key "{key}" for agent "{agent}"')
    return row


@router.put("/api/kv/{agent}/{key}")
async def put_kv(agent: str, key: str, body: KvIn, seven: Annotated[SevenApp, Depends(get_seven)]):
    _check_kv_key(key)
    if len(body.value) > KV_MAX_CHARS:
        raise err(413, f"value too large ({len(body.value)} chars; max {KV_MAX_CHARS})")
    seven.state.kv_put(agent, key, body.value)
    seven.supervisor.emit({"type": "kv_changed", "agent": agent, "key": key, "op": "put"})
    return seven.state.kv_get(agent, key)


@router.delete("/api/kv/{agent}/{key}")
async def delete_kv(agent: str, key: str, seven: Annotated[SevenApp, Depends(get_seven)]):
    _check_kv_key(key)
    if not seven.state.kv_delete(agent, key):
        raise err(404, f'no key "{key}" for agent "{agent}"')
    seven.supervisor.emit({"type": "kv_changed", "agent": agent, "key": key, "op": "delete"})
    return {"deleted": f"{agent}/{key}"}
