import asyncio

from conftest import until
from fake_model import reply

from seven.core.state import ROOT_ID


async def test_spawn_request_agent_runs_and_reports(started_env):
    env = started_env
    env.model.push(reply("task complete"))
    row = env.sup.spawn(ROOT_ID, {"name": "worker", "description": "does work", "instructions": "be brief",
                                  "mode": "request", "tasks": ["do the thing"], "interval_s": None, "max_steps": None})
    assert isinstance(row, dict) and row["id"] == "a1"
    assert await until(lambda: env.state.get_agent("a1")["status"] == "done")
    assert env.state.get_agent("a1")["result"] == "task complete"
    msgs = env.state.pending(ROOT_ID, kind="message")
    assert msgs and msgs[0]["text"].startswith("finished:")


async def test_spawn_refusals(started_env):
    env = started_env
    assert "exactly one task" in env.sup.spawn(ROOT_ID, {"name": "a", "description": "", "instructions": "",
                                                          "mode": "request", "tasks": ["1", "2"], "interval_s": None, "max_steps": None})
    assert "at least one task" in env.sup.spawn(ROOT_ID, {"name": "a", "description": "", "instructions": "",
                                                          "mode": "sequence", "tasks": [], "interval_s": None, "max_steps": None})
    assert "interval_s applies" in env.sup.spawn(ROOT_ID, {"name": "a", "description": "", "instructions": "",
                                                           "mode": "request", "tasks": ["t"], "interval_s": 5, "max_steps": None})
    assert "unknown mode" in env.sup.spawn(ROOT_ID, {"name": "a", "description": "", "instructions": "",
                                                     "mode": "weird", "tasks": [], "interval_s": None, "max_steps": None})
    env.sup.spawn(ROOT_ID, {"name": "dup", "description": "", "instructions": "", "mode": "continuous",
                            "tasks": [], "interval_s": None, "max_steps": None})
    assert 'already named "dup"' in env.sup.spawn(ROOT_ID, {"name": "dup", "description": "", "instructions": "",
                                                            "mode": "continuous", "tasks": [], "interval_s": None, "max_steps": None})


async def test_send_and_wait_message(started_env):
    env = started_env
    env.sup.spawn(ROOT_ID, {"name": "listener", "description": "", "instructions": "", "mode": "continuous",
                            "tasks": [], "interval_s": None, "max_steps": None})
    out = env.sup.send(ROOT_ID, "listener", "hello a1")
    assert out.startswith("sent to a1")
    msg = await env.sup.wait_message("a1", None, 2000)
    assert msg and msg["sender"] == ROOT_ID and msg["text"] == "hello a1"
    assert env.state.pending("a1") == []
    assert "yourself" in env.sup.send(ROOT_ID, ROOT_ID, "hi")


async def test_stop_agent(started_env):
    env = started_env
    env.sup.spawn(ROOT_ID, {"name": "c", "description": "", "instructions": "", "mode": "continuous",
                            "tasks": [], "interval_s": None, "max_steps": None})
    out = env.sup.stop("a1", ROOT_ID, "no longer needed")
    assert out.startswith("stopped a1")
    assert env.state.get_agent("a1")["status"] == "stopped"
    assert "stopped by seven" in env.state.get_agent("a1")["error"]
    assert "cannot be stopped" in env.sup.stop(ROOT_ID, "a1")
    assert "already stopped" in env.sup.stop("a1", ROOT_ID)
    msgs = env.state.pending(ROOT_ID, kind="message")
    assert any(m["text"].startswith("stopped:") for m in msgs)


async def test_user_message_to_idle_root_starts_turn(started_env):
    env = started_env
    env.model.push(reply("root says hi"))
    out = env.sup.user_message(ROOT_ID, "hello seven")
    assert out["turn_started"] is True
    assert await until(lambda: any(m["message"].get("role") == "assistant" for m in env.state.history(ROOT_ID)))
    hist = [m["message"] for m in env.state.history(ROOT_ID)]
    assert hist[-1]["content"] == "root says hi"


async def test_user_message_to_busy_root_queues(started_env):
    env = started_env
    blocker = asyncio.Event()

    async def slow_complete(*, messages, tools=None, max_tokens=None, abort=None, log=None):
        await blocker.wait()
        return reply("late")

    env.model.replies.clear()
    env.model.push(slow_complete)
    out = env.sup.user_message(ROOT_ID, "first")
    assert out["turn_started"] is True
    await asyncio.sleep(0.2)
    out2 = env.sup.user_message(ROOT_ID, "second")
    assert "queued" in out2
    blocker.set()
    assert await until(lambda: any(m["message"].get("role") == "assistant" for m in env.state.history(ROOT_ID)))
    assert len(env.state.pending(ROOT_ID, kind="message")) == 1
    env.model.push(reply("next turn"))
    env.sup.user_message(ROOT_ID, "third")
    assert await until(lambda: any(m["message"].get("content") == "[message from the user]\nsecond"
                                   for m in env.state.history(ROOT_ID)))


async def test_continuous_agent_handles_message(started_env):
    env = started_env
    env.sup.spawn(ROOT_ID, {"name": "cont", "description": "", "instructions": "", "mode": "continuous",
                            "tasks": [], "interval_s": None, "max_steps": None})
    env.model.push(reply("handled"))
    env.sup.send("user", "a1", "wake up")
    assert await until(lambda: any(m["message"].get("role") == "assistant" and m["message"].get("content") == "handled"
                                   for m in env.state.history("a1")))
    assert await until(lambda: env.state.get_agent("a1")["status"] == "idle")


async def test_resolve_by_name(started_env):
    env = started_env
    env.sup.spawn(ROOT_ID, {"name": "named", "description": "", "instructions": "", "mode": "continuous",
                            "tasks": [], "interval_s": None, "max_steps": None})
    r = env.sup.resolve("named")
    assert r["id"] == "a1"
    assert env.sup.resolve("nope") == 'no agent "nope"'
