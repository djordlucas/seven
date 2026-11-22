"""Generated tools: the part of seven that seven writes. Shared by every agent.

A tool's definition, source and run history are rows in the state database.
Each revision's source is also written to <home>/tools/<name>/r<revision>.py,
the file the runner imports; the database is the record, the file is derived.
The store is read every model step, so a tool defined mid-turn is callable on
the next step — by any agent.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

from ..core.state import State

TOOL_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SKILL_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
KEEP_RUNS = 100


class ToolInUseError(Exception):
    def __init__(self, name: str, skills: list[str]):
        self.name = name
        self.skills = skills
        super().__init__(f'tool "{name}" is used by skill(s) {", ".join(skills)} — change the skill first (define_skill without {name}) or delete_skill')


def _meta_from_row(r) -> dict:
    d = dict(r)
    meta = {
        "name": d["name"], "description": d["description"], "parameters": json.loads(d["parameters"]),
        "deps": json.loads(d["deps"]), "packages": json.loads(d["packages"]),
        "created_at": d["created_at"], "updated_at": d["updated_at"], "revision": int(d["revision"]),
    }
    if d["timeout_ms"] is not None:
        meta["timeout_ms"] = int(d["timeout_ms"])
    if d["disabled_at"] is not None:
        meta["disabled"] = {"at": d["disabled_at"], "reason": d["disabled_reason"]}
    return meta


class ToolStore:
    def __init__(self, state: State, dir: str | Path):
        self.state = state
        self.dir = Path(dir)

    @property
    def is_open(self) -> bool:
        return self.state.is_open

    def list(self) -> list[dict]:
        return [_meta_from_row(r) for r in self.state._all("SELECT * FROM tools ORDER BY name")]

    def get(self, name: str) -> dict | None:
        if not TOOL_NAME.match(name):
            return None
        r = self.state._one("SELECT * FROM tools WHERE name = ?", (name,))
        if not r:
            return None
        meta = _meta_from_row(r)
        source = r["source"]
        return {"meta": meta, "source": source, "file": str(self._materialize(name, meta["revision"], source))}

    def save(self, *, name: str, description: str, parameters: dict, deps: dict, packages: list,
             source: str, timeout_ms: int | None = None) -> dict:
        if not TOOL_NAME.match(name):
            raise ValueError(f'invalid tool name "{name}": must match {TOOL_NAME.pattern}')
        from ..core.state import now_iso
        t = now_iso()
        self.state._exec(
            """INSERT INTO tools (name, description, parameters, deps, packages, timeout_ms, revision, source, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
               ON CONFLICT (name) DO UPDATE SET
                 description = excluded.description, parameters = excluded.parameters, deps = excluded.deps,
                 packages = excluded.packages, timeout_ms = excluded.timeout_ms, source = excluded.source,
                 revision = tools.revision + 1, updated_at = excluded.updated_at,
                 disabled_at = NULL, disabled_reason = NULL""",
            (name, description, json.dumps(parameters), json.dumps(deps), json.dumps(packages), timeout_ms, source, t, t),
        )
        saved = self.get(name)
        if not saved:
            raise RuntimeError(f"tool {name} vanished while saving")
        return saved["meta"]

    def set_disabled(self, name: str, reason: str | None) -> bool:
        from ..core.state import now_iso
        cur = self.state._exec("UPDATE tools SET disabled_at = ?, disabled_reason = ? WHERE name = ?",
                               (None if reason is None else now_iso(), reason, name))
        return cur.rowcount > 0

    def record_run(self, name: str, record: dict) -> None:
        if not self.state._one("SELECT 1 FROM tools WHERE name = ?", (name,)):
            return
        self.state._exec(
            "INSERT INTO tool_runs (tool, revision, agent, mode, ok, duration_ms, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (name, record["revision"], record["agent"], record["mode"], 1 if record["ok"] else 0,
             record["duration_ms"], record.get("error"), record["at"]),
        )
        self.state._exec(
            "DELETE FROM tool_runs WHERE tool = ? AND id NOT IN (SELECT id FROM tool_runs WHERE tool = ? ORDER BY id DESC LIMIT ?)",
            (name, name, KEEP_RUNS),
        )

    def history(self, name: str, n: int = KEEP_RUNS) -> list[dict]:
        rows = self.state._all(
            "SELECT * FROM (SELECT * FROM tool_runs WHERE tool = ? ORDER BY id DESC LIMIT ?) ORDER BY id", (name, n))
        out = []
        for r in rows:
            d = dict(r)
            rec = {"at": d["at"], "revision": int(d["revision"]), "agent": d["agent"], "mode": d["mode"],
                   "ok": bool(d["ok"]), "duration_ms": int(d["duration_ms"])}
            if d["error"] is not None:
                rec["error"] = d["error"]
            out.append(rec)
        return out

    def remove(self, name: str) -> bool:
        if not TOOL_NAME.match(name):
            return False
        used = self.state.skills_using_tool(name)
        if used:
            raise ToolInUseError(name, used)
        cur = self.state._exec("DELETE FROM tools WHERE name = ?", (name,))
        self.state._exec("DELETE FROM tool_runs WHERE tool = ?", (name,))
        shutil.rmtree(self.dir / name, ignore_errors=True)
        return cur.rowcount > 0

    def _materialize(self, name: str, revision: int, source: str) -> Path:
        file = self.dir / name / f"r{revision}.py"
        if not file.exists() or file.read_text(encoding="utf-8") != source:
            file.parent.mkdir(parents=True, exist_ok=True)
            tmp = file.parent / f"r{revision}.py.{os.getpid()}.tmp"
            tmp.write_text(source, encoding="utf-8")
            tmp.replace(file)
        return file
