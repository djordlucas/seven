"""The supervisor runs every agent in this process, concurrently, and owns
autonomous jobs (R1) and its own mailbox as the `supervisor` peer (R2).

Every agent but the root and the supervisor is driven by its inbox: a tick
every 250 ms starts a turn for each idle agent that has work. The same tick
drives running jobs (enqueueing work into their agent's inbox) and consumes
the supervisor's inbox as line-based control commands. Polling the database,
rather than only reacting in-process, is what lets the API or `seven send` in
another process reach an agent.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ..core.llm import ChatModel
from ..core.log import Logger, noop_logger, preview
from ..core.state import ROOT_ID, SUPERVISOR, TERMINAL, AgentRow, State, now_iso
from ..execution.runner import Runner
from ..execution.runs import RunTable
from ..tools.store import LibStore, ToolStore
from .agent import Agent
from .commands import CommandMixin
from .errors import RefusedError
from .jobs import JobMixin

POLL_MS = 250
RETRY_MS = 30_000
ROOT = ROOT_ID


@dataclass
class SupervisorOpts:
    state: State
    store: ToolStore
    runner: Runner
    model: ChatModel
    workspace: str
    max_steps: int
    context_tokens: int
    max_agents: int
    spill_chars: int = 2000
    memory_dir: Path | None = None
    delegate_timeout_s: int = 600
    core_tools: tuple[str, ...] = ()
    tool_discovery: bool = True
    on_event: Callable[[dict], None] | None = None
    log: Logger = noop_logger
    libstore: LibStore | None = None


class Supervisor(CommandMixin, JobMixin):
    def __init__(self, opts: SupervisorOpts):
        self.opts = opts
        self.log = opts.log.child(component="supervisor")
        self.runs = RunTable(opts.state, opts.log, spill_chars=opts.spill_chars, memory_dir=opts.memory_dir)
        self.agents: dict[str, Agent] = {}
        self.retry_at: dict[str, float] = {}
        self.closed = False
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        state = self.opts.state
        lost = state.mark_lost_runs()
        if lost:
            self.log.warn("background runs lost in a restart", count=lost)
        active = [r for r in state.list_agents() if r["status"] not in TERMINAL and r["mode"] != "supervisor"]
        for row in active:
            self.agent(row["id"]).repair()
        self.log.info("supervisor started", agents=[f'{r["id"]}:{r["mode"]}:{r["status"]}' for r in active],
                      jobs=[j["id"] for j in state.list_jobs(all=False)], max_agents=self.opts.max_agents)
        root = self.agent(ROOT)
        if root.needs_resume():
            asyncio.ensure_future(self._resume_root(root))
        self.task = asyncio.ensure_future(self._loop())

    async def _resume_root(self, root: Agent) -> None:
        try:
            await root.turn(None)
        except Exception as err:
            self.log.error("driving an agent failed", agent=ROOT, error=err)

    async def _loop(self) -> None:
        while not self.closed:
            try:
                self.tick()
            except Exception as err:
                self.log.error("tick failed", error=err)
            await asyncio.sleep(POLL_MS / 1000)

    async def shutdown(self) -> None:
        self.closed = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                self.log.debug("supervisor loop cancelled")
            except Exception as err:
                self.log.error("supervisor loop ended with an error", error=err)
        busy = [a.id for a in self.agents.values() if a.busy]
        self.log.info("supervisor stopping", interrupting=busy)
        for a in self.agents.values():
            a.interrupt()
        await self.runs.shutdown()
        deadline = time.time() + 5
        while any(a.busy for a in self.agents.values()) and time.time() < deadline:
            await asyncio.sleep(0.02)

    def agent(self, agent_id: str) -> Agent | None:
        a = self.agents.get(agent_id)
        if a is None and self.opts.state.get_agent(agent_id):
            a = Agent(deps=_agent_deps(self.opts, self, self.runs, agent_id), agent_id=agent_id)
            self.agents[agent_id] = a
        return a

    def root(self) -> Agent:
        return self.agent(ROOT)

    # ── agents call these ──

    def spawn(self, parent: str, spec: dict) -> AgentRow:
        refused = self._check_spawn(spec)
        if refused:
            self.log.warn("spawn refused", parent=parent, name=spec["name"], mode=spec["mode"], reason=refused)
            raise RefusedError(refused)
        state = self.opts.state
        name = spec["name"].strip()

        def work():
            row = state.create_agent(name=name, description=spec["description"], instructions=spec["instructions"],
                                     parent=parent, mode=spec["mode"], interval_s=spec.get("interval_s"),
                                     max_steps=spec.get("max_steps"))
            for text in spec.get("tasks", []):
                state.enqueue(row["id"], sender=parent, kind="task", text=text)
            return row
        row = state.tx(work)
        self.log.info("agent spawned", agent=row["id"], parent=parent, name=name, mode=row["mode"],
                      tasks=len(spec.get("tasks", [])), **({"interval_s": row["interval_s"]} if row.get("interval_s") else {}))
        self.emit({"type": "spawned", "agent": row["id"], "parent": parent, "name": name, "mode": row["mode"]})
        self.tick()
        return row

    def _check_spawn(self, spec: dict) -> str | None:
        name = spec["name"].strip()
        if not name:
            return "name is required"
        if spec["mode"] not in ("request", "sequence", "continuous"):
            return f'unknown mode "{spec["mode"]}"'
        if spec["mode"] == "request" and len(spec.get("tasks", [])) != 1:
            return "a request agent takes exactly one task"
        if spec["mode"] == "sequence" and not spec.get("tasks"):
            return "a sequence agent takes at least one task"
        if spec["mode"] != "continuous" and spec.get("interval_s"):
            return "interval_s applies to continuous agents only"
        active = [a for a in self.list(False) if a["id"] not in (ROOT, SUPERVISOR)]
        if any(a["name"] == name for a in active):
            return f'an active agent is already named "{name}"'
        if len(active) >= self.opts.max_agents:
            return f"{len(active)} agents are already active, the most allowed (SEVEN_MAX_AGENTS)"
        return None

    def list(self, all: bool) -> list[AgentRow]:
        rows = self.opts.state.list_agents()
        return rows if all else [r for r in rows if r["status"] not in TERMINAL]

    def find(self, query: str) -> list[AgentRow]:
        words = [w for w in query.lower().split() if w]
        rows = [r for r in self.list(True)
                if all(w in f'{r["name"]} {r["description"]} {r["instructions"]}'.lower() for w in words)]
        return sorted(rows, key=lambda r: r["status"] in TERMINAL)

    def resolve(self, ref: str) -> AgentRow:
        by_id = self.opts.state.get_agent(ref)
        if by_id:
            return by_id
        named = [r for r in self.list(True) if r["name"] == ref]
        pick = next((r for r in reversed(named) if r["status"] not in TERMINAL), None) or (named[-1] if named else None)
        if not pick:
            raise RefusedError(f'no agent "{ref}"')
        return pick

    def send(self, frm: str, to_ref: str, text: str) -> str:
        try:
            to = self.resolve(to_ref)
        except RefusedError as err:
            return str(err)
        if to["id"] == frm:
            return "you cannot message yourself"
        if to["status"] in TERMINAL:
            result = f"; its result: {to['result'][:500]}" if to.get("result") else ""
            return f'{to["id"]} "{to["name"]}" is {to["status"]} and reads no more messages{result}'
        inbox_id = self.opts.state.send(frm, to["id"], "message", text)
        self.log.info("message sent", frm=frm, to=to["id"], inbox_id=inbox_id, chars=len(text))
        self.emit({"type": "message", "from": frm, "to": to["id"], "text": text})
        self.tick()
        return f'sent to {to["id"]} "{to["name"]}"'

    def user_message(self, ref: str, text: str) -> dict:
        to = self.resolve(ref)
        if to["status"] in TERMINAL:
            raise RefusedError(f'{to["id"]} "{to["name"]}" is {to["status"]} and reads no more messages')
        a = self.agent(to["id"])
        if to["mode"] == "interactive" and a is not None and not a.busy and not a.needs_resume():
            async def run_turn():
                try:
                    await a.turn({"text": text, "kind": "user"})
                except Exception as err:
                    self.log.error("driving an agent failed", agent=to["id"], error=err)
            asyncio.ensure_future(run_turn())
            return {"agent": to["id"], "turn_started": True}
        inbox_id = self.opts.state.send("user", to["id"], "message", text)
        self.log.info("message sent", frm="user", to=to["id"], inbox_id=inbox_id, chars=len(text))
        self.emit({"type": "message", "from": "user", "to": to["id"], "text": text})
        self.tick()
        return {"agent": to["id"], "queued": inbox_id}

    async def wait_message(self, agent_id: str, frm: str | None, timeout_ms: int, abort: asyncio.Event | None = None) -> dict | None:
        state = self.opts.state
        deadline = time.time() + timeout_ms / 1000
        while True:
            nxt = state.pending(agent_id, kind="message", sender=frm)
            if nxt:
                state.mark_delivered(nxt[0]["id"])
                return nxt[0]
            if time.time() >= deadline or (abort is not None and abort.is_set()) or self.closed:
                return None
            await asyncio.sleep(min(POLL_MS / 1000, max(0.0, deadline - time.time())))

    def stop(self, agent_id: str, by: str, reason: str | None = None) -> str:
        row = self.opts.state.get_agent(agent_id)
        if not row:
            return f'no agent "{agent_id}"'
        if agent_id in (ROOT, SUPERVISOR):
            return f"the {agent_id} cannot be stopped"
        if agent_id == by:
            return "an agent cannot stop itself; finish your turn instead"
        if row["status"] in TERMINAL:
            return f"{agent_id} is already {row['status']}"
        detail = f"stopped by {by}" + (f": {reason}" if reason else "")
        self.end(row, "stopped", detail)
        return f'stopped {agent_id} "{row["name"]}"'

    def status(self, row: dict) -> str:
        state = self.opts.state
        pending = state.pending(row["id"])
        lines = [
            f'{row["id"]} "{row["name"]}" · {row["mode"]} · {row["status"]}' + (f' · spawned by {row["parent"]}' if row.get("parent") else ""),
            f'description: {row["description"]}',
            *([f'instructions: {row["instructions"]}'] if row.get("instructions") else []),
            *([f'wakes every {row["interval_s"]}s when idle'] if row.get("interval_s") else []),
            f'created {row["created_at"]}; last turn {row.get("last_turn_at") or "never"}' + (f'; finished {row["finished_at"]}' if row.get("finished_at") else ""),
            f'inbox: {sum(1 for p in pending if p["kind"] == "task")} tasks and {sum(1 for p in pending if p["kind"] == "message")} messages waiting',
        ]
        if row.get("result") is not None:
            lines.append(f'result: {row["result"]}')
        else:
            last = self.agent(row["id"]).last_answer() if self.agent(row["id"]) else None
            if last:
                lines.append(f"last answer: {last[:2000]}")
        if row.get("error"):
            lines.append(f'error: {row["error"]}')
        return "\n".join(lines)

    def format_inbox(self, m: dict) -> str:
        if m["sender"] == "user":
            return f'[message from the user]\n{m["text"]}'
        sender = self.opts.state.get_agent(m["sender"])
        name = f' "{sender["name"]}"' if sender else ""
        return f'[message from {m["sender"]}{name}]\n{m["text"]}'

    # ── driving ──

    def tick(self) -> None:
        if self.closed:
            return
        self._consume_supervisor_inbox()
        self._drive_jobs()
        for row in self.opts.state.list_agents():
            if row["id"] in (ROOT, SUPERVISOR) or row["status"] in TERMINAL or row["mode"] == "supervisor":
                continue
            a = self.agent(row["id"])
            if a and not a.busy:
                asyncio.ensure_future(self._drive(a, row))

    async def _drive(self, a: Agent, row: dict) -> None:
        state = self.opts.state
        if self.retry_at.get(a.id, 0) > time.time():
            return
        inp = None
        if not a.needs_resume():
            pending = state.pending(a.id) if row["mode"] == "continuous" else state.pending(a.id, kind="task")
            nxt = pending[0] if pending else None
            if nxt:
                inp = ({"text": nxt["text"], "inbox_id": nxt["id"], "kind": "task"} if nxt["kind"] == "task"
                       else {"text": self.format_inbox(nxt), "inbox_id": nxt["id"], "kind": "message"})
            elif row["mode"] == "continuous":
                if not row.get("interval_s") or not _due(row):
                    if row["status"] != "idle":
                        state.update_agent(a.id, status="idle")
                    return
                inp = {"text": "[scheduled wake-up] Continue with your standing instructions.", "kind": "wake"}
            else:
                self.end(row, "done", a.last_answer() or "")
                return
        try:
            await a.turn(inp)
            if row["mode"] == "continuous" and not self.closed:
                now_row = state.get_agent(a.id)
                if now_row and now_row["status"] not in TERMINAL:
                    state.update_agent(a.id, status="idle")
        except Exception as err:
            current = state.get_agent(a.id)
            if self.closed or not current or current["status"] in TERMINAL:
                return
            message = str(err)
            if row["mode"] == "continuous":
                state.update_agent(a.id, status="idle", error=message)
                self.retry_at[a.id] = time.time() + RETRY_MS / 1000
                self.log.warn("continuous agent's turn failed; retrying later", agent=a.id, error=preview(message, 300), retry_in_ms=RETRY_MS)
            else:
                self.end(current, "failed", message)
            return
        self.tick()

    def end(self, row: dict, status: str, detail: str) -> None:
        state = self.opts.state
        a = self.agents.get(row["id"])
        if a:
            a.interrupt()
        self.runs.kill_all(row["id"])
        state.update_agent(row["id"], status=status, finished_at=now_iso(),
                           **({"result": detail} if status == "done" else {"error": detail}))
        (self.log.error if status == "failed" else self.log.info)("agent ended", agent=row["id"], status=status,
                                                                 mode=row["mode"], detail=preview(detail, 300))
        if row.get("parent"):
            head = "finished" if status == "done" else status
            state.send(row["id"], row["parent"], "message", f"{head}:\n{detail}")
            self.emit({"type": "message", "from": row["id"], "to": row["parent"], "text": f"{head}:\n{detail}"})
        self.emit({"type": "finished", "agent": row["id"], "status": status, "detail": detail})

    def emit(self, e: dict) -> None:
        if self.opts.on_event:
            self.opts.on_event(e)


def _agent_deps(opts: SupervisorOpts, supervisor: Supervisor, runs: RunTable, agent_id: str):
    from .agent import AgentDeps
    return AgentDeps(state=opts.state, store=opts.store, libstore=opts.libstore, runner=opts.runner, runs=runs, model=opts.model,
                     supervisor=supervisor, workspace=opts.workspace, max_steps=opts.max_steps,
                     context_tokens=opts.context_tokens, spill_chars=opts.spill_chars, memory_dir=opts.memory_dir,
                     core_tools=opts.core_tools, tool_discovery=opts.tool_discovery,
                     log=opts.log.child(agent=agent_id), on_event=opts.on_event)


def _due(row: dict) -> bool:
    if not row.get("interval_s"):
        return False
    base = row.get("last_turn_at") or row["created_at"]
    last = datetime.fromisoformat(base).timestamp()
    return time.time() - last >= row["interval_s"]


