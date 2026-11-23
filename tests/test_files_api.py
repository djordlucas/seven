"""Tests for the workspace file manager API (/api/files/*)."""

from __future__ import annotations

from tests.test_api import api  # noqa: F401  (reuse the fixture)


async def test_list_root(api):
    r = await api.client.get("/api/files/list")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "dir" and body["path"] == "" and isinstance(body["entries"], list)


async def test_write_read_list_rename_delete_file(api):
    r = await api.client.put("/api/files/write", json={"path": "notes.md", "content": "# hi\n"})
    assert r.status_code == 200 and r.json()["size"] == 5

    r = await api.client.get("/api/files/read", params={"rel": "notes.md"})
    assert r.status_code == 200
    body = r.json()
    assert body["content"] == "# hi\n" and body["binary"] is False and body["truncated"] is False

    r = await api.client.get("/api/files/list")
    names = [e["name"] for e in r.json()["entries"]]
    assert "notes.md" in names

    r = await api.client.post("/api/files/rename", json={"src": "notes.md", "dst": "done.md"})
    assert r.status_code == 200
    r = await api.client.get("/api/files/read", params={"rel": "done.md"})
    assert r.json()["content"] == "# hi\n"

    r = await api.client.delete("/api/files", params={"rel": "done.md"})
    assert r.status_code == 200
    r = await api.client.get("/api/files/read", params={"rel": "done.md"})
    assert r.status_code == 404


async def test_mkdir_nested_write_and_recursive_delete(api):
    r = await api.client.post("/api/files/mkdir", json={"path": "docs/sub"})
    assert r.status_code == 200
    r = await api.client.post("/api/files/mkdir", json={"path": "docs/sub"})
    assert r.status_code == 409

    r = await api.client.put("/api/files/write", json={"path": "docs/sub/a.txt", "content": "x"})
    assert r.status_code == 200

    # non-empty dir refuses a plain delete
    r = await api.client.delete("/api/files", params={"rel": "docs"})
    assert r.status_code == 409
    r = await api.client.delete("/api/files", params={"rel": "docs", "recursive": "true"})
    assert r.status_code == 200
    r = await api.client.get("/api/files/list", params={"rel": "docs"})
    assert r.status_code == 404


async def test_upload_download_binary(api):
    r = await api.client.post("/api/files/mkdir", json={"path": "uploads"})
    assert r.status_code == 200

    r = await api.client.post("/api/files/upload", params={"rel": "uploads/pic.png"}, content=b"\x89PNG\r\n\x1a\n\x00binary")
    assert r.status_code == 200 and r.json() == {"path": "uploads/pic.png", "size": len(b"\x89PNG\r\n\x1a\n\x00binary")}

    r = await api.client.get("/api/files/read", params={"rel": "uploads/pic.png"})
    body = r.json()
    assert body["binary"] is True and body["content"] is None

    r = await api.client.get("/api/files/download", params={"rel": "uploads/pic.png"})
    assert r.status_code == 200 and r.content == b"\x89PNG\r\n\x1a\n\x00binary"

    # text upload reads back as text
    r = await api.client.post("/api/files/upload", params={"rel": "uploads/hello.txt"}, content=b"hello there")
    assert r.status_code == 200
    r = await api.client.get("/api/files/read", params={"rel": "uploads/hello.txt"})
    assert r.json()["content"] == "hello there" and r.json()["binary"] is False


async def test_path_traversal_refused(api):
    for params in ({"rel": "../secret.txt"}, {"rel": "a/../../x"}):
        r = await api.client.get("/api/files/read", params=params)
        assert r.status_code == 400, params
    r = await api.client.put("/api/files/write", json={"path": "../evil.txt", "content": "x"})
    assert r.status_code == 400
    r = await api.client.post("/api/files/upload", params={"rel": "../evil.bin"}, content=b"x")
    assert r.status_code == 400
    r = await api.client.delete("/api/files", params={"rel": ".."})
    assert r.status_code in (400, 404)


async def test_root_delete_refused(api):
    r = await api.client.delete("/api/files", params={"rel": "", "recursive": "true"})
    assert r.status_code == 400
