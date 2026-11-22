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
from dataclasses import dataclass
from datetime import UTC, datetime

from .agent import Agent
from .log import Logger, noop_logger, preview
from .runs import RunTable
from .state import ROOT_ID, TERMINAL, now_iso

POLL_MS = 250
RETRY_MS = 30_000
ROOT = ROOT_ID
SUPERVISOR = "supervisor"

GOAL_CHECK_SYSTEM = """You judge whether an AI agent has attained its goal. Look at the goal and the agent's latest report. Answer with exactly two lines: the first line is YES or NO, the second line is a one-sentence summary of the state (what is done, what remains)."""


@dataclass
class SupervisorOpts:
    state: object
    store: object
    runner: object
    model: object
    workspace: str
    max_steps: int
    context_tokens: int
    max_agents: int
    spill_chars: int = 2000
    memory_dir: object = None
    delegate_timeout_s: int = 600
    core_tools: tuple = ()
    tool_discovery: bool = True
    on_event: object = None
    log: Logger = noop_logger


class Supervisor:
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
            except (asyncio.CancelledError, Exception):
                pass
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

    def spawn(self, parent: str, spec: dict) -> dict | str:
        refused = self._check_spawn(spec)
        if refused:
            self.log.warn("spawn refused", parent=parent, name=spec["name"], mode=spec["mode"], reason=refused)
            return refused
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

    def list(self, all: bool) -> list[dict]:
        rows = self.opts.state.list_agents()
        return rows if all else [r for r in rows if r["status"] not in TERMINAL]

    def find(self, query: str) -> list[dict]:
        words = [w for w in query.lower().split() if w]
        rows = [r for r in self.list(True)
                if all(w in f'{r["name"]} {r["description"]} {r["instructions"]}'.lower() for w in words)]
        return sorted(rows, key=lambda r: r["status"] in TERMINAL)

    def resolve(self, ref: str) -> dict | str:
        by_id = self.opts.state.get_agent(ref)
        if by_id:
            return by_id
        named = [r for r in self.list(True) if r["name"] == ref]
        pick = next((r for r in reversed(named) if r["status"] not in TERMINAL), None) or (named[-1] if named else None)
        return pick if pick else f'no agent "{ref}"'

    def send(self, frm: str, to_ref: str, text: str) -> str:
        to = self.resolve(to_ref)
        if isinstance(to, str):
            return to
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

    def user_message(self, ref: str, text: str) -> dict | str:
        to = self.resolve(ref)
        if isinstance(to, str):
            return to
        if to["status"] in TERMINAL:
            return f'{to["id"]} "{to["name"]}" is {to["status"]} and reads no more messages'
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

    # ── jobs (R1) ──

    def start_job(self, created_by: str, kind: str, spec: dict, agent: str | None = None) -> dict | str:
        state = self.opts.state
        if kind not in ("task", "goal", "periodic"):
            return f'unknown job kind "{kind}"'
        if kind == "task" and not str(spec.get("task", "")).strip():
            return "a task job needs a task"
        if kind == "goal" and not str(spec.get("goal", "")).strip():
            return "a goal job needs a goal"
        if kind == "periodic" and not (spec.get("interval_s") and spec["interval_s"] > 0):
            return "a periodic job needs interval_s > 0"
        target = None
        owns_worker = False
        if agent is None:
            parent = created_by if created_by != "user" and state.get_agent(created_by) else ROOT
            worker = self.spawn(parent, {"name": f"job-{kind}", "description": f"worker for a {kind} job",
                                         "instructions": spec.get("instructions", ""), "mode": "continuous",
                                         "tasks": [], "interval_s": None, "max_steps": None})
            if isinstance(worker, str):
                return worker
            target = worker["id"]
            owns_worker = True
        else:
            r = self.resolve(agent)
            if isinstance(r, str):
                return r
            if r["id"] in (ROOT, SUPERVISOR):
                return f"the {r['id']} is never a job target"
            if kind == "periodic" and r["mode"] != "continuous":
                return "a periodic job needs a continuous agent"
            if r["status"] in TERMINAL:
                return f'{r["id"]} is {r["status"]} and cannot take a job'
            target = r["id"]
        spec = dict(spec)
        spec["owns_worker"] = owns_worker
        job = state.create_job(kind=kind, spec=spec, agent=target, created_by=created_by)
        if kind == "periodic":
            state.update_job(job["id"], next_run_at=now_iso())
        self.log.info("job started", job=job["id"], kind=kind, agent=target, created_by=created_by)
        self.emit({"type": "job_started", "job": job["id"], "kind": kind, "agent": target})
        self.tick()
        return job

    def stop_job(self, jid: str, by: str, reason: str | None = None) -> str:
        state = self.opts.state
        job = state.get_job(jid)
        if not job:
            return f'no job "{jid}"'
        if job["status"] not in ("running", "paused"):
            return f'{jid} is already {job["status"]}'
        if by != "user" and by != SUPERVISOR and job["created_by"] != by and job["agent"] != by:
            return "only the supervisor or the job's owner can stop it"
        detail = f"stopped by {by}" + (f": {reason}" if reason else "")
        if job["spec"].get("owns_worker"):
            self.stop(job["agent"], by, f"job {jid} stopped")
        state.update_job(jid, status="stopped", error=detail, finished_at=now_iso())
        self._notify_creator(job, f"job {jid} stopped: {detail}")
        self.emit({"type": "job_finished", "job": jid, "status": "stopped"})
        return f"stopped {jid}"

    def pause_job(self, jid: str) -> str:
        return self._set_job_status(jid, "paused", "running")

    def resume_job(self, jid: str) -> str:
        return self._set_job_status(jid, "running", "paused")

    def _set_job_status(self, jid: str, to: str, frm: str) -> str:
        job = self.opts.state.get_job(jid)
        if not job:
            return f'no job "{jid}"'
        if job["status"] != frm:
            return f'{jid} is {job["status"]}, not {frm}'
        self.opts.state.update_job(jid, status=to)
        self.emit({"type": "job_updated", "job": jid, "status": to})
        self.tick()
        return f"{to} {jid}"

    def _finish_job(self, job: dict, status: str, detail: str) -> None:
        state = self.opts.state
        state.update_job(job["id"], status=status, **({"result": detail} if status == "done" else {"error": detail}), finished_at=now_iso())
        if job["spec"].get("owns_worker"):
            row = state.get_agent(job["agent"])
            if row and row["status"] not in TERMINAL:
                self.stop(job["agent"], SUPERVISOR, f"job {job['id']} {status}")
        self._notify_creator(job, f"job {job['id']} {status}: {detail}")
        self.log.info("job finished", job=job["id"], kind=job["kind"], status=status, detail=preview(detail, 300))
        self.emit({"type": "job_finished", "job": job["id"], "status": status, "detail": detail})

    def _notify_creator(self, job: dict, text: str) -> None:
        if job["created_by"] != "user" and self.opts.state.get_agent(job["created_by"]):
            self.opts.state.send(SUPERVISOR, job["created_by"], "message", text)
            self.emit({"type": "message", "from": SUPERVISOR, "to": job["created_by"], "text": text})

    async def _goal_check(self, job: dict, answer: str) -> tuple[bool, str]:
        out = await self.opts.model.complete(
            messages=[
                {"role": "system", "content": GOAL_CHECK_SYSTEM},
                {"role": "user", "content": f"Goal:\n{job['spec'].get('goal', '')}\n\nThe agent's latest report:\n{answer}\n\nHas the goal been attained?"},
            ],
            log=self.log.child(job=job["id"]),
        )
        text = (out.message.get("content") or "").strip()
        first = text.splitlines()[0].strip().upper() if text else ""
        return first.startswith("YES"), text

    def _drive_jobs(self) -> None:
        state = self.opts.state
        for job in state.list_jobs(all=False):
            if job["status"] != "running":
                continue
            agent = state.get_agent(job["agent"])
            if not agent or agent["status"] in TERMINAL:
                if job["kind"] == "task" and agent and agent.get("result"):
                    self._finish_job(job, "done", agent["result"])
                else:
                    self._finish_job(job, "failed", f'agent {job["agent"]} is {agent["status"] if agent else "gone"}')
                continue
            a = self.agent(job["agent"])
            if a and a.busy:
                continue
            spec = job["spec"]
            if job.get("queued"):
                if agent["last_turn_at"] != job.get("last_turn_at"):
                    state.update_job(job["id"], turns=job["turns"] + 1, last_turn_at=agent["last_turn_at"], queued=0)
                    self._on_turn_complete(job, agent)
                continue
            if job["kind"] == "periodic":
                nxt = job.get("next_run_at")
                if nxt and datetime.fromisoformat(nxt) > datetime.now(UTC):
                    continue
                text = spec.get("instructions") or "[scheduled wake-up] Continue with your standing instructions."
                state.enqueue(agent["id"], sender=SUPERVISOR, kind="task", text=text)
                state.update_job(job["id"], queued=1, last_turn_at=agent["last_turn_at"], next_run_at=None)
                continue
            if job["kind"] == "task":
                text = spec["task"] + (f'\n\nInstructions: {spec["instructions"]}' if spec.get("instructions") else "")
                state.enqueue(agent["id"], sender=SUPERVISOR, kind="task", text=text)
            else:  # goal
                progress = f'\n\nProgress so far (turn {job["turns"] + 1}): see the conversation above.' if job["turns"] else ""
                text = f'Work toward this goal: {spec["goal"]}' + (f'\n\nInstructions: {spec["instructions"]}' if spec.get("instructions") else "") + progress
                state.enqueue(agent["id"], sender=SUPERVISOR, kind="task", text=text)
            state.update_job(job["id"], queued=1, last_turn_at=agent["last_turn_at"])

    def _on_turn_complete(self, job: dict, agent: dict) -> None:
        state = self.opts.state
        a = self.agent(job["agent"])
        answer = a.last_answer() if a else None
        if job["kind"] == "task":
            self._finish_job(job, "done", answer or "")
        elif job["kind"] == "periodic":
            interval = job["spec"].get("interval_s", 60)
            state.update_job(job["id"], next_run_at=_iso_in(seconds=interval))
        else:  # goal
            max_turns = job["spec"].get("max_turns", 20)
            if job["turns"] + 1 >= max_turns:
                self._finish_job(job, "failed", f"goal not attained within {max_turns} turns; last answer: {(answer or '')[:500]}")
                return
            asyncio.ensure_future(self._goal_check_and_maybe_finish(job, answer or ""))

    async def _goal_check_and_maybe_finish(self, job: dict, answer: str) -> None:
        try:
            met, summary = await self._goal_check(job, answer)
        except Exception as err:
            self.log.error("goal check failed", job=job["id"], error=err)
            return
        current = self.opts.state.get_job(job["id"])
        if not current or current["status"] != "running":
            return
        if met:
            self._finish_job(current, "done", summary)

    # ── supervisor inbox: line-based control commands (R1/R2) ──

    def _consume_supervisor_inbox(self) -> None:
        state = self.opts.state
        for item in state.pending(SUPERVISOR, kind="message"):
            state.mark_delivered(item["id"])
            reply = self._handle_command(item["sender"], item["text"])
            if reply and item["sender"] != "user" and state.get_agent(item["sender"]):
                state.send(SUPERVISOR, item["sender"], "message", reply)
                self.emit({"type": "message", "from": SUPERVISOR, "to": item["sender"], "text": reply})

    def _handle_command(self, sender: str, text: str) -> str:
        parts = text.strip().split()
        if not parts:
            return "empty command"
        cmd = parts[0].lower()
        if cmd == "start" and len(parts) >= 3 and parts[1] == "job":
            kind = parts[2].lower()
            rest = " ".join(parts[3:])
            agent = None
            if rest.startswith("on "):
                toks = rest.split(None, 2)
                agent = toks[1] if len(toks) > 1 else None
                rest = toks[2] if len(toks) > 2 else ""
            spec: dict = {}
            if kind == "task":
                spec = {"task": rest}
            elif kind == "goal":
                spec = {"goal": rest}
            elif kind == "periodic":
                toks = rest.split(None, 1)
                try:
                    spec = {"interval_s": int(toks[0]), "instructions": toks[1] if len(toks) > 1 else ""}
                except (ValueError, IndexError):
                    return "usage: start job periodic <interval_s> <instructions>"
            else:
                return f'unknown job kind "{kind}" (task, goal, periodic)'
            job = self.start_job(sender, kind, spec, agent=agent)
            if isinstance(job, str):
                return f"error: {job}"
            return f"started {job['id']} ({kind}) on {job['agent']}"
        if cmd in ("stop", "pause", "resume") and len(parts) >= 2:
            jid = parts[1]
            fn = {"stop": self.stop_job, "pause": self.pause_job, "resume": self.resume_job}[cmd]
            out = fn(jid, SUPERVISOR, " ".join(parts[2:]) or None) if cmd == "stop" else fn(jid)
            return out if out.startswith(("stopped", "paused", "running")) else f"error: {out}"
        if cmd == "jobs":
            rows = self.opts.state.list_jobs(all=True)
            return "\n".join(f'{j["id"]} {j["kind"]} {j["status"]} agent={j["agent"]} turns={j["turns"]}' for j in rows) or "no jobs"
        if cmd == "agents":
            return "\n".join(f'{a["id"]} "{a["name"]}" {a["mode"]} {a["status"]}' for a in self.list(False)) or "no agents"
        if cmd == "status":
            jobs = self.opts.state.list_jobs(all=False)
            agents = self.list(False)
            return f"agents: {len(agents)} active; jobs: {len(jobs)} running/paused"
        return f'unknown command "{text}" — try: start job <task|goal|periodic> [on <agent>] …, stop|pause|resume <job>, jobs, agents, status'

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
    return AgentDeps(state=opts.state, store=opts.store, runner=opts.runner, runs=runs, model=opts.model,
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


def _iso_in(seconds: float) -> str:
    return datetime.fromtimestamp(time.time() + seconds, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
