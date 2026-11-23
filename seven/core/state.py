"""Seven's own state in one SQLite file: <workspace>/.seven/seven.db.

Agents, conversations, inboxes, generated tools and their run history,
background runs and the lease all live here, so a restart resumes where the
last process stopped. WAL mode lets the CLI read and write it while the
server process runs agents.
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict

TERMINAL = ("done", "failed", "stopped")
ROOT_ID = "seven"
SUPERVISOR = "supervisor"
LEASE_STALE_MS = 15_000


class AgentRow(TypedDict, total=False):
    id: str
    name: str
    description: str
    instructions: str
    parent: str | None
    mode: str
    status: str
    interval_s: int | None
    max_steps: int | None
    result: str | None
    error: str | None
    created_at: str
    updated_at: str
    finished_at: str | None
    last_turn_at: str | None
    summary: str | None
    context_from: int
    compactions: int
    loaded_skills: list[str]
    revealed_tools: list[str]


class InboxItem(TypedDict, total=False):
    id: int
    agent: str
    sender: str
    kind: str
    text: str
    created_at: str
    delivered_at: str | None


class OutboxItem(TypedDict, total=False):
    id: int
    sender: str
    recipient: str
    kind: str
    text: str
    created_at: str
    delivered_at: str | None


class RunRow(TypedDict, total=False):
    id: str
    agent: str
    tool: str
    status: str
    ok: bool | None
    value: object
    error: str | None
    logs: list[str]
    duration_ms: int | None
    started_at: str
    checked: bool


class Job(TypedDict, total=False):
    id: str
    kind: str
    spec: dict
    agent: str
    status: str
    result: str | None
    error: str | None
    turns: int
    queued: int
    last_turn_at: str | None
    next_run_at: str | None
    created_by: str
    created_at: str
    updated_at: str
    finished_at: str | None


class Skill(TypedDict, total=False):
    name: str
    description: str
    instructions: str
    tools: list[str]
    created_at: str
    updated_at: str


class Output(TypedDict, total=False):
    id: str
    agent: str
    tool: str
    path: str
    chars: int
    lines: int
    created_at: str

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  parent TEXT REFERENCES agents(id),
  mode TEXT NOT NULL CHECK (mode IN ('interactive', 'request', 'sequence', 'continuous')),
  status TEXT NOT NULL CHECK (status IN ('running', 'idle', 'done', 'failed', 'stopped')),
  interval_s INTEGER,
  max_steps INTEGER,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  last_turn_at TEXT,
  summary TEXT,
  context_from INTEGER NOT NULL DEFAULT 0,
  compactions INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages (agent, id);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'message')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox (agent, delivered_at, id);
CREATE TABLE IF NOT EXISTS tools (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  parameters TEXT NOT NULL,
  deps TEXT NOT NULL,
  packages TEXT NOT NULL,
  timeout_ms INTEGER,
  disabled_at TEXT,
  disabled_reason TEXT,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_runs (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  revision INTEGER NOT NULL,
  agent TEXT NOT NULL,
  mode TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_runs_tool ON tool_runs (tool, id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'lost')),
  ok INTEGER,
  value TEXT,
  error TEXT,
  logs TEXT,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1'), ('agent_seq', '0'), ('run_seq', '0');
"""

