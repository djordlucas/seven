"""Jobs (R1): autonomous work the supervisor drives on an agent — until a
task is done, until a goal is attained, or periodically. Mixed into Supervisor."""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime

from ..core.log import preview
from ..core.state import ROOT_ID, SUPERVISOR, TERMINAL, Job, now_iso
from .errors import RefusedError

ROOT = ROOT_ID

GOAL_CHECK_SYSTEM = """You judge whether an AI agent has attained its goal. Look at the goal and the agent's latest report. Answer with exactly two lines: the first line is YES or NO, the second line is a one-sentence summary of the state (what is done, what remains)."""


class JobMixin:
    # ── jobs (R1) ──

    def start_job(self, created_by: str, kind: str, spec: dict, agent: str | None = None) -> Job:
        state = self.opts.state
        if kind not in ("task", "goal", "periodic"):
            raise RefusedError(f'unknown job kind "{kind}"')
        if kind == "task" and not str(spec.get("task", "")).strip():
            raise RefusedError("a task job needs a task")
        if kind == "goal" and not str(spec.get("goal", "")).strip():
            raise RefusedError("a goal job needs a goal")
        if kind == "periodic" and not (spec.get("interval_s") and spec["interval_s"] > 0):
            raise RefusedError("a periodic job needs interval_s > 0")
        target = None
        owns_worker = False
        if agent is None:
            parent = created_by if created_by != "user" and state.get_agent(created_by) else ROOT
            worker = self.spawn(parent, {"name": f"job-{kind}", "description": f"worker for a {kind} job",
                                         "instructions": spec.get("instructions", ""), "mode": "continuous",
                                         "tasks": [], "interval_s": None, "max_steps": None})
            target = worker["id"]
            owns_worker = True
        else:
            r = self.resolve(agent)
            if r["id"] in (ROOT, SUPERVISOR):
                raise RefusedError(f"the {r['id']} is never a job target")
            if kind == "periodic" and r["mode"] != "continuous":
                raise RefusedError("a periodic job needs a continuous agent")
            if r["status"] in TERMINAL:
                raise RefusedError(f'{r["id"]} is {r["status"]} and cannot take a job')
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



def _iso_in(seconds: float) -> str:
    return datetime.fromtimestamp(time.time() + seconds, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
