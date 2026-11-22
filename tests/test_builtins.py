import json

from seven.builtins.shared import BuiltinContext, disabled_error, format_run
from seven.builtins.sql import resolve_db, sql_builtins
from seven.runner import RunResult


def make_ctx(env, agent_id="seven") -> BuiltinContext:
    return BuiltinContext(agent_id=agent_id, runner=env.runner, store=env.store, runs=env.runs,
                          supervisor=env.sup, workspace=str(env.cfg.workspace), state_db=env.state.path,
                          abort=None, log=env.log.child(agent=agent_id))


async def test_sql_create_insert_select(started_env):
    env = started_env
    ctx = make_ctx(env)
    sql = sql_builtins()[0]
    out = await sql.run({"db": "data/app.db", "query": "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); CREATE INDEX i ON t(name);"}, ctx)
    assert out == "ok"
    out = await sql.run({"db": "data/app.db", "query": "INSERT INTO t (name) VALUES (?)", "params": ["seven"]}, ctx)
    r = json.loads(out)
    assert r["changes"] == 1 and r["lastInsertRowid"] == 1
    out = await sql.run({"db": "data/app.db", "query": "SELECT * FROM t WHERE name = :n", "named": {"n": "seven"}}, ctx)
    rows = json.loads(out)
    assert rows == [{"id": 1, "name": "seven"}]


async def test_sql_guards(started_env):
    env = started_env
    ctx = make_ctx(env)
    sql = sql_builtins()[0]
    out = await sql.run({"db": "../outside.db", "query": "SELECT 1"}, ctx)
    assert out.startswith("error:") and "outside the workspace" in out
    out = await sql.run({"db": ".seven/seven.db", "query": "SELECT 1"}, ctx)
    assert "seven's own database" in out
    out = await sql.run({"db": "data/x.db", "query": "SELECT * FROM missing"}, ctx)
    assert out.startswith("error:")


def test_resolve_db(tmp_path):
    ws = str(tmp_path)
    assert resolve_db(ws, str(tmp_path / ".seven" / "seven.db"), "data/a.db").endswith("data/a.db")
    assert resolve_db(ws, str(tmp_path / ".seven" / "seven.db"), "../x.db").startswith("error:")
    assert resolve_db(ws, str(tmp_path / ".seven" / "seven.db"), ".seven/seven.db").startswith("error:")


def test_disabled_error_and_format_run():
    tool = {"meta": {"name": "x", "disabled": {"at": "t", "reason": "bad"}}}
    assert 'disabled (bad)' in disabled_error(tool)
    assert format_run(RunResult(ok=True, value={"a": 1}, logs=["line"])).startswith('{\n  "a": 1\n}')
    assert "error: nope" in format_run(RunResult(ok=False, error="nope"))


async def test_disable_tool_refuses_calls(started_env):
    env = started_env
    env.store.save(name="t1", description="d", parameters={}, deps={}, packages=[], source="default = 1")
    ctx = make_ctx(env)
    from seven.builtins import builtins
    assert await builtins()["disable_tool"].run({"name": "t1", "reason": "misbehaving"}, ctx) == "disabled t1"
    assert "disabled (misbehaving)" in disabled_error(env.store.get("t1"))
    assert await builtins()["enable_tool"].run({"name": "t1"}, ctx) == "enabled t1"
    assert env.store.get("t1")["meta"].get("disabled") is None
