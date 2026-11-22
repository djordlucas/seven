"""Eval suite (R5): deterministic, network-free, end-to-end feature checks.

Each eval builds a fresh workspace and a real SevenApp stack with a scripted
model, performs whole flows (API, built-ins, jobs, mail, memory, skills,
delegate, restart), and asserts on DB rows / API responses / events.

Run: python -m evals.run   (or: make eval). Exit code is non-zero if any eval
fails; failed evals keep their workspace under the printed path.
"""

from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
import time
from pathlib import Path

from seven.app import SevenApp
from seven.core.config import load_config
from seven.core.state import ROOT_ID
from tests.fake_model import ScriptedModel, reply, tc


async def until(pred, timeout=15.0, interval=0.05) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if pred():
            return True
        await asyncio.sleep(interval)
    return pred()


def make_app(tmp: Path, model: ScriptedModel | None = None) -> SevenApp:
    cfg = load_config({"SEVEN_WORKSPACE": str(tmp), "SEVEN_LLM_API_KEY": "eval", "SEVEN_RUN_TIMEOUT_MS": "8000"})
    return SevenApp(cfg, model=model or ScriptedModel(), log_stderr=False)


# ── evals ──

async def eval_base_turn_with_tool(tmp: Path) -> None:
    app = make_app(tmp)
    app.model.push(reply(None, [tc("run_python", {"code": "default = lambda args: {'ok': True, 'n': args['n'] * 2}", "args": {"n": 21}})]))
    app.model.push(reply("the answer is 42"))
    await app.start()
    try:
        out = app.supervisor.user_message("seven", "double 21")
        assert out.get("turn_started")
        assert await until(lambda: any(m["message"].get("content") == "the answer is 42" for m in app.state.transcript("seven")))
        tools = [m["message"] for m in app.state.transcript("seven") if m["message"].get("role") == "tool"]
        assert tools and '"n": 42' in tools[0]["content"]
    finally:
        await app.shutdown()


async def eval_background_run_kill(tmp: Path) -> None:
    app = make_app(tmp)
    await app.start()
    try:
        r = app.runner.start_eval("import time\ndef default(a):\n    time.sleep(30)")
        await asyncio.sleep(0.3)
        rid = app.supervisor.runs.add("seven", "run_python", r)
        r.kill()
        await app.supervisor.runs.settled(rid)
        run = app.state.get_run(rid)
        assert run["status"] == "done" and run["ok"] is False and run["error"] == "killed"
    finally:
        await app.shutdown()


async def eval_restart_resume(tmp: Path) -> None:
    app = make_app(tmp)
    app.state.append_message(ROOT_ID, {"role": "user", "content": "unanswered"})
    await app.start()
    await app.shutdown()
    app2 = make_app(tmp, model=ScriptedModel([reply("resumed answer")]))
    await app2.start()
    try:
        assert await until(lambda: any(m["message"].get("content") == "resumed answer" for m in app2.state.transcript("seven")))
    finally:
        await app2.shutdown()


async def eval_job_task_goal_periodic(tmp: Path) -> None:
    app = make_app(tmp)
    app.model.push(reply("task result"))
    app.model.push(reply("working"))
    app.model.push(reply("YES\ngoal met"))
    await app.start()
    try:
        j1 = app.supervisor.start_job("seven", "task", {"task": "do it"})
        assert await until(lambda: app.state.get_job(j1["id"])["status"] == "done")
        assert app.state.get_job(j1["id"])["result"] == "task result"
        assert any("job j1 done" in m["text"] for m in app.state.pending("seven", kind="message"))
        j2 = app.supervisor.start_job("user", "goal", {"goal": "g", "max_turns": 5})
        assert await until(lambda: app.state.get_job(j2["id"])["status"] == "done")
        assert "goal met" in app.state.get_job(j2["id"])["result"]
        j3 = app.supervisor.start_job("user", "periodic", {"interval_s": 3600, "instructions": "tick"})
        assert app.state.get_job(j3["id"])["status"] == "running"
        assert app.supervisor.stop_job(j3["id"], "user").startswith("stopped")
        assert app.state.get_job(j3["id"])["status"] == "stopped"
    finally:
        await app.shutdown()


async def eval_supervisor_commands_and_mail(tmp: Path) -> None:
    app = make_app(tmp)
    await app.start()
    try:
        app.state.send("seven", "supervisor", "message", "start job task remember this")
        assert await until(lambda: any(j["kind"] == "task" for j in app.state.list_jobs(all=False)))
        app.state.send("seven", "supervisor", "message", "bogus")
        assert await until(lambda: any("unknown command" in (o["text"] or "") for o in app.state.list_outbox("supervisor")))
        out = app.state.list_outbox("seven")
        assert out and out[0]["recipient"] == "supervisor"
    finally:
        await app.shutdown()


