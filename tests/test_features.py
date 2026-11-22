
from seven.agent import Agent, AgentDeps
from seven.core.state import ROOT_ID
from seven.tools.builtins import builtins
from seven.tools.builtins.shared import BuiltinContext
from tests.conftest import until
from tests.fake_model import reply, tc


def make_ctx(env, agent_id="seven") -> BuiltinContext:
    return BuiltinContext(agent_id=agent_id, runner=env.runner, store=env.store, runs=env.runs,
                          supervisor=env.sup, state=env.state, workspace=str(env.cfg.workspace), state_db=env.state.path,
                          abort=None, log=env.log.child(agent=agent_id))


def make_agent(env, agent_id=ROOT_ID, **over) -> Agent:
    deps = AgentDeps(state=env.state, store=env.store, runner=env.runner, runs=env.runs, model=env.model,
                     supervisor=env.sup, workspace=str(env.cfg.workspace), max_steps=10, context_tokens=128_000,
                     log=env.log.child(agent=agent_id), **over)
    return Agent(deps, agent_id)


# ── R2: mail ──

def test_send_writes_inbox_and_outbox(started_env):
    env = started_env
    env.state.send("seven", "supervisor", "message", "status")
    assert env.state.pending("supervisor")[0]["text"] == "status"
    out = env.state.list_outbox("seven")
    assert out[0]["recipient"] == "supervisor" and out[0]["delivered_at"] is None
    env.state.mark_delivered(env.state.pending("supervisor")[0]["id"])
    assert env.state.list_outbox("seven")[0]["delivered_at"] is not None


async def test_supervisor_peer_and_commands(started_env):
    env = started_env
    sup = env.state.get_agent("supervisor")
    assert sup and sup["mode"] == "supervisor"
    assert "cannot be stopped" in env.sup.stop("supervisor", "user")
    env.state.send("seven", "supervisor", "message", "jobs")
    assert await until(lambda: env.state.pending("supervisor") == [])
    out = env.state.list_outbox("supervisor")
    assert out and "no jobs" in out[0]["text"]
    env.state.send("seven", "supervisor", "message", "bogus command")
    assert await until(lambda: any("unknown command" in (o["text"] or "") for o in env.state.list_outbox("supervisor")))


async def test_list_inbox_outbox_builtins(started_env):
    env = started_env
    env.state.send("user", "seven", "message", "hello")
    ctx = make_ctx(env)
    inbox = await builtins()["list_inbox"].run({}, ctx)
    assert "hello" in inbox and "PENDING" in inbox
    out = await builtins()["list_outbox"].run({}, ctx)
    assert "nothing sent yet" in out
    env.sup.send("seven", "supervisor", "hi sup")
    out = await builtins()["list_outbox"].run({}, ctx)
    assert "supervisor" in out


# ── R1: jobs ──

async def test_task_job_completes_and_mails_creator(started_env):
    env = started_env
    env.model.push(reply("task answer"))
    job = env.sup.start_job("seven", "task", {"task": "do the thing"}, agent=None)
    assert isinstance(job, dict) and job["kind"] == "task"
    assert await until(lambda: env.state.get_job(job["id"])["status"] == "done", timeout=15)
    assert env.state.get_job(job["id"])["result"] == "task answer"
    msgs = [m["text"] for m in env.state.pending("seven", kind="message")]
    assert any("job j1 done" in m for m in msgs)


async def test_goal_job_checks_and_finishes(started_env):
    env = started_env
    env.model.push(reply("working on it"))
    env.model.push(reply("YES\ngoal attained, summary here"))
    job = env.sup.start_job("user", "goal", {"goal": "write the report", "max_turns": 5}, agent=None)
    assert await until(lambda: env.state.get_job(job["id"])["status"] == "done", timeout=15)
    assert "goal attained" in env.state.get_job(job["id"])["result"]


async def test_goal_job_max_turns_fails(started_env):
    env = started_env
    for _ in range(3):
        env.model.push(reply("still working"))
        env.model.push(reply("NO\nnot yet"))
    job = env.sup.start_job("user", "goal", {"goal": "impossible", "max_turns": 3}, agent=None)
    assert await until(lambda: env.state.get_job(job["id"])["status"] == "failed", timeout=20)


async def test_periodic_job_sets_next_run(started_env):
    env = started_env
    env.sup.spawn(ROOT_ID, {"name": "w", "description": "", "instructions": "", "mode": "continuous",
                            "tasks": [], "interval_s": None, "max_steps": None})
    job = env.sup.start_job("user", "periodic", {"interval_s": 60, "instructions": "tick"}, agent="a1")
    assert isinstance(job, dict)
    j = env.state.get_job(job["id"])
    assert j["status"] == "running" and (j["next_run_at"] is not None or j["queued"] == 1)
    out = env.sup.stop_job(job["id"], "user", "done testing")
    assert out.startswith("stopped")
    assert env.state.get_job(job["id"])["status"] == "stopped"


async def test_assignment_scope_refused_for_agents(started_env):
    env = started_env
    env.sup.spawn(ROOT_ID, {"name": "other", "description": "", "instructions": "", "mode": "continuous",
                            "tasks": [], "interval_s": None, "max_steps": None})
    ctx = make_ctx(env, "seven")
    out = await builtins()["start_job"].run({"kind": "task", "task": "x", "agent": "a1"}, ctx)
    assert out.startswith("error:") and "supervisor" in out
    out = await builtins()["start_job"].run({"kind": "task", "task": "x", "agent": "seven"}, ctx)
    assert out.startswith("error:")  # root is never a job target


