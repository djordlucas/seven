import time

from seven.core.state import ROOT_ID, State


def test_root_agent_created(tmp_path):
    st = State(tmp_path / ".seven" / "seven.db")
    root = st.get_agent(ROOT_ID)
    assert root and root["mode"] == "interactive" and root["status"] == "idle"
    st.close()


def test_agent_crud_and_messages(tmp_path):
    st = State(tmp_path / "db.sqlite")
    a = st.create_agent(name="researcher", parent=ROOT_ID, mode="request")
    assert a["id"] == "a1"
    st.append_message(a["id"], {"role": "user", "content": "hi"})
    st.append_message(a["id"], {"role": "assistant", "content": "hello"})
    hist = st.history(a["id"])
    assert [m["message"]["content"] for m in hist] == ["hi", "hello"]
    st.update_agent(a["id"], status="done", result="done!")
    assert st.get_agent("a1")["result"] == "done!"
    st.clear_conversation(a["id"])
    assert st.history(a["id"]) == []
    st.close()


def test_compaction_boundary(tmp_path):
    st = State(tmp_path / "db.sqlite")
    for i in range(5):
        st.append_message(ROOT_ID, {"role": "user", "content": f"m{i}"})
    st.compact(ROOT_ID, "summary", 3)
    assert [m["message"]["content"] for m in st.history(ROOT_ID)] == ["m3", "m4"]
    assert st.transcript_count(ROOT_ID) == 5
    assert st.get_agent(ROOT_ID)["summary"] == "summary"
    st.close()


def test_inbox(tmp_path):
    st = State(tmp_path / "db.sqlite")
    st.create_agent(name="w", parent=ROOT_ID, mode="continuous")
    i1 = st.enqueue("a1", sender=ROOT_ID, kind="task", text="do it")
    i2 = st.enqueue("a1", sender="user", kind="message", text="note")
    pending = st.pending("a1")
    assert [p["id"] for p in pending] == [i1, i2]
    assert [p["id"] for p in st.pending("a1", kind="message")] == [i2]
    st.mark_delivered(i1)
    assert [p["id"] for p in st.pending("a1")] == [i2]
    st.close()


def test_runs(tmp_path):
    st = State(tmp_path / "db.sqlite")
    rid = st.insert_run(ROOT_ID, "run_python")
    assert rid == "r1"
    st.finish_run(rid, {"ok": True, "value": {"x": 1}, "error": None, "logs": ["a", "b"], "duration_ms": 12})
    run = st.get_run(rid)
    assert run["status"] == "done" and run["ok"] and run["value"] == {"x": 1} and run["logs"] == ["a", "b"]
    st.mark_run_checked(rid)
    assert st.get_run(rid)["checked"]
    r2 = st.insert_run(ROOT_ID, "t")
    assert st.mark_lost_runs() == 1
    assert st.get_run(r2)["status"] == "lost"
    st.close()


def test_lease(tmp_path):
    st = State(tmp_path / "db.sqlite")
    assert st.acquire_lease() is None
    assert "another seven" in (st.acquire_lease() or "")
    st.release_lease()
    assert st.acquire_lease() is None
    st.close()
    st2 = State(tmp_path / "db.sqlite")
    hb = int(time.time() * 1000) - 60_000
    st2._exec("UPDATE lease SET heartbeat_at = ? WHERE id = 1", (hb,))
    assert st2.acquire_lease() is None
    st2.close()
