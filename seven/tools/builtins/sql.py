"""SQLite databases for agents: any file in the workspace except seven's own."""

from __future__ import annotations

import base64
import json
import re
import sqlite3
import time
from pathlib import Path

from .shared import Builtin, BuiltinContext

MAX_ROWS = 200


def sql_builtins() -> list:
    return [
        Builtin(
            name="sql",
            description="Run SQL against a SQLite database file in the workspace, creating it if needed. Each database is its "
                        "own file, so use as many as you like (e.g. data/notes.db). A query returning rows gives the rows; any "
                        "other statement gives changes and lastInsertRowid. Without params or named, several statements separated "
                        "by ; may be run at once.",
            parameters={
                "type": "object",
                "properties": {
                    "db": {"type": "string", "description": "Path of the database file, relative to the workspace."},
                    "query": {"type": "string"},
                    "params": {"type": "array", "description": "Values for ? placeholders, in order."},
                    "named": {"type": "object", "description": 'Values for :name placeholders, e.g. {"name": "x"} for :name.'},
                },
                "required": ["db", "query"],
            },
            run=_sql,
        ),
    ]


def resolve_db(workspace: str, state_db: str, p: str) -> str:
    base = Path(workspace).resolve()
    file = (base / p).resolve()
    try:
        rel = file.relative_to(base)
    except ValueError:
        return f'error: "{p}" is outside the workspace; databases live in the workspace'
    if str(rel) == ".":
        return f'error: "{p}" is outside the workspace; databases live in the workspace'
    try:
        if file.resolve() == Path(state_db).resolve():
            return f'error: "{p}" is seven\'s own database; use another file'
    except OSError:
        pass
    return str(file)


async def _sql(a: dict, ctx: BuiltinContext) -> str:
    file = resolve_db(ctx.workspace, ctx.state_db, str(a.get("db", "")))
    if file.startswith("error:"):
        return file
    Path(file).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(file)
    db.row_factory = sqlite3.Row
    started = time.time()
    fields = {"db": str(Path(file).relative_to(ctx.workspace)), "duration_ms": 0}
    try:
        out = _run(db, str(a.get("query", "")), a.get("params"), a.get("named"))
        fields["duration_ms"] = round((time.time() - started) * 1000)
        ctx.log.info("sql", **fields, statement=str(a.get("query", "")).strip().split()[0].upper() if str(a.get("query", "")).strip() else "")
        return out
    except Exception as err:
        fields["duration_ms"] = round((time.time() - started) * 1000)
        ctx.log.warning("sql failed", **fields, error=str(err))
        return f"error: {err}"
    finally:
        db.close()


def _run(db: sqlite3.Connection, query: str, params, named) -> str:
    bind = _bind(params, named)
    if params is None and named is None and re.search(r";\s*\S", query):
        db.executescript(query)
        db.commit()
        return "ok"
    cur = db.execute(query, bind if bind is not None else ())
    db.commit()
    if cur.description is not None:
        rows = cur.fetchall()
        shown = [dict(r) for r in rows[:MAX_ROWS]]
        more = f"\n… {len(rows) - MAX_ROWS} more rows" if len(rows) > MAX_ROWS else ""
        return json.dumps(shown, default=_json_safe, indent=2) + more
    return json.dumps({"changes": max(cur.rowcount or 0, 0), "lastInsertRowid": cur.lastrowid})


def _bind(params, named) -> tuple | dict | None:
    if named is not None and isinstance(named, dict):
        return {k: v for k, v in named.items()}
    if isinstance(params, list):
        return tuple(params)
    return None


def _json_safe(v):
    if isinstance(v, bytes):
        return {"base64": base64.b64encode(v).decode()}
    if isinstance(v, (set, frozenset)):
        return sorted(v, key=str)
    return str(v)
