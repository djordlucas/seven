"""One agent's loop: ask the model, run the tools it calls, repeat until it
answers without calling one. Its conversation lives in the state database, one
row per message, so a turn cut off by a restart resumes where it stopped."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass

from .builtins import builtins
from .builtins.shared import await_run, disabled_error, format_run, start_generated
from .compact import (
    COMPACT_AT,
    KEEP,
    TokenEstimator,
    cut_index,
    is_overflow,
    request_chars,
    summarize_conversation,
)
from .llm import ChatModel, Completion, ToolDef
from .log import Logger, noop_logger, preview
from .prompt import system_prompt
from .runner import Runner
from .runs import RunTable, summarize
from .state import State, now_iso

MAX_RESULT_CHARS = 16_000


@dataclass
class AgentDeps:
    state: State
    store: object
    runner: Runner
    runs: RunTable
    model: ChatModel
    supervisor: object
    workspace: str
    max_steps: int
    context_tokens: int
    log: Logger = noop_logger
    on_event: object = None


class Agent:
    def __init__(self, deps: AgentDeps, agent_id: str):
        self.deps = deps
        self.id = agent_id
        self.abort: asyncio.Event | None = None
        self.turning = False
        self.estimator = TokenEstimator()

    @property
    def busy(self) -> bool:
        return self.turning

    def row(self) -> dict:
        row = self.deps.state.get_agent(self.id)
        if not row:
            raise RuntimeError(f"agent {self.id} is gone")
        return row

    def needs_resume(self) -> bool:
        hist = self.deps.state.history(self.id)
        last = hist[-1]["message"] if hist else None
        return last is not None and last.get("role") in ("user", "tool")

    def repair(self) -> None:
        hist = self.deps.state.history(self.id)
        last_assistant = -1
        for i in range(len(hist) - 1, -1, -1):
            if hist[i]["message"].get("role") == "assistant":
                last_assistant = i
                break
        calls = hist[last_assistant]["message"].get("tool_calls") if last_assistant >= 0 else None
        if not calls:
            return
        answered = {m["message"].get("tool_call_id") for m in hist[last_assistant + 1:] if m["message"].get("role") == "tool"}
        cut = [c for c in calls if c["id"] not in answered]
        if cut:
            self.deps.log.warning("interrupted tool calls closed", tools=[c["function"]["name"] for c in cut])
        for c in cut:
            self.append({"role": "tool", "tool_call_id": c["id"], "name": c["function"]["name"],
                         "content": "error: interrupted — seven restarted before this call finished"})

    def interrupt(self) -> None:
        if self.abort is not None:
            self.abort.set()

    async def turn(self, inp: dict | None = None) -> str:
        if self.turning:
            raise RuntimeError(f"agent {self.id} is already in a turn")
        self.turning = True
        self.abort = asyncio.Event()
        state = self.deps.state
        log = self.deps.log.child(turn=uuid.uuid4().hex[:8])
        started = time.time()
        steps = 0
        log.info("turn started", inp=inp.get("kind", "user") if inp else "resume",
                 **({"inbox_id": inp["inbox_id"]} if inp and inp.get("inbox_id") is not None else {}),
                 **({"text": preview(inp["text"])} if inp and log.enabled("debug") else {}))
        try:
            state.update_agent(self.id, status="running")
            if inp:
                def work():
                    self.append({"role": "user", "content": inp["text"]})
                    if inp.get("inbox_id") is not None:
                        state.mark_delivered(inp["inbox_id"])
                state.tx(work)
            max_steps = self.row().get("max_steps") or self.deps.max_steps
            for step in range(max_steps):
                steps = step + 1
                step_log = log.child(step=steps)
                self.deliver_messages(step_log)
                message = (await self.complete(step_log)).message
                self.append(message)
                if not message.get("tool_calls"):
                    answer = message.get("content") or ""
                    log.info("turn finished", outcome="answered", steps=steps, duration_ms=round((time.time() - started) * 1000),
                             answer_chars=len(answer), **({"answer": preview(answer)} if log.enabled("debug") else {}))
                    self.emit({"type": "answer", "agent": self.id, "text": answer})
                    return answer
                for call in message["tool_calls"]:
                    result = _truncate(await self.dispatch(call, step_log))
                    self.append({"role": "tool", "tool_call_id": call["id"], "name": call["function"]["name"], "content": result})
            stopped = f"Stopped after {max_steps} steps without a final answer."
            log.warning("turn finished", outcome="max_steps", steps=steps, duration_ms=round((time.time() - started) * 1000))
            self.append({"role": "assistant", "content": stopped})
            self.emit({"type": "answer", "agent": self.id, "text": stopped})
            return stopped
        except Exception as err:
            aborted = self.abort is not None and self.abort.is_set()
            if aborted:
                log.info("turn ended early", outcome="interrupted", steps=steps, duration_ms=round((time.time() - started) * 1000))
            else:
                log.error("turn ended early", outcome="error", steps=steps, duration_ms=round((time.time() - started) * 1000), error=err)
            raise
        finally:
            self.turning = False
            self.abort = None
            row = state.get_agent(self.id)
            patch = {"last_turn_at": now_iso()}
            if row and row["status"] == "running":
                patch["status"] = "idle"
            state.update_agent(self.id, **patch)

    def last_answer(self) -> str | None:
        for m in reversed(self.deps.state.history(self.id)):
            msg = m["message"]
            if msg.get("role") == "assistant" and not msg.get("tool_calls"):
                return msg.get("content")
        return None

    async def compact(self, reason: str, log: Logger | None = None) -> dict | None:
        log = log or self.deps.log
        state = self.deps.state
        rows = state.context(self.id)
        cut = cut_index([r["message"] for r in rows], self.estimator.chars(self.deps.context_tokens * KEEP))
        if cut == 0:
            log.warning("context not compacted", reason=reason, detail="nothing to fold", messages=len(rows))
            return None
        started = time.time()
        before = self.estimator.tokens(request_chars([r["message"] for r in rows], []))
        summary = await summarize_conversation(
            self.deps.model, previous=self.row().get("summary"),
            messages=[r["message"] for r in rows[:cut]], context_tokens=self.deps.context_tokens,
            estimator=self.estimator, abort=self.abort, log=log,
        )
        state.compact(self.id, summary, rows[cut - 1]["id"])
        after = self.estimator.tokens(request_chars(state.history(self.id), []) + len(summary))
        out = {"folded": cut, "kept": len(rows) - cut}
        log.info("context compacted", reason=reason, **out, tokens_before=before, tokens_after=after,
                 summary_chars=len(summary), compactions=self.row()["compactions"], duration_ms=round((time.time() - started) * 1000),
                 **({"summary": preview(summary)} if log.enabled("debug") else {}))
        self.emit({"type": "compacted", "agent": self.id, **out})
        return out

    async def complete(self, log: Logger) -> Completion:
        window = self.deps.context_tokens
        req = self.request()
        if self.estimator.tokens(req["chars"]) > window * COMPACT_AT:
            try:
                if await self.compact("threshold", log):
                    req = self.request()
            except Exception as err:
                if self.abort is not None and self.abort.is_set():
                    raise
                log.error("context compaction failed", reason="threshold", error=err)
        try:
            return await self.send(req, log)
        except Exception as err:
            if (self.abort is not None and self.abort.is_set()) or not is_overflow(err):
                raise
            log.warning("context overflowed", tokens_estimated=self.estimator.tokens(req["chars"]), window=window)
            if not await self.compact("overflow", log):
                raise
            return await self.send(self.request(), log)

    async def send(self, req: dict, log: Logger) -> Completion:
        out = await self.deps.model.complete(messages=req["messages"], tools=req["tools"], abort=self.abort, log=log)
        self.estimator.calibrate(req["chars"], (out.usage or {}).get("prompt_tokens"))
        return out

    def request(self) -> dict:
        tools, system = self.context()
        history = [m["message"] for m in self.deps.state.history(self.id)]
        lead = [{"role": "user", "content": "(Earlier messages are summarized in the system prompt. Continue.)"}] if history and history[0].get("role") != "user" else []
        messages = [system, *lead, *history]
        return {"messages": messages, "tools": tools, "chars": request_chars(messages, tools)}

    def deliver_messages(self, log: Logger) -> None:
        state = self.deps.state
        for m in state.pending(self.id, kind="message"):
            def work(m=m):
                self.append({"role": "user", "content": self.deps.supervisor.format_inbox(m)})
                state.mark_delivered(m["id"])
            state.tx(work)
            log.info("message delivered", sender=m["sender"], inbox_id=m["id"], chars=len(m["text"]))

    def context(self) -> tuple[list[ToolDef], dict]:
        store = self.deps.store
        own = store.list()
        bl = builtins()
        tools = [ToolDef(name=b.name, description=b.description, parameters=b.parameters) for b in bl.values()]
        tools += [ToolDef(name=t["name"], description=t["description"], parameters=t["parameters"]) for t in own if not t.get("disabled")]
        my_runs = [summarize(r, self.deps.runs.handle(r["id"])) for r in self.deps.runs.list(self.id)
                   if r["status"] == "running" or not r["checked"]]
        content = system_prompt(workspace=self.deps.workspace, self=self.row(), tools=own, runs=my_runs,
                                agents=[a for a in self.deps.supervisor.list(False) if a["id"] != self.id])
        return tools, {"role": "system", "content": content}

    async def dispatch(self, call: dict, step_log: Logger) -> str:
        name = call["function"]["name"]
        raw = call["function"]["arguments"]
        log = step_log.child(call=call["id"])
        self.emit({"type": "tool_call", "agent": self.id, "name": name, "args": raw})
        started = time.time()
        kind = "unknown"
        try:
            args = json.loads(raw) if raw else {}
            if not isinstance(args, dict):
                args = {}
            builtin = builtins().get(name)
            own = None if builtin else self.deps.store.get(name)
            if builtin:
                kind = "builtin"
                result = await builtin.run(args, self.builtin_context(log))
            elif own and own["meta"].get("disabled"):
                kind = "generated"
                result = disabled_error(own)
            elif own:
                kind = "generated"
                ctx = self.builtin_context(log)
                result = format_run(await await_run(start_generated(ctx, own, args, "sync"), ctx.abort))
            else:
                result = f'error: no tool named "{name}"'
        except Exception as err:
            result = f"error: {err}"
        failed = result.startswith(("error:", "not saved:"))
        getattr(log, "warn" if failed else "info")("tool called", tool=name, kind=kind, ok=not failed,
                                                   duration_ms=round((time.time() - started) * 1000), result_chars=len(result),
                                                   **({"error": preview(result, 300)} if failed else {}),
                                                   **({"args": preview(raw), "result": preview(result)} if log.enabled("debug") else {}))
        self.emit({"type": "tool_result", "agent": self.id, "name": name, "result": result})
        return result

    def builtin_context(self, log: Logger):
        from .builtins.shared import BuiltinContext
        return BuiltinContext(agent_id=self.id, runner=self.deps.runner, store=self.deps.store, runs=self.deps.runs,
                              supervisor=self.deps.supervisor, workspace=self.deps.workspace,
                              state_db=self.deps.state.path, abort=self.abort, log=log)

    def append(self, message: dict) -> None:
        self.deps.state.append_message(self.id, message)
        self.emit({"type": "message", "agent": self.id, "message": message})

    def emit(self, e: dict) -> None:
        if self.deps.on_event:
            self.deps.on_event(e)


def _truncate(s: str) -> str:
    if len(s) <= MAX_RESULT_CHARS:
        return s
    return f"{s[:MAX_RESULT_CHARS]}\n… [truncated {len(s) - MAX_RESULT_CHARS} of {len(s)} characters]"