MIGRATIONS = [
    # 2: supervisor peer + per-agent loaded_skills/revealed_tools (agents rebuilt:
    #    SQLite cannot ALTER a CHECK), plus jobs, outbox, skills, outputs.
    """
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('task', 'goal', 'periodic')),
      spec TEXT NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'done', 'failed', 'stopped')),
      result TEXT,
      error TEXT,
      turns INTEGER NOT NULL DEFAULT 0,
      queued INTEGER NOT NULL DEFAULT 0,
      last_turn_at TEXT,
      next_run_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('task', 'message')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      inbox_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS outbox_sender ON outbox (sender, id);
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outputs (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      tool TEXT NOT NULL,
      path TEXT NOT NULL,
      chars INTEGER NOT NULL,
      lines INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE agents_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      parent TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('interactive', 'request', 'sequence', 'continuous', 'supervisor')),
      status TEXT NOT NULL CHECK (status IN ('running', 'idle', 'done', 'failed', 'stopped')),
      interval_s INTEGER,
      max_steps INTEGER,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      last_turn_at TEXT,
      summary TEXT,
      context_from INTEGER NOT NULL DEFAULT 0,
      compactions INTEGER NOT NULL DEFAULT 0,
      loaded_skills TEXT NOT NULL DEFAULT '[]',
      revealed_tools TEXT NOT NULL DEFAULT '[]'
    );
    INSERT INTO agents_new (id, name, description, instructions, parent, mode, status, interval_s, max_steps,
                            result, error, created_at, updated_at, finished_at, last_turn_at, summary, context_from, compactions)
      SELECT id, name, description, instructions, parent, mode, status, interval_s, max_steps,
             result, error, created_at, updated_at, finished_at, last_turn_at, summary, context_from, compactions FROM agents;
    DROP TABLE agents;
    ALTER TABLE agents_new RENAME TO agents;
    INSERT OR IGNORE INTO agents (id, name, description, parent, mode, status, created_at, updated_at)
      VALUES ('supervisor', 'supervisor', 'The supervisor; message it to control jobs and read system status.', NULL, 'supervisor', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT OR IGNORE INTO meta (key, value) VALUES ('job_seq', '0');
    """,
    # 3: generated libraries (libs + per-revision sources) and per-tool pinned
    #    dependency manifests (tools.libs) plus stored trial args (tools.test_args).
    """
    CREATE TABLE IF NOT EXISTS libs (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lib_revs (
      name TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (name, revision)
    );
    ALTER TABLE tools ADD COLUMN libs TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE tools ADD COLUMN test_args TEXT;
    """,
    # 4: per-agent key/value memory (remember/recall/forget), shown in the Data view.
    """
    CREATE TABLE IF NOT EXISTS kv (
      agent TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      chars INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent, key)
    );
    """,
]

SCHEMA_VERSION = len(MIGRATIONS) + 1


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _row_to_agent(r: sqlite3.Row) -> AgentRow:
    d = dict(r)
    return {
        "id": d["id"], "name": d["name"], "description": d["description"], "instructions": d["instructions"],
        "parent": d["parent"], "mode": d["mode"], "status": d["status"],
        "interval_s": d["interval_s"], "max_steps": d["max_steps"],
        "result": d["result"], "error": d["error"],
        "created_at": d["created_at"], "updated_at": d["updated_at"],
        "finished_at": d["finished_at"], "last_turn_at": d["last_turn_at"],
        "summary": d["summary"], "context_from": d["context_from"], "compactions": d["compactions"],
        "loaded_skills": json.loads(d["loaded_skills"]) if d.get("loaded_skills") else [],
        "revealed_tools": json.loads(d["revealed_tools"]) if d.get("revealed_tools") else [],
    }


def _row_to_inbox(r: sqlite3.Row) -> InboxItem:
    d = dict(r)
    return {"id": d["id"], "agent": d["agent"], "sender": d["sender"], "kind": d["kind"], "text": d["text"], "created_at": d["created_at"]}


def _row_to_run(r: sqlite3.Row) -> RunRow:
    d = dict(r)
    return {
        "id": d["id"], "agent": d["agent"], "tool": d["tool"], "status": d["status"],
        "ok": None if d["ok"] is None else bool(d["ok"]),
        "value": None if d["value"] is None else json.loads(d["value"]),
        "error": d["error"],
        "logs": [] if d["logs"] is None else json.loads(d["logs"]),
        "duration_ms": d["duration_ms"], "started_at": d["started_at"], "checked": bool(d["checked"]),
    }


