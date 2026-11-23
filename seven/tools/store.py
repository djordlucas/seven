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

from ..core.state import State, now_iso

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
        "libs": json.loads(d["libs"]) if d.get("libs") else [],
        "created_at": d["created_at"], "updated_at": d["updated_at"], "revision": int(d["revision"]),
    }
    if d.get("test_args") is not None:
        meta["test_args"] = json.loads(d["test_args"])
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
        return [_meta_from_row(r) for r in self.state.query("SELECT * FROM tools ORDER BY name")]

    def get(self, name: str) -> dict | None:
        if not TOOL_NAME.match(name):
            return None
        r = self.state.query_one("SELECT * FROM tools WHERE name = ?", (name,))
        if not r:
            return None
        meta = _meta_from_row(r)
        source = r["source"]
        return {"meta": meta, "source": source, "file": str(self._materialize(name, meta["revision"], source))}

    def save(self, *, name: str, description: str, parameters: dict, deps: dict, packages: list,
             source: str, timeout_ms: int | None = None, libs: list | None = None,
             test_args: object = None) -> dict:
        if not TOOL_NAME.match(name):
            raise ValueError(f'invalid tool name "{name}": must match {TOOL_NAME.pattern}')
        t = now_iso()
        self.state.execute(
            """INSERT INTO tools (name, description, parameters, deps, packages, timeout_ms, revision, source, libs, test_args, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
               ON CONFLICT (name) DO UPDATE SET
                 description = excluded.description, parameters = excluded.parameters, deps = excluded.deps,
                 packages = excluded.packages, timeout_ms = excluded.timeout_ms, source = excluded.source,
                 libs = excluded.libs, test_args = excluded.test_args,
                 revision = tools.revision + 1, updated_at = excluded.updated_at,
                 disabled_at = NULL, disabled_reason = NULL""",
            (name, description, json.dumps(parameters), json.dumps(deps), json.dumps(packages), timeout_ms,
             source, json.dumps(libs or []), json.dumps(test_args) if test_args is not None else None, t, t),
        )
        saved = self.get(name)
        if not saved:
            raise RuntimeError(f"tool {name} vanished while saving")
        return saved["meta"]

    def set_libs(self, name: str, libs: list) -> bool:
        """Re-pin a tool's bundled libraries (used after a successful rebundle trial)."""
        cur = self.state.execute("UPDATE tools SET libs = ?, updated_at = ? WHERE name = ?",
                                 (json.dumps(libs), now_iso(), name))
        return cur.rowcount > 0

    def tools_pinning_lib(self, lib: str) -> list[dict]:
        """Tools whose bundled manifest pins `lib`, with the pinned revision."""
        out = []
        for r in self.state.query("SELECT name, revision, libs FROM tools"):
            for entry in json.loads(r["libs"] or "[]"):
                if entry.get("name") == lib:
                    out.append({"tool": r["name"], "tool_revision": int(r["revision"]),
                                "lib_revision": int(entry.get("revision", 0))})
        return out

    def set_disabled(self, name: str, reason: str | None) -> bool:
        cur = self.state.execute("UPDATE tools SET disabled_at = ?, disabled_reason = ? WHERE name = ?",
                               (None if reason is None else now_iso(), reason, name))
        return cur.rowcount > 0

    def record_run(self, name: str, record: dict) -> None:
        if not self.state.query_one("SELECT 1 FROM tools WHERE name = ?", (name,)):
            return
        self.state.execute(
            "INSERT INTO tool_runs (tool, revision, agent, mode, ok, duration_ms, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (name, record["revision"], record["agent"], record["mode"], 1 if record["ok"] else 0,
             record["duration_ms"], record.get("error"), record["at"]),
        )
        self.state.execute(
            "DELETE FROM tool_runs WHERE tool = ? AND id NOT IN (SELECT id FROM tool_runs WHERE tool = ? ORDER BY id DESC LIMIT ?)",
            (name, name, KEEP_RUNS),
        )

    def history(self, name: str, n: int = KEEP_RUNS) -> list[dict]:
        rows = self.state.query(
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
        cur = self.state.execute("DELETE FROM tools WHERE name = ?", (name,))
        self.state.execute("DELETE FROM tool_runs WHERE tool = ?", (name,))
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


class LibInUseError(Exception):
    def __init__(self, name: str, dependents: list[dict]):
        self.name = name
        self.dependents = dependents
        pins = ", ".join(f'{d["tool"]} (lib r{d["lib_revision"]})' for d in dependents)
        super().__init__(f'library "{name}" is bundled into tool(s): {pins} — rebundle or delete those tools first')


class LibStore:
    """Generated libraries: shared modules that tools import and pin per revision.

    A library's current definition is a row in `libs`; every revision's source
    is also kept in `lib_revs` and materialized to <dir>/<name>/r<revision>.py,
    so a tool's pinned revision keeps working even after the library moves on.
    """

    def __init__(self, state: State, dir: str | Path, tool_store: ToolStore | None = None):
        self.state = state
        self.dir = Path(dir)
        self.tools = tool_store

    def list(self) -> list[dict]:
        out = []
        for r in self.state.query("SELECT * FROM libs ORDER BY name"):
            d = dict(r)
            meta = {"name": d["name"], "description": d["description"], "revision": int(d["revision"]),
                    "created_at": d["created_at"], "updated_at": d["updated_at"]}
            meta["dependents"] = len(self.tools.tools_pinning_lib(d["name"])) if self.tools else 0
            out.append(meta)
        return out

    def latest_revision(self, name: str) -> int | None:
        r = self.state.query_one("SELECT revision FROM libs WHERE name = ?", (name,))
        return int(r["revision"]) if r else None

    def get(self, name: str) -> dict | None:
        if not TOOL_NAME.match(name):
            return None
        r = self.state.query_one("SELECT * FROM libs WHERE name = ?", (name,))
        if not r:
            return None
        d = dict(r)
        meta = {"name": d["name"], "description": d["description"], "revision": int(d["revision"]),
                "created_at": d["created_at"], "updated_at": d["updated_at"]}
        return {"meta": meta, "source": d["source"], "file": str(self.file_for(name, meta["revision"]))}

    def save(self, *, name: str, description: str, source: str) -> dict:
        if not TOOL_NAME.match(name):
            raise ValueError(f'invalid library name "{name}": must match {TOOL_NAME.pattern}')
        compile(source, f"<lib {name}>", "exec")  # syntax gate; runtime check happens via dependent tools' trials
        t = now_iso()
        self.state.execute(
            """INSERT INTO libs (name, description, revision, source, created_at, updated_at)
               VALUES (?, ?, 1, ?, ?, ?)
               ON CONFLICT (name) DO UPDATE SET
                 description = excluded.description, source = excluded.source,
                 revision = libs.revision + 1, updated_at = excluded.updated_at""",
            (name, description, source, t, t),
        )
        rev = self.latest_revision(name)
        self.state.execute("INSERT OR REPLACE INTO lib_revs (name, revision, source, at) VALUES (?, ?, ?, ?)",
                           (name, rev, source, t))
        saved = self.get(name)
        if not saved:
            raise RuntimeError(f"library {name} vanished while saving")
        return saved["meta"]

    def remove(self, name: str, force: bool = False) -> bool:
        if not TOOL_NAME.match(name):
            return False
        if self.tools:
            dependents = self.tools.tools_pinning_lib(name)
            if dependents and not force:
                raise LibInUseError(name, dependents)
            for d in dependents:
                self.tools.set_libs(d["tool"], [e for e in self._tool_libs(d["tool"]) if e.get("name") != name])
        cur = self.state.execute("DELETE FROM libs WHERE name = ?", (name,))
        self.state.execute("DELETE FROM lib_revs WHERE name = ?", (name,))
        shutil.rmtree(self.dir / name, ignore_errors=True)
        return cur.rowcount > 0

    def dependents(self, name: str) -> list[dict]:
        return self.tools.tools_pinning_lib(name) if self.tools else []

    def _tool_libs(self, tool: str) -> list:
        r = self.state.query_one("SELECT libs FROM tools WHERE name = ?", (tool,))
        return json.loads(r["libs"]) if r and r["libs"] else []

    def resolve(self, specs: list[str] | None) -> list[dict]:
        """Resolve ["name", "name@3", ...] to pinned [{"name", "revision"}] (latest when no @rev)."""
        pins: list[dict] = []
        for spec in specs or []:
            spec = str(spec).strip()
            if not spec:
                continue
            if "@" in spec:
                name, _, rev = spec.partition("@")
                if not TOOL_NAME.match(name) or not rev.isdigit():
                    raise ValueError(f'bad library spec "{spec}": expected "name" or "name@revision"')
                have = self.latest_revision(name)
                if have is None:
                    raise ValueError(f'unknown library "{name}"')
                if not self.state.query_one("SELECT 1 FROM lib_revs WHERE name = ? AND revision = ?", (name, int(rev))):
                    raise ValueError(f'library "{name}" has no revision {rev} (latest is {have})')
                pins.append({"name": name, "revision": int(rev)})
            else:
                if not TOOL_NAME.match(spec):
                    raise ValueError(f'bad library name "{spec}": must match {TOOL_NAME.pattern}')
                rev = self.latest_revision(spec)
                if rev is None:
                    raise ValueError(f'unknown library "{spec}"')
                pins.append({"name": spec, "revision": rev})
        seen = set()
        unique = []
        for p in pins:
            if p["name"] in seen:
                raise ValueError(f'library "{p["name"]}" listed twice')
            seen.add(p["name"])
            unique.append(p)
        return unique

    def libs_map(self, pins: list[dict]) -> dict[str, str]:
        """Pinned revisions → {module name: source file} for the child's import hook."""
        return {p["name"]: str(self.file_for(p["name"], p["revision"])) for p in pins}

    def file_for(self, name: str, revision: int) -> Path:
        file = self.dir / name / f"r{revision}.py"
        if not file.exists():
            r = self.state.query_one("SELECT source FROM lib_revs WHERE name = ? AND revision = ?", (name, revision))
            if not r:
                raise KeyError(f'library "{name}" revision {revision} is not on disk or in the database')
            file.parent.mkdir(parents=True, exist_ok=True)
            tmp = file.parent / f"r{revision}.py.{os.getpid()}.tmp"
            tmp.write_text(r["source"], encoding="utf-8")
            tmp.replace(file)
        return file
