"""Output memory (R3a): spilled tool/run output lives under the memory dir;
read_memory returns a character window of one."""

from __future__ import annotations

import re
from pathlib import Path

from .shared import Builtin, BuiltinContext, positive

MEMORY_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


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
    ]


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
