import asyncio
from types import SimpleNamespace

import httpx
import pytest

from seven.api import create_app
from seven.app import SevenApp
from tests.conftest import make_config, until
from tests.fake_model import ScriptedModel, reply


@pytest.fixture
async def api(tmp_path):
    cfg = make_config(tmp_path)
    model = ScriptedModel()
    seven = SevenApp(cfg, model=model, log_stderr=False)
    await seven.start()
    app = create_app(seven)
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://test")
    yield SimpleNamespace(client=client, seven=seven, model=model, cfg=cfg, app=app)
    await client.aclose()
    await seven.shutdown()


async def test_health_and_config(api):
    r = await api.client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    r = await api.client.get("/api/config")
    body = r.json()
    assert body["api_key_set"] is True
    assert "api_key" not in body and "test-key" not in r.text
    assert body["model"] == "mistral-medium-latest"


async def test_ui_served(api):
    r = await api.client.get("/")
    assert r.status_code == 200 and "seven" in r.text.lower()
    r = await api.client.get("/ui/app.js")
    assert r.status_code == 200


async def test_agents_list_and_root(api):
    r = await api.client.get("/api/agents")
    assert r.status_code == 200
    agents = r.json()
    assert any(a["id"] == "seven" and a["mode"] == "interactive" for a in agents)


async def test_spawn_and_chat_with_root(api):
    r = await api.client.post("/api/agents", json={"name": "helper", "description": "d", "instructions": "i",
                                                   "mode": "continuous", "tasks": []})
    assert r.status_code == 201 and r.json()["id"] == "a1"
    r = await api.client.post("/api/agents", json={"name": "bad", "mode": "request", "tasks": []})
    assert r.status_code == 409
    api.model.push(reply("hi from seven"))
    r = await api.client.post("/api/agents/seven/messages", json={"text": "hello"})
    assert r.status_code == 202 and r.json()["turn_started"] is True
    assert await until(lambda: api.seven.state.get_agent("a1") and True)
    got = await until(lambda: any(m["message"].get("role") == "assistant"
                                  for m in api.seven.state.transcript("seven")))
    assert got
    r = await api.client.get("/api/agents/seven/messages")
    msgs = r.json()["messages"]
    assert msgs[-1]["message"]["content"] == "hi from seven"
    r = await api.client.post("/api/agents/seven/stop", json={"reason": "no"})
    assert r.status_code == 409
    r = await api.client.post("/api/agents/a1/stop", json={})
    assert r.status_code == 200
    assert api.seven.state.get_agent("a1")["status"] == "stopped"


async def test_tool_lifecycle_via_api(api):
    code = "def default(args):\n    return {'sum': args['a'] + args['b']}\n"
    r = await api.client.post("/api/tools", json={"name": "adder", "description": "adds", "parameters": {"type": "object"},
                                                  "code": code, "test_args": {"a": 1, "b": 2}})
    assert r.status_code == 201 and r.json()["revision"] == 1
    r = await api.client.get("/api/tools")
    assert any(t["name"] == "adder" for t in r.json())
    r = await api.client.get("/api/tools/adder")
    assert r.json()["source"] == code
    r = await api.client.post("/api/tools/adder/call", json={"args": {"a": 40, "b": 2}})
    assert r.status_code == 200 and r.json()["ok"] and r.json()["value"] == {"sum": 42}
    r = await api.client.get("/api/tools/adder/health")
    assert "adder (revision 1): enabled" in r.json()["report"]
    r = await api.client.post("/api/tools/adder/disable", json={"reason": "testing"})
    assert r.status_code == 200
    r = await api.client.post("/api/tools/adder/call", json={"args": {}})
    assert r.status_code == 409
    r = await api.client.post("/api/tools/adder/enable")
    assert r.status_code == 200
    r = await api.client.delete("/api/tools/adder")
    assert r.status_code == 200
    r = await api.client.get("/api/tools/adder")
    assert r.status_code == 404
    r = await api.client.post("/api/tools", json={"name": "Bad Name", "description": "", "code": "default=1"})
    assert r.status_code == 400


async def test_exec_endpoint(api):
    r = await api.client.post("/api/exec", json={"code": "print('out')\ndefault = lambda args: args['n'] * 3", "args": {"n": 5}})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] and body["value"] == 15 and "out" in body["logs"]
    r = await api.client.post("/api/exec", json={"code": "def broken(:"})
    assert r.status_code == 200 and r.json()["ok"] is False and "syntax error" in r.json()["error"]


