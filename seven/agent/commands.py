"""The supervisor peer's inbox: line-based control commands. Mixed into Supervisor."""

from __future__ import annotations

from ..core.state import SUPERVISOR
from .errors import RefusedError


class CommandMixin:
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
            try:
                job = self.start_job(sender, kind, spec, agent=agent)
            except RefusedError as err:
                return f"error: {err}"
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

