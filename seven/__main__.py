"""The `seven` command: `serve` runs the API and the agents; the other commands
read the state database or the log directly, so they work while a server runs."""

from __future__ import annotations

import argparse
import json
import sys
import time

from .core.config import load_config
from .core.log import format_readable, read_log
from .core.state import TERMINAL, State


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="seven", description="Seven: an LLM agent that builds itself, as a FastAPI app.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_serve = sub.add_parser("serve", help="run the API (and every agent) until SIGINT/SIGTERM")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8000)
    p_serve.add_argument("--reload", action="store_true",
                         help="watch the seven package and restart on changes (development in a container)")

    p_agents = sub.add_parser("agents", help="list agents, with inbox counts; does not run agents")
    p_agents.add_argument("--all", action="store_true", help="include finished, failed and stopped agents")

    p_send = sub.add_parser("send", help="queue a message from the user for an agent; works while a server runs")
    p_send.add_argument("agent", help="an agent id or name")
    p_send.add_argument("text")

    sub.add_parser("tools", help="list generated tools; does not run agents")

    p_logs = sub.add_parser("logs", help="print the structured log, filtered; -f follows it")
    p_logs.add_argument("--agent")
    p_logs.add_argument("--turn")
    p_logs.add_argument("--run")
    p_logs.add_argument("--level", choices=["debug", "info", "warn", "error"])
    p_logs.add_argument("--grep")
    p_logs.add_argument("--tail", type=int, default=100, help="last n matching lines; 0 for all")
    p_logs.add_argument("-f", "--follow", action="store_true")
    p_logs.add_argument("--json", action="store_true", help="raw JSON lines")

    args = parser.parse_args(argv)
    cfg = load_config()

    if args.cmd == "serve":
        return _serve(cfg, args.host, args.port, args.reload)
    if args.cmd == "agents":
        return _agents(cfg, args.all)
    if args.cmd == "send":
        return _send(cfg, args.agent, args.text)
    if args.cmd == "tools":
        return _tools(cfg)
    if args.cmd == "logs":
        return _logs(cfg, args)
    return 2


def _serve(cfg, host: str, port: int, reload: bool = False) -> int:
    state = State(cfg.state_db)
    err = state.acquire_lease()
    state.release_lease()
    state.close()
    if err:
        print(err, file=sys.stderr)
        return 1
    import uvicorn

    if reload:
        # Import-string form so uvicorn's reloader can restart the child on
        # source changes; watch the installed package, wherever it lives.
        from pathlib import Path

        import seven as pkg

        uvicorn.run("seven.api.app:create_app", factory=True, host=host, port=port,
                    reload=True, reload_dirs=[str(Path(pkg.__file__).resolve().parent)], log_level="warning")
        return 0
    from .api import create_app
    from .app import SevenApp
    uvicorn.run(create_app(SevenApp(cfg)), host=host, port=port, log_level="warning")
    return 0


def _agents(cfg, all: bool) -> int:
    state = State(cfg.state_db)
    try:
        rows = state.list_agents()
        if not all:
            rows = [r for r in rows if r["status"] not in TERMINAL]
        if not rows:
            print("no agents")
            return 0
        for r in rows:
            pending = state.pending(r["id"])
            n = len(pending)
            parent = f" · from {r['parent']}" if r.get("parent") else ""
            print(f'{r["id"]} "{r["name"]}" · {r["mode"]} · {r["status"]}{parent} · {r["description"]} · inbox {n}')
    finally:
        state.close()
    return 0


def _send(cfg, ref: str, text: str) -> int:
    state = State(cfg.state_db)
    try:
        row = state.get_agent(ref)
        if not row:
            named = [r for r in state.list_agents() if r["name"] == ref]
            row = next((r for r in reversed(named) if r["status"] not in TERMINAL), None) or (named[-1] if named else None)
        if not row:
            print(f'no agent "{ref}"', file=sys.stderr)
            return 1
        if row["status"] in TERMINAL:
            print(f'{row["id"]} "{row["name"]}" is {row["status"]} and reads no more messages', file=sys.stderr)
            return 1
        inbox_id = state.enqueue(row["id"], sender="user", kind="message", text=text)
        print(f"sent to {row['id']} \"{row['name']}\" (inbox {inbox_id})")
    finally:
        state.close()
    return 0


def _tools(cfg) -> int:
    state = State(cfg.state_db)
    try:
        rows = state.query("SELECT name, revision, timeout_ms, disabled_at, disabled_reason, updated_at FROM tools ORDER BY name")
        if not rows:
            print("no tools")
            return 0
        for r in rows:
            d = dict(r)
            state_txt = f"disabled: {d['disabled_reason']}" if d["disabled_at"] else "enabled"
            limit = f"{d['timeout_ms']}ms" if d["timeout_ms"] else "default"
            print(f'{d["name"]} r{d["revision"]} · {state_txt} · run limit {limit} · updated {d["updated_at"]}')
    finally:
        state.close()
    return 0


def _logs(cfg, args) -> int:
    if cfg.log_file is None:
        print("logging to a file is off (SEVEN_LOG_FILE=off)", file=sys.stderr)
        return 1
    def fetch(tail: int) -> list[dict]:
        return read_log(cfg.log_file, agent=args.agent, turn=args.turn, run=args.run,
                        level=args.level, grep=args.grep, tail=tail)

    def emit(rec: dict) -> None:
        print(json.dumps(rec) if args.json else format_readable(rec))

    if not args.follow:
        for rec in fetch(args.tail):
            emit(rec)
        return 0
    shown = 0

    def print_new() -> int:
        nonlocal shown
        recs = fetch(0)
        for rec in recs[shown:]:
            emit(rec)
        return len(recs)

    shown = print_new()
    try:
        while True:
            time.sleep(0.5)
            shown = print_new()
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
