
from seven.core.log import Logger
from seven.execution.runner import Runner, scan_imports


def make_runner(tmp_path, host=None) -> Runner:
    home = tmp_path / ".seven"
    return Runner(home=home, cwd=str(tmp_path), timeout_ms=8000, memory_mb=512,
                  host=host or {}, log=Logger(level="debug"))


def write_tool(tmp_path, code: str, name: str = "tool.py"):
    p = tmp_path / name
    p.write_text(code)
    return p


async def test_run_value(tmp_path):
    r = make_runner(tmp_path)
    f = write_tool(tmp_path, "default = lambda args: {'doubled': args['n'] * 2}")
    res = await r.run_file(f, {"n": 21})
    assert res.ok and res.value == {"doubled": 42}
    await r.shutdown()


async def test_run_async_default_and_output(tmp_path):
    r = make_runner(tmp_path)
    f = write_tool(tmp_path, """
import asyncio
print("hello out")
import sys; print("oops", file=sys.stderr)
async def default(args):
    await asyncio.sleep(0.01)
    return "done:" + args.get("x", "")
""")
    res = await r.run_file(f, {"x": "!"})
    assert res.ok and res.value == "done:!"
    assert "hello out" in res.logs
    assert "[stderr] oops" in res.logs
    await r.shutdown()


async def test_run_non_callable_default(tmp_path):
    r = make_runner(tmp_path)
    f = write_tool(tmp_path, "default = 42")
    res = await r.run_file(f)
    assert res.ok and res.value == 42
    await r.shutdown()


async def test_run_error(tmp_path):
    r = make_runner(tmp_path)
    f = write_tool(tmp_path, "def default(args):\n    raise ValueError('boom')\n")
    res = await r.run_file(f)
    assert not res.ok and "ValueError: boom" in res.error
    await r.shutdown()


async def test_run_non_serializable(tmp_path):
    r = make_runner(tmp_path)
    f = write_tool(tmp_path, "default = object()")
    res = await r.run_file(f)
    assert not res.ok and res.error
    await r.shutdown()


async def test_run_timeout(tmp_path):
    r = make_runner(tmp_path)
    f = write_tool(tmp_path, "import time\ndef default(args):\n    time.sleep(30)\n    return 'late'\n")
    res = await r.run_file(f, timeout_ms=500)
    assert not res.ok and res.error.startswith("timed out after 500ms")
    await r.shutdown()


async def test_run_kill(tmp_path):
    r = make_runner(tmp_path)
    f = write_tool(tmp_path, "import time\ndef default(args):\n    time.sleep(30)\n")
    h = r.start_file(f)
    import asyncio
    await asyncio.sleep(0.5)
    h.kill()
    res = await h.done
    assert not res.ok and res.error == "killed"
    await r.shutdown()


async def test_run_early_exit(tmp_path):
    r = make_runner(tmp_path)
    f = write_tool(tmp_path, "import os, sys\nprint('bye', file=sys.stderr)\nos._exit(3)\n")
    res = await r.run_file(f)
    assert not res.ok and "process exited (code 3)" in res.error
    assert any("[stderr] bye" in l for l in res.logs)
    await r.shutdown()


async def test_eval_syntax_error_no_spawn(tmp_path):
    r = make_runner(tmp_path)
    h = r.start_eval("def broken(:\n")
    res = await h.done
    assert not res.ok and "syntax error" in res.error
    await r.shutdown()


async def test_eval_ok(tmp_path):
    r = make_runner(tmp_path)
    h = r.start_eval("default = lambda args: args['a'] + 1", args={"a": 1})
    res = await h.done
    assert res.ok and res.value == 2
    await r.shutdown()


async def test_host_call(tmp_path):
    async def chat(prompt, system=None):
        return f"echo:{prompt}"
    r = make_runner(tmp_path, host={"llm": {"chat": chat}})
    f = write_tool(tmp_path, "def default(args):\n    return seven.llm.chat('hi')\n")
    res = await r.run_file(f)
    assert res.ok and res.value == "echo:hi"
    await r.shutdown()


async def test_host_call_missing(tmp_path):
    r = make_runner(tmp_path, host={})
    f = write_tool(tmp_path, "def default(args):\n    return seven.llm.chat('hi')\n")
    res = await r.run_file(f)
    assert not res.ok and "seven.llm.chat:" in res.error
    await r.shutdown()


async def test_seven_db(tmp_path):
    r = make_runner(tmp_path)
    f = write_tool(tmp_path, """
def default(args):
    db = seven.db('data/test.db')
    db.execute('CREATE TABLE IF NOT EXISTS t (x INTEGER)')
    db.execute('INSERT INTO t VALUES (7)')
    db.commit()
    return db.execute('SELECT x FROM t').fetchone()[0]
""")
    res = await r.run_file(f)
    assert res.ok and res.value == 7
    assert (tmp_path / "data" / "test.db").exists()
    await r.shutdown()


def test_scan_imports():
    src = """
import os, json
import requests
from pathlib import Path
from . import local
import importlib
x = importlib.import_module("httpx")
"""
    names = scan_imports(src)
    assert names == {"os", "json", "requests", "pathlib", "importlib", "httpx"}