async def test_background_run_via_api(api):
    r = await api.client.post("/api/tools", json={"name": "sleeper", "description": "sleeps", "code":
                                                  "import time\ndef default(args):\n    time.sleep(30)\n    return 'done'"})
    assert r.status_code == 201
    r = await api.client.post("/api/tools/sleeper/start", json={"args": {}})
    assert r.status_code == 202
    rid = r.json()["run"]
    r = await api.client.get("/api/runs")
    assert any(x["id"] == rid and x["status"] == "running" for x in r.json())
    r = await api.client.get(f"/api/runs/{rid}")
    assert "sleeper" in r.json()["summary"] and ("running" in r.json()["summary"] or "installing" in r.json()["summary"])
    r = await api.client.post(f"/api/runs/{rid}/kill")
    assert r.status_code == 200
    run = api.seven.state.get_run(rid)
    assert run["status"] == "done" and run["ok"] is False and run["error"] == "killed"


async def test_logs_endpoint(api):
    api.model.push(reply("logged answer"))
    await api.client.post("/api/agents/seven/messages", json={"text": "log me"})
    assert await until(lambda: any(m["message"].get("role") == "assistant" for m in api.seven.state.transcript("seven")))
    r = await api.client.get("/api/logs", params={"grep": "turn", "tail": 50})
    assert r.status_code == 200
    msgs = [x["msg"] for x in r.json()]
    assert "turn started" in msgs and "turn finished" in msgs
    r = await api.client.get("/api/logs", params={"agent": "seven", "level": "warn"})
    assert all(x["level"] in ("warn", "error") for x in r.json())


async def test_events_sse_route_and_bus(api):
    def route_paths(app) -> set:
        paths, stack = set(), list(app.routes)
        while stack:
            r = stack.pop()
            if hasattr(r, "path"):
                paths.add(r.path)
            stack.extend(getattr(getattr(r, "original_router", None), "routes", []) or [])
        return paths

    assert "/api/events" in route_paths(api.app)
    q = api.seven.subscribe()
    api.model.push(reply("streamed"))
    r = await api.client.post("/api/agents/seven/messages", json={"text": "stream test"})
    assert r.status_code == 202
    seen = []
    for _ in range(100):
        try:
            seen.append(await asyncio.wait_for(q.get(), timeout=5))
        except TimeoutError:
            break
        if any(e["type"] == "answer" for e in seen):
            break
    api.seven.unsubscribe(q)
    types = {e["type"] for e in seen}
    assert "message" in types and "answer" in types
    assert all(e.get("agent") == "seven" for e in seen)


async def test_mail_jobs_skills_memory_endpoints(api):
    c = api.client
    r = await c.post("/api/agents/seven/messages", json={"text": "note to self"})
    assert r.status_code == 202
    r = await c.get("/api/agents/seven/inbox")
    assert r.status_code == 200
    r = await c.get("/api/agents/seven/outbox")
    assert r.status_code == 200 and isinstance(r.json(), list)
    r = await c.post("/api/agents/supervisor/messages", json={"text": "status"})
    assert r.status_code == 202 and "queued" in r.json()
    assert await until(lambda: c.get("/api/agents/supervisor/inbox").json() if False else api.seven.state.pending("supervisor") == [])
    r = await c.get("/api/agents/supervisor/outbox")
    assert r.status_code == 200
    r = await c.post("/api/agents/supervisor/stop", json={})
    assert r.status_code == 409
    r = await c.get("/api/jobs")
    assert r.status_code == 200 and r.json() == []
    r = await c.post("/api/jobs", json={"kind": "task", "task": "t"})
    assert r.status_code == 201
    jid = r.json()["id"]
    r = await c.post(f"/api/jobs/{jid}/stop", json={"reason": "test"})
    assert r.status_code == 200
    r = await c.post("/api/jobs", json={"kind": "task", "task": "t", "agent": "seven"})
    assert r.status_code == 409 and "never a job target" in r.json()["detail"]
    r = await c.post("/api/tools", json={"name": "adder", "description": "d", "code": "def default(a):\n    return a['x'] + 1"})
    assert r.status_code == 201
    r = await c.post("/api/skills", json={"name": "math", "description": "m", "tools": ["adder"]})
    assert r.status_code == 201
    r = await c.post("/api/skills", json={"name": "bad", "description": "m", "tools": ["nope"]})
    assert r.status_code == 400
    r = await c.delete("/api/tools/adder")
    assert r.status_code == 409 and "used by skill(s) math" in r.json()["detail"]
    r = await c.post("/api/skills/math/load", params={"agent": "seven"})
    assert r.status_code == 200
    assert "math" in api.seven.state.get_agent("seven")["loaded_skills"]
    r = await c.get("/api/tools/adder")
    assert r.json()["used_by_skills"] == ["math"]
    r = await c.post("/api/exec", json={"code": "default = lambda a: 'y' * 3000"})
    assert r.json()["ok"]
    r = await c.get("/api/memory")
    assert r.status_code == 200