async def test_job_persists_across_restart(started_env):
    env = started_env
    job = env.sup.start_job("user", "periodic", {"interval_s": 60, "instructions": "tick"}, agent=None)
    await env.sup.shutdown()
    env.sup2 = type(env.sup)(type(env.sup).opts if hasattr(env.sup, "opts") else None) if False else None
    from seven.agent import Supervisor, SupervisorOpts
    sup2 = Supervisor(SupervisorOpts(state=env.state, store=env.store, runner=env.runner, model=env.model,
                                     workspace=str(env.cfg.workspace), max_steps=10, context_tokens=128_000,
                                     max_agents=4, log=env.log))
    sup2.start()
    jobs = env.state.list_jobs(all=False)
    assert any(j["id"] == job["id"] and j["status"] == "running" for j in jobs)
    await sup2.shutdown()


# ── R3: memory, discovery, delegate ──

async def test_long_output_spills_and_reads_back(started_env):
    env = started_env
    env.model.push(reply(None, [tc("run_python", {"code": "default = lambda args: 'x' * 5000"})]))
    env.model.push(reply("done"))
    a = make_agent(env, spill_chars=2000, memory_dir=env.cfg.memory)
    await a.turn({"text": "big", "kind": "user"})
    tool_msg = next(m["message"] for m in env.state.history(ROOT_ID) if m["message"].get("role") == "tool")
    assert "saved to memory" in tool_msg["content"]
    oid = tool_msg["content"].split("memory ")[1].split(" ")[0]
    out = env.state.get_output(oid)
    assert out and out["chars"] == 5000 and (env.cfg.memory / f"{oid}.out").read_text() == "x" * 5000
    ctx = make_ctx(env)
    chunk = await builtins()["read_memory"].run({"id": oid, "offset": 4990, "limit": 4000}, ctx)
    assert "10 chars total" not in chunk and chunk.startswith("memory") and "x" * 10 in chunk


async def test_discovery_core_meta_revealed_and_skills(started_env):
    env = started_env
    env.store.save(name="adder", description="adds", parameters={"type": "object"}, deps={}, packages=[], source="default = lambda a: 1")
    env.state.save_skill(name="math", description="m", instructions="use math", tools=["adder"])
    a = make_agent(env, core_tools=("run_python", "define_tool"), tool_discovery=True)
    tools, _ = a.context()
    names = {t.name for t in tools}
    assert "run_python" in names and "list_tools" in names and "describe_tool" in names
    assert "sql" not in names and "adder" not in names
    ctx = make_ctx(env)
    await builtins()["describe_tool"].run({"name": "sql"}, ctx)
    await builtins()["load_skill"].run({"name": "math"}, ctx)
    names2 = {t.name for t in a.context()[0]}
    assert "sql" in names2 and "adder" in names2
    assert env.state.get_agent(ROOT_ID)["revealed_tools"] == ["sql"]
    a2 = make_agent(env, core_tools=(), tool_discovery=False)
    assert len(a2.context()[0]) == len(builtins()) + 1  # all builtins + the generated "adder"


async def test_delegate_returns_only_final_answer(started_env):
    env = started_env
    env.model.push(reply("sub-agent final answer"))
    ctx = make_ctx(env)
    out = await builtins()["delegate"].run({"task": "compute something", "instructions": "be brief"}, ctx)
    assert out == "sub-agent final answer"
    agents = env.state.list_agents()
    sub = [x for x in agents if x["description"] == "delegated task"]
    assert sub and sub[0]["status"] in ("stopped", "done")


# ── R4: skills ──

async def test_skill_crud_and_delete_protection(started_env):
    env = started_env
    env.store.save(name="adder", description="adds", parameters={}, deps={}, packages=[], source="default = lambda a: a")
    ctx = make_ctx(env)
    out = await builtins()["define_skill"].run({"name": "math", "description": "m", "tools": ["adder", "nope"]}, ctx)
    assert out.startswith("error:") and "nope" in out
    out = await builtins()["define_skill"].run({"name": "math", "description": "m", "tools": ["adder"]}, ctx)
    assert "saved skill math" in out
    out = await builtins()["delete_tool"].run({"name": "adder"}, ctx)
    assert "used by skill(s) math" in out
    out = await builtins()["define_skill"].run({"name": "math", "description": "m", "tools": []}, ctx)
    assert "saved skill math" in out
    out = await builtins()["delete_tool"].run({"name": "adder"}, ctx)
    assert out == "deleted adder"
    env.store.save(name="adder", description="adds", parameters={}, deps={}, packages=[], source="default = lambda a: a")
    await builtins()["define_skill"].run({"name": "math", "description": "m", "tools": ["adder"]}, ctx)
    await builtins()["load_skill"].run({"name": "math"}, ctx)
    assert "math" in env.state.get_agent(ROOT_ID)["loaded_skills"]
    await builtins()["delete_skill"].run({"name": "math"}, ctx)
    assert env.state.get_skill("math") is None
    assert "math" not in env.state.get_agent(ROOT_ID)["loaded_skills"]