async def eval_spill_memory_and_discovery(tmp: Path) -> None:
    app = make_app(tmp)
    app.model.push(reply(None, [tc("run_python", {"code": "default = lambda a: 'z' * 9000"})]))
    app.model.push(reply("ok"))
    await app.start()
    try:
        app.supervisor.user_message("seven", "make big output")
        assert await until(lambda: any(m["message"].get("role") == "tool" for m in app.state.transcript("seven")))
        tool_msg = next(m["message"] for m in app.state.transcript("seven") if m["message"].get("role") == "tool")
        assert "saved to memory" in tool_msg["content"]
        oid = tool_msg["content"].split("memory ")[1].split(" ")[0]
        out = app.state.get_output(oid)
        assert out["chars"] == 9000
        from seven.tools.builtins import builtins
        from seven.tools.builtins.shared import BuiltinContext
        ctx = BuiltinContext(agent_id="seven", runner=app.runner, store=app.store, runs=app.supervisor.runs,
                             supervisor=app.supervisor, state=app.state, workspace=str(app.config.workspace), state_db=app.state.path,
                             abort=None, log=app.log.child(agent="seven"))
        chunk = await builtins()["read_memory"].run({"id": oid, "offset": 8995, "limit": 100}, ctx)
        assert "zzzzz" in chunk and "9000 chars total" in chunk
        a = app.supervisor.agent("seven")
        names = {t.name for t in a.context()[0]}
        assert "sql" not in names and "list_tools" in names and "run_python" in names
        await builtins()["describe_tool"].run({"name": "sql"}, ctx)
        assert "sql" in {t.name for t in a.context()[0]}
        assert app.state.get_agent("seven")["revealed_tools"] == ["sql"]
    finally:
        await app.shutdown()


async def eval_skills_and_delegate(tmp: Path) -> None:
    app = make_app(tmp)
    app.model.push(reply("sub final"))
    await app.start()
    try:
        from seven.tools.builtins import builtins
        from seven.tools.builtins.shared import BuiltinContext
        ctx = BuiltinContext(agent_id="seven", runner=app.runner, store=app.store, runs=app.supervisor.runs,
                             supervisor=app.supervisor, state=app.state, workspace=str(app.config.workspace), state_db=app.state.path,
                             abort=None, log=app.log.child(agent="seven"))
        r = await app.runner.run_file(_write(tmp, "adder.py", "def default(a):\n    return a['x'] + 1"), {"x": 1})
        assert r.ok
        app.store.save(name="adder", description="adds", parameters={"type": "object"}, deps={}, packages=[], source="def default(a):\n    return a['x'] + 1")
        out = await builtins()["define_skill"].run({"name": "math", "description": "m", "tools": ["adder", "ghost"]}, ctx)
        assert out.startswith("error:") and "ghost" in out
        out = await builtins()["define_skill"].run({"name": "math", "description": "m", "tools": ["adder"]}, ctx)
        assert "saved skill math" in out
        out = await builtins()["delete_tool"].run({"name": "adder"}, ctx)
        assert "used by skill(s) math" in out
        await builtins()["load_skill"].run({"name": "math"}, ctx)
        a = app.supervisor.agent("seven")
        assert "adder" in {t.name for t in a.context()[0]}
        ans = await builtins()["delegate"].run({"task": "compute"}, ctx)
        assert ans == "sub final"
        await builtins()["delete_skill"].run({"name": "math"}, ctx)
        assert app.state.get_skill("math") is None
        assert "math" not in app.state.get_agent("seven")["loaded_skills"]
        out = await builtins()["delete_tool"].run({"name": "adder"}, ctx)
        assert out == "deleted adder"
    finally:
        await app.shutdown()


async def eval_api_end_to_end(tmp: Path) -> None:
    import httpx

    from seven.api import create_app
    app = make_app(tmp)
    app.model.push(reply("hi from api"))
    await app.start()
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(app)), base_url="http://t")
    try:
        assert (await client.get("/api/health")).json()["status"] == "ok"
        assert (await client.get("/")).status_code == 200
        r = await client.post("/api/agents/seven/messages", json={"text": "hello"})
        assert r.status_code == 202 and r.json()["turn_started"]
        assert await until(lambda: any(m["message"].get("content") == "hi from api" for m in app.state.transcript("seven")))
        r = await client.post("/api/tools", json={"name": "t1", "description": "d", "code": "def default(a):\n    return 7"})
        assert r.status_code == 201
        r = await client.post("/api/tools/t1/call", json={"args": {}})
        assert r.json()["value"] == 7
        r = await client.post("/api/skills", json={"name": "s", "description": "d", "tools": ["t1"]})
        assert r.status_code == 201
        r = await client.delete("/api/tools/t1")
        assert r.status_code == 409
        r = await client.post("/api/jobs", json={"kind": "periodic", "interval_s": 60, "instructions": "x"})
        assert r.status_code == 201
        assert len((await client.get("/api/jobs")).json()) == 1
        assert (await client.get("/api/agents/seven/outbox")).status_code == 200
    finally:
        await client.aclose()
        await app.shutdown()


def _write(tmp: Path, name: str, code: str) -> Path:
    p = tmp / name
    p.write_text(code)
    return p


EVALS = [
    ("base_turn_with_tool", eval_base_turn_with_tool),
    ("background_run_kill", eval_background_run_kill),
    ("restart_resume", eval_restart_resume),
    ("jobs_task_goal_periodic", eval_job_task_goal_periodic),
    ("supervisor_commands_and_mail", eval_supervisor_commands_and_mail),
    ("spill_memory_and_discovery", eval_spill_memory_and_discovery),
    ("skills_and_delegate", eval_skills_and_delegate),
    ("api_end_to_end", eval_api_end_to_end),
]


async def main() -> int:
    only = sys.argv[1:] or None
    failures = 0
    for name, fn in EVALS:
        if only and name not in only:
            continue
        tmp = Path(tempfile.mkdtemp(prefix=f"seven-eval-{name}-"))
        started = time.time()
        try:
            await fn(tmp)
            print(f"PASS {name} ({time.time() - started:.1f}s)")
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception as err:
            failures += 1
            print(f"FAIL {name} ({time.time() - started:.1f}s): {type(err).__name__}: {err}")
            print(f"     workspace kept: {tmp}")
    total = len(only) if only else len(EVALS)
    print(f"\n{total - failures}/{total} evals passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
