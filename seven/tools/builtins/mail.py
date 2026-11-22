"""Reading the two-sided mailbox: list_inbox and list_outbox (R2)."""

from __future__ import annotations

from .shared import Builtin, BuiltinContext


def mail_builtins() -> list:
    return [
        Builtin(
            name="list_inbox",
            description="List your inbox: pending tasks and messages first, then recently delivered ones. "
                        "Pending messages also arrive in your conversation at the start of your next step.",
            parameters={"type": "object", "properties": {"limit": {"type": "integer", "description": "Max items per section. Default 20."}}},
            run=_list_inbox,
        ),
        Builtin(
            name="list_outbox",
            description="List what you (or the user, or the supervisor) have sent: recipient, text, and whether it was delivered.",
            parameters={"type": "object", "properties": {"limit": {"type": "integer", "description": "Max items. Default 50."}}},
            run=_list_outbox,
        ),
    ]


def _fmt(item: dict, delivered: bool) -> str:
    mark = "delivered" if delivered else "PENDING"
    return f'- [{mark}] {item["kind"]} from {item["sender"]}: {item["text"][:200]}'


async def _list_inbox(a: dict, ctx: BuiltinContext) -> str:
    limit = a.get("limit") if isinstance(a.get("limit"), int) and a["limit"] > 0 else 20
    state = ctx.state
    pending = state.pending(ctx.agent_id)
    lines = [f"pending ({len(pending)}):"]
    lines += [_fmt(p, False) for p in pending[:limit]]
    all_rows = state.query("SELECT * FROM inbox WHERE agent = ? AND delivered_at IS NOT NULL ORDER BY id DESC LIMIT ?", (ctx.agent_id, limit))
    lines.append(f"recently delivered ({len(all_rows)} shown):")
    lines += [_fmt(dict(r), True) for r in all_rows]
    return "\n".join(lines)


async def _list_outbox(a: dict, ctx: BuiltinContext) -> str:
    limit = a.get("limit") if isinstance(a.get("limit"), int) and a["limit"] > 0 else 50
    rows = ctx.state.list_outbox(ctx.agent_id, limit)
    if not rows:
        return "nothing sent yet"
    return "\n".join(f'- {"delivered" if r["delivered_at"] else "pending"} to {r["recipient"]} ({r["kind"]}): {r["text"][:200]}' for r in reversed(rows))
