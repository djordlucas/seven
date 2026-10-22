// Seven's own state, in one SQLite file: <workspace>/.seven/seven.db.
//
// Agents, their conversations and inboxes, generated tools and their run
// history, and background runs all live here, so a restart resumes where the
// last process stopped. Agents and tools use their own databases (the `sql`
// built-in, `seven.db()` in a run); this one is seven's alone.

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Message } from "../llm/mistral.ts";

export type AgentMode = "interactive" | "request" | "sequence" | "continuous";
export type AgentStatus = "running" | "idle" | "done" | "failed" | "stopped";
export const TERMINAL: readonly AgentStatus[] = ["done", "failed", "stopped"];

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  parent: string | null;
  mode: AgentMode;
  status: AgentStatus;
  /** Continuous agents: wake up this often when idle. */
  intervalS: number | null;
  /** Model calls per turn; null uses the default. */
  maxSteps: number | null;
  /** Last answer of a finished request or sequence agent. */
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** When the agent last finished a turn. */
  lastTurnAt: string | null;
}

export interface InboxRow {
  id: number;
  agent: string;
  /** An agent id, or "user". */
  sender: string;
  /** A task starts a turn of its own; a message is also delivered into a turn in progress. */
  kind: "task" | "message";
  text: string;
  createdAt: string;
}

export interface RunRow {
  id: string;
  agent: string;
  tool: string;
  status: "running" | "done" | "lost";
  ok: boolean | null;
  value: unknown;
  error: string | null;
  logs: string[];
  durationMs: number | null;
  startedAt: string;
  checked: boolean;
}

const SCHEMA = `
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
  last_turn_at TEXT
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
`;

/** The root agent's id and name. */
export const ROOT_ID = "seven";

/** A lease older than this is considered abandoned by a crashed process. */
const LEASE_STALE_MS = 15_000;

const now = () => new Date().toISOString();

export class State {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(file: string) {
    this.path = path.resolve(file);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    // WAL lets `seven send` and `seven agents` in another process read and
    // write while an agent process holds the database open.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    if (!this.getAgent(ROOT_ID)) {
      this.createAgent({
        id: ROOT_ID,
        name: ROOT_ID,
        description: "The root agent; the user talks to it.",
        parent: null,
        mode: "interactive",
      });
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  /** Run `fn` in one transaction. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private next(counter: "agent_seq" | "run_seq"): number {
    const row = this.db
      .prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = ? RETURNING value")
      .get(counter) as { value: number | string };
    return Number(row.value);
  }

  // ── agents ────────────────────────────────────────────────────────────────

  createAgent(a: {
    id?: string;
    name: string;
    description?: string;
    instructions?: string;
    parent: string | null;
    mode: AgentMode;
    intervalS?: number | null;
    maxSteps?: number | null;
  }): AgentRow {
    const id = a.id ?? `a${this.next("agent_seq")}`;
    const t = now();
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, instructions, parent, mode, status, interval_s, max_steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`,
      )
      .run(
        id,
        a.name,
        a.description ?? "",
        a.instructions ?? "",
        a.parent,
        a.mode,
        a.intervalS ?? null,
        a.maxSteps ?? null,
        t,
        t,
      );
    return this.getAgent(id) as AgentRow;
  }

  getAgent(id: string): AgentRow | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? toAgent(row) : undefined;
  }

  listAgents(): AgentRow[] {
    return this.db.prepare("SELECT * FROM agents ORDER BY rowid").all().map(toAgent);
  }

  updateAgent(
    id: string,
    patch: Partial<Pick<AgentRow, "status" | "result" | "error" | "finishedAt" | "lastTurnAt">>,
  ): void {
    const cols: Record<string, string> = {
      status: "status",
      result: "result",
      error: "error",
      finishedAt: "finished_at",
      lastTurnAt: "last_turn_at",
    };
    const sets: string[] = ["updated_at = ?"];
    const vals: SQLInputValue[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      vals.push((v ?? null) as SQLInputValue);
    }
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  // ── conversations ─────────────────────────────────────────────────────────

  appendMessage(agent: string, message: Message): void {
    this.db
      .prepare("INSERT INTO messages (agent, body, created_at) VALUES (?, ?, ?)")
      .run(agent, JSON.stringify(message), now());
  }

  history(agent: string): Message[] {
    return this.db
      .prepare("SELECT body FROM messages WHERE agent = ? ORDER BY id")
      .all(agent)
      .map((r) => JSON.parse(String((r as { body: string }).body)) as Message);
  }

  clearHistory(agent: string): void {
    this.db.prepare("DELETE FROM messages WHERE agent = ?").run(agent);
  }

  // ── inboxes ───────────────────────────────────────────────────────────────

  enqueue(agent: string, item: { sender: string; kind: "task" | "message"; text: string }): number {
    const r = this.db
      .prepare("INSERT INTO inbox (agent, sender, kind, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(agent, item.sender, item.kind, item.text, now());
    return Number(r.lastInsertRowid);
  }

  /** Undelivered inbox items, oldest first. */
  pending(agent: string, filter: { kind?: "task" | "message"; sender?: string } = {}): InboxRow[] {
    const where = ["agent = ?", "delivered_at IS NULL"];
    const vals: SQLInputValue[] = [agent];
    if (filter.kind) {
      where.push("kind = ?");
      vals.push(filter.kind);
    }
    if (filter.sender) {
      where.push("sender = ?");
      vals.push(filter.sender);
    }
    return this.db
      .prepare(`SELECT * FROM inbox WHERE ${where.join(" AND ")} ORDER BY id`)
      .all(...vals)
      .map(toInbox);
  }

