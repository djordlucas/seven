"""Output-memory routes (R3a): list spilled outputs, read one in chunks."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ...app import SevenApp
from ..common import err
from ..deps import get_seven

router = APIRouter()


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