class State:
    def __init__(self, file: str | Path):
        self.path = str(Path(file).resolve())
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA synchronous = NORMAL")
        self.db.execute("PRAGMA busy_timeout = 5000")
        self.db.execute("PRAGMA foreign_keys = ON")
        self._lock = threading.RLock()
        self._in_tx = 0
        with self._lock:
            self.db.executescript(SCHEMA)
            self._migrate()
            if not self.get_agent(ROOT_ID):
                self.create_agent(id=ROOT_ID, name=ROOT_ID, description="The root agent; the user talks to it.", parent=None, mode="interactive")

    @property
    def is_open(self) -> bool:
        return self.db is not None

    def close(self) -> None:
        with self._lock, contextlib.suppress(sqlite3.Error):
            self.db.close()

    def tx(self, fn):
        with self._lock:
            self._in_tx += 1
            self.db.execute("BEGIN IMMEDIATE")
            try:
                out = fn()
                self.db.execute("COMMIT")
                return out
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            finally:
                self._in_tx -= 1

    def _migrate(self) -> None:
        row = self.query_one("SELECT value FROM meta WHERE key = 'schema_version'")
        frm = int(row[0]) if row else 1
        if frm > SCHEMA_VERSION:
            raise RuntimeError(f"{self.path} is schema version {frm}; this seven knows up to {SCHEMA_VERSION}")
        if frm < SCHEMA_VERSION:
            # The agents rebuild drops and recreates the table; foreign keys must
            # be off outside the transaction for that.
            self.db.execute("PRAGMA foreign_keys = OFF")

        def work():
            for v in range(frm, SCHEMA_VERSION):
                self.db.executescript(MIGRATIONS[v - 1])
            self.db.execute("UPDATE meta SET value = ? WHERE key = 'schema_version'", (str(SCHEMA_VERSION),))
        self.tx(work)
        self.db.execute("PRAGMA foreign_keys = ON")

    def _next(self, counter: str) -> int:
        with self._lock:
            self.db.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = ?", (counter,))
            row = self.db.execute("SELECT value FROM meta WHERE key = ?", (counter,)).fetchone()
            return int(row[0])

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self.db.execute(sql, params)
            if self._in_tx == 0:
                self.db.commit()
            return cur

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.db.execute(sql, params).fetchall()

    def query_one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        with self._lock:
            return self.db.execute(sql, params).fetchone()

    def create_agent(self, *, id: str | None = None, name: str, description: str = "", instructions: str = "",
                     parent: str | None, mode: str, interval_s: int | None = None, max_steps: int | None = None) -> dict:
        agent_id = id or f"a{self._next('agent_seq')}"
        t = now_iso()
        self.execute(
            "INSERT INTO agents (id, name, description, instructions, parent, mode, status, interval_s, max_steps, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)",
            (agent_id, name, description, instructions, parent, mode, interval_s, max_steps, t, t),
        )
        return self.get_agent(agent_id)

    def get_agent(self, agent_id: str) -> AgentRow | None:
        r = self.query_one("SELECT * FROM agents WHERE id = ?", (agent_id,))
        return _row_to_agent(r) if r else None

    def list_agents(self) -> list[AgentRow]:
        return [_row_to_agent(r) for r in self.query("SELECT * FROM agents ORDER BY created_at, id")]

    def update_agent(self, agent_id: str, **fields) -> None:
        if not fields:
            return
        cols = {"status", "interval_s", "max_steps", "result", "error", "finished_at", "last_turn_at", "summary", "context_from", "compactions", "description", "instructions", "name", "loaded_skills", "revealed_tools"}
        sets = []
        params = []
        for k, v in fields.items():
            if k in cols:
                sets.append(f"{k} = ?")
                params.append(v)
        if not sets:
            return
        sets.append("updated_at = ?")
        params.append(now_iso())
        params.append(agent_id)
        self.execute(f"UPDATE agents SET {', '.join(sets)} WHERE id = ?", tuple(params))

    def append_message(self, agent_id: str, message: dict) -> int:
        cur = self.execute("INSERT INTO messages (agent, body, created_at) VALUES (?, ?, ?)", (agent_id, json.dumps(message), now_iso()))
        return int(cur.lastrowid)

    def history(self, agent_id: str) -> list[dict]:
        rows = self.query(
            "SELECT m.id, m.body FROM messages m JOIN agents a ON a.id = m.agent WHERE m.agent = ? AND m.id > a.context_from ORDER BY m.id",
            (agent_id,),
        )
        return [{"id": r["id"], "message": json.loads(r["body"])} for r in rows]

    def transcript(self, agent_id: str, limit: int = 1000, offset: int = 0) -> list[dict]:
        rows = self.query("SELECT id, body, created_at FROM messages WHERE agent = ? ORDER BY id LIMIT ? OFFSET ?", (agent_id, limit, offset))
        return [{"id": r["id"], "created_at": r["created_at"], "message": json.loads(r["body"])} for r in rows]

    def transcript_count(self, agent_id: str) -> int:
        r = self.query_one("SELECT count(*) AS n FROM messages WHERE agent = ?", (agent_id,))
        return int(r["n"])

    def context(self, agent_id: str) -> list[dict]:
        agent = self.get_agent(agent_id)
        rows = self.query("SELECT id, body FROM messages WHERE agent = ? AND id > ? ORDER BY id", (agent_id, agent["context_from"] if agent else 0))
        return [{"id": r["id"], "message": json.loads(r["body"])} for r in rows]

    def clear_conversation(self, agent_id: str) -> None:
        def work():
            self.db.execute("DELETE FROM messages WHERE agent = ?", (agent_id,))
            self.db.execute("UPDATE agents SET summary = NULL, context_from = 0, compactions = 0, updated_at = ? WHERE id = ?", (now_iso(), agent_id))
        self.tx(work)

    def compact(self, agent_id: str, summary: str, context_from: int) -> None:
        self.execute(
            "UPDATE agents SET summary = ?, context_from = ?, compactions = compactions + 1, updated_at = ? WHERE id = ?",
            (summary, context_from, now_iso(), agent_id),
        )

    def enqueue(self, agent_id: str, *, sender: str, kind: str, text: str) -> int:
        cur = self.execute("INSERT INTO inbox (agent, sender, kind, text, created_at) VALUES (?, ?, ?, ?, ?)", (agent_id, sender, kind, text, now_iso()))
        return int(cur.lastrowid)

    def pending(self, agent_id: str, kind: str | None = None, sender: str | None = None) -> list[InboxItem]:
        sql = "SELECT * FROM inbox WHERE agent = ? AND delivered_at IS NULL"
        params: list = [agent_id]
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        if sender:
            sql += " AND sender = ?"
            params.append(sender)
        sql += " ORDER BY id"
        return [_row_to_inbox(r) for r in self.query(sql, tuple(params))]

    def mark_delivered(self, inbox_id: int) -> None:
        self.execute("UPDATE inbox SET delivered_at = ? WHERE id = ?", (now_iso(), inbox_id))

    def insert_run(self, agent: str, tool: str) -> str:
        rid = f"r{self._next('run_seq')}"
        self.execute("INSERT INTO runs (id, agent, tool, status, started_at) VALUES (?, ?, ?, 'running', ?)", (rid, agent, tool, now_iso()))
        return rid

    def finish_run(self, rid: str, result: dict) -> None:
        self.execute(
            "UPDATE runs SET status = 'done', ok = ?, value = ?, error = ?, logs = ?, duration_ms = ?, checked = 0 WHERE id = ?",
            (1 if result.get("ok") else 0, json.dumps(result.get("value")) if result.get("ok") else None,
             result.get("error"), json.dumps(result.get("logs", [])), result.get("duration_ms"), rid),
        )

    def get_run(self, rid: str) -> RunRow | None:
        r = self.query_one("SELECT * FROM runs WHERE id = ?", (rid,))
        return _row_to_run(r) if r else None

    def list_runs(self, agent: str | None = None, limit: int = 50) -> list[RunRow]:
        if agent:
            rows = self.query("SELECT * FROM runs WHERE agent = ? ORDER BY started_at DESC, id DESC LIMIT ?", (agent, limit))
        else:
            rows = self.query("SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?", (limit,))
        return [_row_to_run(r) for r in rows]

    def mark_run_checked(self, rid: str) -> None:
        self.execute("UPDATE runs SET checked = 1 WHERE id = ?", (rid,))

    def mark_lost_runs(self) -> int:
        cur = self.execute("UPDATE runs SET status = 'lost', error = 'lost: seven restarted while it ran' WHERE status = 'running'")
        return cur.rowcount

    # ── mail (R2): inbox + outbox, written in one transaction ──

    def send(self, sender: str, recipient: str, kind: str, text: str) -> int:
        def work():
            inbox_id = self.enqueue(recipient, sender=sender, kind=kind, text=text)
            self.db.execute(
                "INSERT INTO outbox (sender, recipient, kind, text, created_at, inbox_id) VALUES (?, ?, ?, ?, ?, ?)",
                (sender, recipient, kind, text, now_iso(), inbox_id),
            )
            return inbox_id
        return self.tx(work)

    def list_outbox(self, sender: str, limit: int = 100) -> list[OutboxItem]:
        rows = self.query(
            "SELECT o.id, o.sender, o.recipient, o.kind, o.text, o.created_at, i.delivered_at FROM outbox o"
            " LEFT JOIN inbox i ON i.id = o.inbox_id WHERE o.sender = ? ORDER BY o.id DESC LIMIT ?",
            (sender, limit),
        )
        return [dict(r) for r in rows]

    # ── jobs (R1) ──

    def create_job(self, *, kind: str, spec: dict, agent: str, created_by: str) -> Job:
        jid = f"j{self._next('job_seq')}"
        t = now_iso()
        self.execute(
            "INSERT INTO jobs (id, kind, spec, agent, status, turns, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', 0, ?, ?, ?)",
            (jid, kind, json.dumps(spec), agent, created_by, t, t),
        )
        return self.get_job(jid)

    def get_job(self, jid: str) -> Job | None:
        r = self.query_one("SELECT * FROM jobs WHERE id = ?", (jid,))
        return dict(r) | {"spec": json.loads(r["spec"])} if r else None

    def list_jobs(self, all: bool = False) -> list[Job]:
        rows = self.query("SELECT * FROM jobs ORDER BY created_at, id")
        out = []
        for r in rows:
            d = dict(r)
            d["spec"] = json.loads(d["spec"])
            out.append(d)
        if not all:
            out = [j for j in out if j["status"] in ("running", "paused")]
        return out

    def update_job(self, jid: str, **fields) -> None:
        cols = {"status", "result", "error", "turns", "queued", "last_turn_at", "next_run_at", "finished_at", "agent"}
        sets, params = [], []
        for k, v in fields.items():
            if k in cols:
                sets.append(f"{k} = ?")
                params.append(v)
        if not sets:
            return
        sets.append("updated_at = ?")
        params.append(now_iso())
        params.append(jid)
        self.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", tuple(params))

    # ── skills (R4) ──

    def save_skill(self, *, name: str, description: str, instructions: str, tools: list[str]) -> Skill:
        t = now_iso()
        self.execute(
            "INSERT INTO skills (name, description, instructions, tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
            " ON CONFLICT (name) DO UPDATE SET description = excluded.description, instructions = excluded.instructions,"
            " tools = excluded.tools, updated_at = excluded.updated_at",
            (name, description, instructions, json.dumps(tools), t, t),
        )
        return self.get_skill(name)

    def get_skill(self, name: str) -> Skill | None:
        r = self.query_one("SELECT * FROM skills WHERE name = ?", (name,))
        if not r:
            return None
        d = dict(r)
        d["tools"] = json.loads(d["tools"])
        return d

    def list_skills(self) -> list[Skill]:
        return [self.get_skill(r["name"]) for r in self.query("SELECT name FROM skills ORDER BY name")]

    def delete_skill(self, name: str) -> bool:
        def work():
            cur = self.db.execute("DELETE FROM skills WHERE name = ?", (name,))
            if cur.rowcount == 0:
                return False
            for a in self.db.execute("SELECT id, loaded_skills FROM agents").fetchall():
                loaded = json.loads(a["loaded_skills"] or "[]")
                if name in loaded:
                    self.db.execute("UPDATE agents SET loaded_skills = ?, updated_at = ? WHERE id = ?",
                                    (json.dumps([s for s in loaded if s != name]), now_iso(), a["id"]))
            return True
        return self.tx(work)

    def skills_using_tool(self, tool: str) -> list[str]:
        rows = self.query("SELECT name FROM skills, json_each(skills.tools) WHERE json_each.value = ?", (tool,))
        return [r["name"] for r in rows]

    # ── per-agent revealed tools / loaded skills (R3b, R4) ──

    def add_revealed_tool(self, agent_id: str, name: str) -> None:
        a = self.get_agent(agent_id)
        if a and name not in a["revealed_tools"]:
            self.update_agent(agent_id, revealed_tools=json.dumps([*a["revealed_tools"], name]))

    def set_loaded_skills(self, agent_id: str, names: list[str]) -> None:
        self.update_agent(agent_id, loaded_skills=json.dumps(names))

    # ── output memory (R3a) ──

    def record_output(self, *, oid: str, agent: str, tool: str, path: str, chars: int, lines: int) -> None:
        self.execute("INSERT OR REPLACE INTO outputs (id, agent, tool, path, chars, lines, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   (oid, agent, tool, path, chars, lines, now_iso()))

    def get_output(self, oid: str) -> Output | None:
        r = self.query_one("SELECT * FROM outputs WHERE id = ?", (oid,))
        return dict(r) if r else None

    # ── per-agent key/value memory ──

    def kv_put(self, agent: str, key: str, value: str) -> None:
        self.execute(
            "INSERT OR REPLACE INTO kv (agent, key, value, chars, updated_at) VALUES (?, ?, ?, ?, ?)",
            (agent, key, value, len(value), now_iso()),
        )

    def kv_get(self, agent: str, key: str) -> dict | None:
        r = self.query_one("SELECT * FROM kv WHERE agent = ? AND key = ?", (agent, key))
        return dict(r) if r else None

    def kv_list(self, agent: str | None = None) -> list[dict]:
        # preview = first 81 chars of the value (callers ellipsize past 80); values stay out of the row otherwise
        if agent:
            rows = self.query("SELECT agent, key, chars, updated_at, substr(value, 1, 81) AS preview FROM kv WHERE agent = ? ORDER BY updated_at DESC, key LIMIT 500", (agent,))
        else:
            rows = self.query("SELECT agent, key, chars, updated_at, substr(value, 1, 81) AS preview FROM kv ORDER BY updated_at DESC, agent, key LIMIT 500")
        return [dict(r) for r in rows]

    def kv_delete(self, agent: str, key: str) -> bool:
        cur = self.execute("DELETE FROM kv WHERE agent = ? AND key = ?", (agent, key))
        return cur.rowcount > 0

    def acquire_lease(self, stale_ms: int = LEASE_STALE_MS) -> str | None:
        def work():
            row = self.db.execute("SELECT pid, heartbeat_at FROM lease WHERE id = 1").fetchone()
            now_ms = int(datetime.now(UTC).timestamp() * 1000)
            if row:
                pid, hb = int(row[0]), int(row[1])
                alive = _pid_alive(pid)
                if alive and now_ms - hb < stale_ms:
                    return f"another seven (pid {pid}) is running agents in this workspace"
            self.db.execute("INSERT INTO lease (id, pid, heartbeat_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, heartbeat_at = excluded.heartbeat_at", (os.getpid(), now_ms))
            return None
        return self.tx(work)

    def heartbeat_lease(self) -> None:
        now_ms = int(datetime.now(UTC).timestamp() * 1000)
        self.execute("UPDATE lease SET heartbeat_at = ? WHERE id = 1 AND pid = ?", (now_ms, os.getpid()))

    def release_lease(self) -> None:
        self.execute("DELETE FROM lease WHERE id = 1 AND pid = ?", (os.getpid(),))


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True
