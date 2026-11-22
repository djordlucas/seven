
from fake_model import reply, tc

from seven.agent import Agent, AgentDeps
from seven.state import ROOT_ID


def make_agent(env, agent_id=ROOT_ID, model=None) -> Agent:
    deps = AgentDeps(state=env.state, store=env.store, runner=env.runner, runs=env.runs,
                     model=model or env.model, supervisor=env.sup, workspace=str(env.cfg.workspace),
                     max_steps=10, context_tokens=128_000, log=env.log.child(agent=agent_id))
    return Agent(deps, agent_id)


async def test_turn_answers(started_env):
    env = started_env
    env.model.push(reply("hello there"))
    a = make_agent(env)
    answer = await a.turn({"text": "hi", "kind": "user"})
    assert answer == "hello there"
    hist = [m["message"] for m in env.state.history(ROOT_ID)]
    assert hist[0] == {"role": "user", "content": "hi"}
    assert hist[1]["role"] == "assistant" and hist[1]["content"] == "hello there"
    assert env.state.get_agent(ROOT_ID)["status"] == "idle"


async def test_turn_runs_tool_calls(started_env):
    env = started_env
    env.model.push(reply(None, [tc("run_python", {"code": "default = lambda args: 'pong'"})]))
    env.model.push(reply("the answer"))
    events = []
    a = make_agent(env)
    a.deps.on_event = events.append
    answer = await a.turn({"text": "ping", "kind": "user"})
    assert answer == "the answer"
    hist = [m["message"] for m in env.state.history(ROOT_ID)]
    tool_msg = next(m for m in hist if m["role"] == "tool")
    assert "pong" in tool_msg["content"]
    assert any(e["type"] == "tool_call" and e["name"] == "run_python" for e in events)
    assert any(e["type"] == "answer" for e in events)


async def test_unknown_tool_is_error_result(started_env):
    env = started_env
    env.model.push(reply(None, [tc("no_such_tool", {})]))
    env.model.push(reply("ok"))
    a = make_agent(env)
    await a.turn({"text": "x", "kind": "user"})
    tool_msg = next(m["message"] for m in env.state.history(ROOT_ID) if m["message"].get("role") == "tool")
    assert tool_msg["content"].startswith('error: no tool named "no_such_tool"')


async def test_max_steps(started_env):
    env = started_env
    for _ in range(10):
        env.model.push(reply(None, [tc("run_python", {"code": "default = 1"})]))
    a = make_agent(env)
    deps = a.deps
    deps.max_steps = 3
    answer = await a.turn({"text": "loop", "kind": "user"})
    assert answer == "Stopped after 3 steps without a final answer."


async def test_inbox_message_delivered_at_step(started_env):
    env = started_env
    env.state.enqueue(ROOT_ID, sender="user", kind="message", text="hey")
    env.model.push(reply("noted"))
    a = make_agent(env)
    await a.turn({"text": "go", "kind": "user"})
    hist = [m["message"] for m in env.state.history(ROOT_ID)]
    assert hist[1]["content"] == "[message from the user]\nhey"
    assert env.state.pending(ROOT_ID, kind="message") == []


async def test_repair_closes_cut_tool_calls(started_env):
    env = started_env
    a = make_agent(env)
    env.state.append_message(ROOT_ID, {"role": "user", "content": "go"})
    env.state.append_message(ROOT_ID, {"role": "assistant", "content": None,
                                       "tool_calls": [{"id": "c1", "type": "function",
                                                       "function": {"name": "run_python", "arguments": "{}"}}]})
    a.repair()
    last = env.state.history(ROOT_ID)[-1]["message"]
    assert last["role"] == "tool" and "interrupted" in last["content"]
    assert a.needs_resume()


async def test_compaction_at_threshold(started_env):
    env = started_env
    env.state.append_message(ROOT_ID, {"role": "user", "content": "old " * 500})
    for i in range(4):
        env.state.append_message(ROOT_ID, {"role": "user", "content": f"more {i} " * 300})
    env.model.push(reply("final answer"))
    a = make_agent(env)
    a.deps.context_tokens = 400
    a.estimator.chars_per_token = 1.0
    await a.turn({"text": "trigger", "kind": "user"})
    row = env.state.get_agent(ROOT_ID)
    assert row["summary"] == "summary of earlier messages"
    assert row["compactions"] == 1
    assert row["context_from"] > 0
    hist = [m["message"] for m in env.state.history(ROOT_ID)]
    assert all("old " not in (m.get("content") or "") for m in hist)


async def test_define_and_call_generated_tool(started_env):
    env = started_env
    env.model.push(reply(None, [tc("define_tool", {
        "name": "adder", "description": "adds numbers", "parameters": {"type": "object"},
        "code": "def default(args):\n    return args['a'] + args['b']\n", "test_args": {"a": 2, "b": 3}})]))
    env.model.push(reply(None, [tc("adder", {"a": 10, "b": 5})]))
    env.model.push(reply("15"))
    a = make_agent(env)
    answer = await a.turn({"text": "add", "kind": "user"})
    assert answer == "15"
    tool = env.store.get("adder")
    assert tool and tool["meta"]["revision"] == 1
    results = [m["message"]["content"] for m in env.state.history(ROOT_ID) if m["message"]["role"] == "tool"]
    assert "saved adder (revision 1)" in results[0]
    assert "15" in results[1]
    health = env.store.history("adder")
    assert len(health) == 1 and health[0]["ok"]
