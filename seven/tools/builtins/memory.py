"""Memory: spilled output (R3a, read_memory) plus a per-agent key/value store
(remember/recall/forget) that survives restarts and shows up in the UI's Data view."""

from __future__ import annotations

import re
from pathlib import Path

from .shared import Builtin, BuiltinContext, positive

MEMORY_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
KV_KEY = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
KV_MAX_CHARS = 64 * 1024


def memory_builtins() -> list:
    return [
        Builtin(
            name="read_memory",
            description="Read a chunk of spilled output (a tool result or a background run's output) saved to memory. "
                        "Returns the window plus the total size and the next offset, so you can page through large output "
                        "without it entering your context whole.",
            parameters={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "The memory id from the tool result, e.g. a tool call id or r3."},
                    "offset": {"type": "integer", "description": "Character offset to start at. Default 0."},
                    "limit": {"type": "integer", "description": "Characters to return. Default 4000."},
                },
                "required": ["id"],
            },
            run=_read_memory,
        ),
        Builtin(
            name="remember",
            description="Save a small piece of data under a key in your own key/value memory (persists across restarts; "
                        "visible to the user in the Data view). Overwrites the key if it exists.",
            parameters={
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Key: 1-64 chars of [A-Za-z0-9_.-], e.g. 'todo' or 'user.email'."},
                    "value": {"type": "string", "description": f"Value to store (max {KV_MAX_CHARS} chars)."},
                },
                "required": ["key", "value"],
            },
            run=_remember,
        ),
        Builtin(
            name="recall",
            description="Read back data from your key/value memory. With a key, returns a character window of that "
                        "value (offset/limit page through big values, like read_memory); without a key, lists all "
                        "your keys with sizes, last update and a short value preview.",
            parameters={
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Key to read. Omit to list all your keys."},
                    "offset": {"type": "integer", "description": "Character offset into the value. Default 0."},
                    "limit": {"type": "integer", "description": "Characters to return. Default 4000."},
                },
            },
            run=_recall,
        ),
        Builtin(
            name="forget",
            description="Delete a key from your key/value memory.",
            parameters={
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Key to delete."},
                },
                "required": ["key"],
            },
            run=_forget,
        ),
    ]


def _check_key(key: str) -> str | None:
    return None if KV_KEY.match(key) else f'error: invalid key "{key}" (use 1-64 chars of [A-Za-z0-9_.-])'


async def _remember(a: dict, ctx: BuiltinContext) -> str:
    key = str(a.get("key", ""))
    err = _check_key(key)
    if err:
        return err
    value = str(a.get("value", ""))
    if len(value) > KV_MAX_CHARS:
        return f"error: value too large ({len(value)} chars; max {KV_MAX_CHARS}). Use a file for big data."
    existed = ctx.state.kv_get(ctx.agent_id, key) is not None
    ctx.state.kv_put(ctx.agent_id, key, value)
    ctx.supervisor.emit({"type": "kv_changed", "agent": ctx.agent_id, "key": key, "op": "put"})
    ctx.log.info("kv put", agent=ctx.agent_id, key=key, chars=len(value))
    return f"{'updated' if existed else 'remembered'} {key} ({len(value)} chars)"


async def _recall(a: dict, ctx: BuiltinContext) -> str:
    key = str(a.get("key", ""))
    if key:
        err = _check_key(key)
        if err:
            return err
        row = ctx.state.kv_get(ctx.agent_id, key)
        if not row:
            return f'error: no key "{key}"'
        value = row["value"]
        offset = positive(a.get("offset"), 0)
        limit = positive(a.get("limit"), 4000)
        window = value[offset:offset + limit]
        nxt = offset + len(window)
        head = f'{key}: {len(value)} chars total (updated {row["updated_at"]}); showing [{offset}, {nxt})'
        if nxt < len(value):
            head += f'; next: recall("{key}", {nxt}, {limit})'
        return head + "\n---\n" + window
    rows = ctx.state.kv_list(ctx.agent_id)
    if not rows:
        return "no keys remembered yet"
    lines = [f"{len(rows)} key(s) in your memory:"]
    for r in rows:
        preview = str(r.get("preview") or "").replace("\n", " ")
        if len(preview) > 80:
            preview = preview[:80] + "…"
        lines.append(f"- {r['key']} ({r['chars']} chars, {r['updated_at']}) — {preview}")
    lines.append('recall("key") reads one; recall("key", offset, limit) pages through it')
    return "\n".join(lines)


async def _forget(a: dict, ctx: BuiltinContext) -> str:
    key = str(a.get("key", ""))
    err = _check_key(key)
    if err:
        return err
    if not ctx.state.kv_delete(ctx.agent_id, key):
        return f'error: no key "{key}"'
    ctx.supervisor.emit({"type": "kv_changed", "agent": ctx.agent_id, "key": key, "op": "delete"})
    ctx.log.info("kv delete", agent=ctx.agent_id, key=key)
    return f"forgot {key}"


async def _read_memory(a: dict, ctx: BuiltinContext) -> str:
    oid = str(a.get("id", ""))
    if not MEMORY_ID.match(oid):
        return f'error: invalid memory id "{oid}"'
    out = ctx.state.get_output(oid)
    memory_dir = Path(ctx.workspace) / ".seven" / "memory"
    if not out:
        candidate = memory_dir / f"{oid}.out"
        if candidate.is_file():
            out = {"id": oid, "path": str(candidate), "chars": candidate.stat().st_size, "lines": 0}
        else:
            return f'error: no memory "{oid}"'
    path = Path(out["path"])
    if memory_dir not in path.resolve().parents and path.resolve() != memory_dir / f"{oid}.out":
        return f'error: "{oid}" is outside the memory dir'
    if not path.is_file():
        return f'error: memory "{oid}" file is missing'
    text = path.read_text(encoding="utf-8", errors="replace")
    offset = positive(a.get("offset"), 0)
    limit = positive(a.get("limit"), 4000)
    window = text[offset:offset + limit]
    nxt = offset + len(window)
    head = f"memory {oid}: {len(text)} chars total; showing [{offset}, {nxt})"
    if nxt < len(text):
        head += f'; next: read_memory("{oid}", {nxt}, {limit})'
    return head + "\n---\n" + window
