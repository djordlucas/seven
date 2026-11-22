from seven.core.state import State
from seven.tools import TOOL_NAME, ToolStore


def test_save_get_revision(tmp_path):
    st = State(tmp_path / "db.sqlite")
    store = ToolStore(st, tmp_path / "tools")
    m1 = store.save(name="adder", description="adds", parameters={"type": "object"}, deps={}, packages=[],
                    source="default = lambda args: args['a'] + args['b']")
    assert m1["revision"] == 1
    m2 = store.save(name="adder", description="adds v2", parameters={"type": "object"}, deps={}, packages=[],
                    source="default = lambda args: args['a'] + args['b'] + 1")
    assert m2["revision"] == 2
    t = store.get("adder")
    assert "b'] + 1" in t["source"]
    assert (tmp_path / "tools" / "adder" / "r2.py").read_text() == t["source"]
    assert t["file"].endswith("r2.py")
    st.close()


def test_disable_enable_remove(tmp_path):
    st = State(tmp_path / "db.sqlite")
    store = ToolStore(st, tmp_path / "tools")
    store.save(name="x", description="d", parameters={}, deps={}, packages=[], source="default = 1", timeout_ms=1234)
    assert store.set_disabled("x", "broken")
    assert store.get("x")["meta"]["disabled"]["reason"] == "broken"
    assert store.get("x")["meta"]["timeout_ms"] == 1234
    assert store.set_disabled("x", None)
    assert "disabled" not in store.get("x")["meta"]
    assert store.remove("x")
    assert store.get("x") is None
    assert not (tmp_path / "tools" / "x").exists()
    assert not store.remove("nope")
    st.close()


def test_history_keeps_100(tmp_path):
    st = State(tmp_path / "db.sqlite")
    store = ToolStore(st, tmp_path / "tools")
    store.save(name="x", description="d", parameters={}, deps={}, packages=[], source="default = 1")
    for i in range(120):
        store.record_run("x", {"at": f"2026-01-01T00:00:{i:02d}Z", "revision": 1, "agent": "seven",
                               "mode": "sync", "ok": i % 2 == 0, "duration_ms": i, "error": None if i % 2 == 0 else "bad"})
    h = store.history("x")
    assert len(h) == 100
    assert h[0]["duration_ms"] == 20 and h[-1]["duration_ms"] == 119
    st.close()


def test_tool_name():
    assert TOOL_NAME.match("read_files")
    assert not TOOL_NAME.match("ReadFiles")
    assert not TOOL_NAME.match("1x")