  markDelivered(id: number): void {
    this.db.prepare("UPDATE inbox SET delivered_at = ? WHERE id = ?").run(now(), id);
  }

  // ── background runs ───────────────────────────────────────────────────────

  insertRun(agent: string, tool: string): string {
    const id = `r${this.next("run_seq")}`;
    this.db
      .prepare("INSERT INTO runs (id, agent, tool, status, started_at) VALUES (?, ?, ?, 'running', ?)")
      .run(id, agent, tool, now());
    return id;
  }

  finishRun(id: string, r: { ok: boolean; value?: unknown; error?: string; logs: string[]; durationMs: number }): void {
    this.db
      .prepare("UPDATE runs SET status = 'done', ok = ?, value = ?, error = ?, logs = ?, duration_ms = ? WHERE id = ?")
      .run(
        r.ok ? 1 : 0,
        r.value === undefined ? null : JSON.stringify(r.value),
        r.error ?? null,
        JSON.stringify(r.logs),
        r.durationMs,
        id,
      );
  }

  markRunChecked(id: string): void {
    this.db.prepare("UPDATE runs SET checked = 1 WHERE id = ?").run(id);
  }

  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row) : undefined;
  }

  listRuns(agent: string, limit = 50): RunRow[] {
    return this.db
      .prepare(
        "SELECT * FROM (SELECT rowid AS seq, * FROM runs WHERE agent = ? ORDER BY rowid DESC LIMIT ?) ORDER BY seq",
      )
      .all(agent, limit)
      .map(toRun);
  }

  /** Runs recorded as running belong to a process that is gone; their output is lost. */
  markLostRuns(): number {
    const r = this.db
      .prepare(
        "UPDATE runs SET status = 'lost', ok = 0, error = 'lost: seven restarted while it ran' WHERE status = 'running'",
      )
      .run();
    return Number(r.changes);
  }

  // ── lease ─────────────────────────────────────────────────────────────────

  /** Claim the right to run agents. Fails while another live process holds a fresh lease. */
  acquireLease(pid = process.pid): { ok: true; tookOverFrom?: number } | { ok: false; pid: number } {
    return this.tx(() => {
      const held = this.db.prepare("SELECT pid, heartbeat_at FROM lease WHERE id = 1").get() as
        | { pid: number; heartbeat_at: number }
        | undefined;
      if (held && held.pid !== pid && Date.now() - held.heartbeat_at < LEASE_STALE_MS && alive(held.pid)) {
        return { ok: false as const, pid: held.pid };
      }
      this.db
        .prepare(
          "INSERT INTO lease (id, pid, heartbeat_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET pid = ?, heartbeat_at = ?",
        )
        .run(pid, Date.now(), pid, Date.now());
      return { ok: true as const, ...(held && held.pid !== pid && { tookOverFrom: held.pid }) };
    });
  }

  heartbeat(pid = process.pid): void {
    this.db.prepare("UPDATE lease SET heartbeat_at = ? WHERE id = 1 AND pid = ?").run(Date.now(), pid);
  }

  releaseLease(pid = process.pid): void {
    this.db.prepare("DELETE FROM lease WHERE id = 1 AND pid = ?").run(pid);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Row = Record<string, SQLInputValue>;

function toAgent(r: unknown): AgentRow {
  const x = r as Row;
  return {
    id: String(x.id),
    name: String(x.name),
    description: String(x.description),
    instructions: String(x.instructions),
    parent: x.parent === null ? null : String(x.parent),
    mode: x.mode as AgentMode,
    status: x.status as AgentStatus,
    intervalS: x.interval_s === null ? null : Number(x.interval_s),
    maxSteps: x.max_steps === null ? null : Number(x.max_steps),
    result: x.result === null ? null : String(x.result),
    error: x.error === null ? null : String(x.error),
    createdAt: String(x.created_at),
    updatedAt: String(x.updated_at),
    finishedAt: x.finished_at === null ? null : String(x.finished_at),
    lastTurnAt: x.last_turn_at === null ? null : String(x.last_turn_at),
  };
}

function toInbox(r: unknown): InboxRow {
  const x = r as Row;
  return {
    id: Number(x.id),
    agent: String(x.agent),
    sender: String(x.sender),
    kind: x.kind as InboxRow["kind"],
    text: String(x.text),
    createdAt: String(x.created_at),
  };
}

function toRun(r: unknown): RunRow {
  const x = r as Row;
  return {
    id: String(x.id),
    agent: String(x.agent),
    tool: String(x.tool),
    status: x.status as RunRow["status"],
    ok: x.ok === null ? null : Boolean(x.ok),
    value: x.value === null ? undefined : JSON.parse(String(x.value)),
    error: x.error === null ? null : String(x.error),
    logs: x.logs === null ? [] : (JSON.parse(String(x.logs)) as string[]),
    durationMs: x.duration_ms === null ? null : Number(x.duration_ms),
    startedAt: String(x.started_at),
    checked: Boolean(x.checked),
  };
}
