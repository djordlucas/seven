"""Jobs (R1): autonomous work the supervisor drives — until a goal is attained,
until a task is done, or periodically. Agents may attach a job to themselves
only; assigning one to another agent is the supervisor's job."""

from __future__ import annotations

from ...agent.errors import RefusedError
from .shared import Builtin, BuiltinContext, positive


def job_builtins() -> list:
    return [
        Builtin(
            name="start_job",
            description="Start an autonomous job that the supervisor drives on an agent, persisted across restarts. "
                        "kind=task runs until the task is done; kind=goal runs until the goal is attained (checked after "
                        "each turn, at most max_turns); kind=periodic wakes every interval_s. You may attach a job to "
                        "yourself only (agent=your own id) or omit agent to spawn a dedicated worker; only the supervisor "
                        "can assign a job to another agent.",
            parameters={
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["task", "goal", "periodic"]},
                    "task": {"type": "string", "description": "task: what to do until done."},
                    "goal": {"type": "string", "description": "goal: what must be attained."},
                    "instructions": {"type": "string"},
                    "interval_s": {"type": "integer", "description": "periodic only: wake this often."},
                    "max_turns": {"type": "integer", "description": "goal only: turn limit before the job fails. Default 20."},
                    "agent": {"type": "string", "description": "Your own id (or omit to spawn a worker). Other agents: supervisor only."},
                },
                "required": ["kind"],
            },
            run=_start_job,
        ),
        Builtin(
            name="stop_job",
            description="Stop a job (yours, or any if you are the supervisor). The job's worker, if it spawned one, is stopped.",
            parameters={"type": "object", "properties": {"id": {"type": "string"}, "reason": {"type": "string"}}, "required": ["id"]},
            run=_stop_job,
        ),
        Builtin(
            name="list_jobs",
            description="List jobs: id, kind, status, agent, turns, result or error.",
            parameters={"type": "object", "properties": {"all": {"type": "boolean", "description": "Include finished jobs. Default false."}}},
            run=_list_jobs,
        ),
    ]


async def _start_job(a: dict, ctx: BuiltinContext) -> str:
    sup = ctx.supervisor
    kind = str(a.get("kind", ""))
    agent = a.get("agent")
    if agent is not None and str(agent) != ctx.agent_id:
        return "error: only the supervisor can assign a job to another agent"
    spec = {
        "task": str(a.get("task", "")),
        "goal": str(a.get("goal", "")),
        "instructions": str(a.get("instructions", "")),
        "interval_s": positive(a.get("interval_s"), 0) or None,
        "max_turns": positive(a.get("max_turns"), 20),
    }
    try:
        job = sup.start_job(ctx.agent_id, kind, spec, agent=str(agent) if agent is not None else None)
    except RefusedError as err:
        return f"error: {err}"
    return f'started {job["id"]} ({kind}) on {job["agent"]}'


async def _stop_job(a: dict, ctx: BuiltinContext) -> str:
    out = ctx.supervisor.stop_job(str(a.get("id", "")), ctx.agent_id, None if a.get("reason") is None else str(a["reason"]))
    return out if out.startswith("stopped") else f"error: {out}"


async def _list_jobs(a: dict, ctx: BuiltinContext) -> str:
    rows = ctx.state.list_jobs(all=a.get("all") is True)
    if not rows:
        return "no jobs"
    lines = []
    for j in rows:
        line = f'{j["id"]} {j["kind"]} · {j["status"]} · agent {j["agent"]} · turns {j["turns"]} · by {j["created_by"]}'
        if j.get("result"):
            line += f'\n  result: {j["result"][:500]}'
        if j.get("error"):
            line += f'\n  error: {j["error"][:500]}'
        lines.append(line)
    return "\n".join(lines)
