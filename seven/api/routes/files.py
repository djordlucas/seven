"""Workspace file manager API: path-safe CRUD over the workspace directory.

All paths are relative to the workspace root and resolved before use;
anything escaping it (../, symlinks out, absolute paths) is refused.
Uploads use a raw request body (no multipart dependency).
"""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..app import SevenApp
from ..deps import get_seven

router = APIRouter()

MAX_READ_BYTES = 256 * 1024
MAX_WRITE_BYTES = 4 * 1024 * 1024


def _root(seven: SevenApp) -> Path:
    return Path(seven.config.workspace).resolve()


def _safe(root: Path, rel: str) -> Path:
    rel = (rel or "").strip().lstrip("/")
    if any(part == ".." for part in rel.split("/")):
        raise HTTPException(400, f"path escapes the workspace: {rel!r}")
    p = (root / rel).resolve() if rel else root
    if p != root and root not in p.parents:
        raise HTTPException(400, f"path escapes the workspace: {rel!r}")
    return p


class WriteIn(BaseModel):
    path: str
    content: str


class MkdirIn(BaseModel):
    path: str


class RenameIn(BaseModel):
    src: str
    dst: str


@router.get("/api/files/list")
def list_dir(rel: str = "", seven: SevenApp = Depends(get_seven)):
    root = _root(seven)
    p = _safe(root, rel)
    if not p.exists():
        raise HTTPException(404, f"no such path: {rel!r}")
    if p.is_file():
        st = p.stat()
        return {"path": rel, "kind": "file", "size": st.st_size, "mtime": st.st_mtime}
    entries = []
    for c in p.iterdir():
        try:
            st = c.stat()
        except OSError:
            continue  # broken symlink etc.
        entries.append({
            "name": c.name,
            "kind": "dir" if c.is_dir() else "file",
            "size": 0 if c.is_dir() else st.st_size,
            "mtime": st.st_mtime,
        })
    entries.sort(key=lambda e: (e["kind"] != "dir", e["name"].lower()))
    return {"path": rel, "kind": "dir", "entries": entries}


@router.get("/api/files/read")
def read_file(rel: str, seven: SevenApp = Depends(get_seven)):
    root = _root(seven)
    p = _safe(root, rel)
    if not p.is_file():
        raise HTTPException(404, f"not a file: {rel!r}")
    size = p.stat().st_size
    raw = p.read_bytes()[: MAX_READ_BYTES + 1]
    binary = b"\0" in raw[:8192]
    return {
        "path": rel,
        "size": size,
        "truncated": size > MAX_READ_BYTES,
        "binary": binary,
        "content": None if binary else raw[:MAX_READ_BYTES].decode("utf-8", errors="replace"),
    }


@router.put("/api/files/write")
def write_file(body: WriteIn, seven: SevenApp = Depends(get_seven)):
    root = _root(seven)
    p = _safe(root, body.path)
    if p == root or p.is_dir():
        raise HTTPException(400, f"is a directory: {body.path!r}")
    p.parent.mkdir(parents=True, exist_ok=True)
    data = body.content.encode("utf-8")
    if len(data) > MAX_WRITE_BYTES:
        raise HTTPException(413, "too large to write from the UI")
    p.write_bytes(data)
    return {"path": body.path, "size": len(data)}


@router.post("/api/files/mkdir")
def make_dir(body: MkdirIn, seven: SevenApp = Depends(get_seven)):
    root = _root(seven)
    p = _safe(root, body.path)
    if p.exists():
        raise HTTPException(409, f"already exists: {body.path!r}")
    p.mkdir(parents=True)
    return {"path": body.path}


@router.post("/api/files/rename")
def rename(body: RenameIn, seven: SevenApp = Depends(get_seven)):
    root = _root(seven)
    s = _safe(root, body.src)
    d = _safe(root, body.dst)
    if not s.exists():
        raise HTTPException(404, f"no such path: {body.src!r}")
    if d.exists():
        raise HTTPException(409, f"already exists: {body.dst!r}")
    if s.is_dir() and (d == s or s in d.parents):
        raise HTTPException(400, "cannot move a directory into itself")
    s.rename(d)
    return {"src": body.src, "dst": body.dst}


@router.delete("/api/files")
def delete(rel: str, recursive: bool = False, seven: SevenApp = Depends(get_seven)):
    root = _root(seven)
    p = _safe(root, rel)
    if p == root:
        raise HTTPException(400, "refusing to delete the workspace root")
    if not p.exists():
        raise HTTPException(404, f"no such path: {rel!r}")
    if p.is_dir():
        if any(p.iterdir()) and not recursive:
            raise HTTPException(409, f"directory not empty: {rel!r} (pass recursive=true)")
        shutil.rmtree(p) if recursive else p.rmdir()
    else:
        p.unlink()
    return {"deleted": rel}


@router.post("/api/files/upload")
def upload(rel: str = Query(..., description="destination path, filename included"),
           data: bytes = Body(...), seven: SevenApp = Depends(get_seven)):
    root = _root(seven)
    p = _safe(root, rel)
    name = Path(rel).name
    if not name or name in (".", ".."):
        raise HTTPException(400, f"bad filename: {rel!r}")
    if p.is_dir():  # destination given as a directory: keep the client's filename
        p = p / name
    p.parent.mkdir(parents=True, exist_ok=True)
    if len(data) > MAX_WRITE_BYTES:
        raise HTTPException(413, "too large to upload")
    p.write_bytes(data)
    return {"path": str(p.relative_to(root)), "size": len(data)}


@router.get("/api/files/download")
def download(rel: str, seven: SevenApp = Depends(get_seven)):
    root = _root(seven)
    p = _safe(root, rel)
    if not p.is_file():
        raise HTTPException(404, f"not a file: {rel!r}")
    return FileResponse(p, filename=p.name)
