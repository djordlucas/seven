"""Generated libraries: CRUD, per-revision pinning in tool bundles, rebundle."""

from __future__ import annotations

import pytest

from tests.test_api import api  # noqa: F401  (reuse the fixture)

LIB_V1 = "def double(x):\n    return x * 2\n"
LIB_V2 = "def double(x):\n    return x * 100\n"
LIB_BROKEN = "def double(x):\n    raise RuntimeError('boom')\n"
TOOL_USING_LIB = (
    "import mathx\n\n"
    "def default(args):\n"
    "    return {'v': mathx.double(args.get('x', 1))}\n"
)


async def _define_lib(client, code=LIB_V1, name="mathx"):
    return await client.post("/api/libs", json={"name": name, "description": "test lib", "code": code})


async def _define_tool_with_lib(client, test_args=None):
    return await client.post("/api/tools", json={
        "name": "uses_mathx",
        "description": "tool that imports the mathx library",
        "parameters": {"type": "object"},
        "code": TOOL_USING_LIB,
        "libs": ["mathx"],
        "test_args": test_args if test_args is not None else {"x": 3},
    })


async def test_lib_crud_and_revisions(api):
    r = await _define_lib(api.client)
    assert r.status_code == 201 and r.json()["revision"] == 1
    r = await _define_lib(api.client, code=LIB_V2)
    assert r.status_code == 201 and r.json()["revision"] == 2

    r = await api.client.get("/api/libs")
    assert [l["name"] for l in r.json()] == ["mathx"] and r.json()[0]["revision"] == 2
    r = await api.client.get("/api/libs/mathx")
    assert r.json()["source"] == LIB_V2 and r.json()["dependents"] == []

    # both revision files are materialized and loadable
    m1 = api.seven.libstore.file_for("mathx", 1)
    m2 = api.seven.libstore.file_for("mathx", 2)
    assert m1.read_text() == LIB_V1 and m2.read_text() == LIB_V2

    r = await api.client.post("/api/libs", json={"name": "bad name", "code": "x=1"})
    assert r.status_code == 400
    r = await api.client.post("/api/libs", json={"name": "syn", "code": "def broken(:"})
    assert r.status_code == 400


async def test_tool_bundles_and_pins_library(api):
    await _define_lib(api.client)
    r = await _define_tool_with_lib(api.client)
    assert r.status_code == 201, r.text
    meta = r.json()
    assert meta["libs"] == [{"name": "mathx", "revision": 1}]
    assert meta["test_args"] == {"x": 3}

    # the tool runs against the pinned revision
    r = await api.client.post("/api/tools/uses_mathx/call", json={"args": {"x": 5}})
    assert r.status_code == 200 and r.json()["ok"] and r.json()["value"] == {"v": 10}


async def test_library_change_does_not_break_pinned_tool(api):
    await _define_lib(api.client, code=LIB_V1)
    await _define_tool_with_lib(api.client)

    # library moves on to revision 2 (double now *100)
    await _define_lib(api.client, code=LIB_V2)
    r = await api.client.post("/api/tools/uses_mathx/call", json={"args": {"x": 5}})
    assert r.json()["value"] == {"v": 10}, "pinned tool must keep the old revision"

    # rebundle adopts r2 only after a passing trial
    r = await api.client.post("/api/tools/uses_mathx/rebundle", json={})
    assert r.status_code == 200 and r.json()["updated"] is True
    assert r.json()["to"] == [{"name": "mathx", "revision": 2}]
    r = await api.client.post("/api/tools/uses_mathx/call", json={"args": {"x": 5}})
    assert r.json()["value"] == {"v": 500}


async def test_rebundle_refused_when_trial_fails(api):
    await _define_lib(api.client, code=LIB_V1)
    await _define_tool_with_lib(api.client)
    await _define_lib(api.client, code=LIB_BROKEN)  # r2 raises

    r = await api.client.post("/api/tools/uses_mathx/rebundle", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["updated"] is False and body["trial"]["ok"] is False
    # pin unchanged, tool still works on r1
    r = await api.client.get("/api/tools/uses_mathx")
    assert r.json()["meta"]["libs"] == [{"name": "mathx", "revision": 1}]
    r = await api.client.post("/api/tools/uses_mathx/call", json={"args": {"x": 5}})
    assert r.json()["value"] == {"v": 10}


async def test_explicit_pin_and_revalidate_and_delete_guard(api):
    await _define_lib(api.client, code=LIB_V1)
    await _define_lib(api.client, code=LIB_V2)
    r = await api.client.post("/api/tools", json={
        "name": "pinned", "description": "d", "parameters": {"type": "object"},
        "code": TOOL_USING_LIB, "libs": ["mathx@1"], "test_args": {"x": 1},
    })
    assert r.status_code == 201 and r.json()["libs"] == [{"name": "mathx", "revision": 1}]

    # bad specs refused
    r = await api.client.post("/api/tools", json={
        "name": "t2", "description": "d", "parameters": {"type": "object"},
        "code": "def default(a): return 1", "libs": ["../mathx"],
    })
    assert r.status_code == 400
    r = await api.client.post("/api/tools", json={
        "name": "t2", "description": "d", "parameters": {"type": "object"},
        "code": "def default(a): return 1", "libs": ["nosuchlib"],
    })
    assert r.status_code == 400

    # delete is refused while bundled
    r = await api.client.delete("/api/libs/mathx")
    assert r.status_code == 409 and "pinned" in r.text
    # revalidate moves the dependent to the latest revision
    r = await api.client.post("/api/libs/mathx/revalidate")
    assert r.status_code == 200
    results = r.json()["results"]
    assert results and results[0]["tool"] == "pinned" and results[0]["updated"] is True
    r = await api.client.get("/api/tools/pinned")
    assert r.json()["meta"]["libs"] == [{"name": "mathx", "revision": 2}]

    # force delete strips the pin from dependents
    r = await api.client.delete("/api/libs/mathx?force=true")
    assert r.status_code == 200
    r = await api.client.get("/api/tools/pinned")
    assert r.json()["meta"]["libs"] == []
