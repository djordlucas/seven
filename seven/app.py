"""Wiring: config, state, tool store, runner, model and supervisor in one app,
with the workspace lease and an event bus the API streams to the UI."""

from __future__ import annotations

import asyncio
import time

from .agent.supervisor import Supervisor, SupervisorOpts
from .core.config import Config, load_config
from .core.llm import ChatModel, Mistral
from .core.log import Logger
from .core.state import State
from .execution.runner import Runner
from .tools import LibStore, ToolStore

LEASE_HEARTBEAT_S = 5


class SevenApp:
    def __init__(self, config: Config | None = None, *, model: ChatModel | None = None, log_stderr: bool | None = None):
        self.config = config or load_config()
        cfg = self.config
        stderr = log_stderr if log_stderr is not None else (cfg.log_stderr if cfg.log_stderr is not None else True)
        self.log = Logger(level=cfg.log_level, file=cfg.log_file, stderr=stderr)
        cfg.home.mkdir(parents=True, exist_ok=True)
        cfg.tools_dir.mkdir(parents=True, exist_ok=True)
        cfg.libs_dir.mkdir(parents=True, exist_ok=True)
        cfg.tmp_dir.mkdir(parents=True, exist_ok=True)
        self.state = State(cfg.state_db)
        self.store = ToolStore(self.state, cfg.tools_dir)
        self.libstore = LibStore(self.state, cfg.libs_dir, tool_store=self.store)
        self.model: ChatModel = model or Mistral(api_key=cfg.api_key, model=cfg.model, endpoint=cfg.endpoint,
                                                 concurrency=cfg.llm_concurrency)
        self.runner = Runner(home=cfg.home, cwd=str(cfg.workspace), timeout_ms=cfg.run_timeout_ms,
                             memory_mb=cfg.run_memory_mb, host={"llm": {"chat": self._host_llm_chat}}, log=self.log)
        self._subscribers: set[asyncio.Queue] = set()
        self.supervisor = Supervisor(SupervisorOpts(
            state=self.state, store=self.store, libstore=self.libstore, runner=self.runner, model=self.model,
            workspace=str(cfg.workspace), max_steps=cfg.max_steps, context_tokens=cfg.context_tokens,
            max_agents=cfg.max_agents, spill_chars=cfg.spill_chars, memory_dir=cfg.memory,
            delegate_timeout_s=cfg.delegate_timeout_s, core_tools=cfg.core_tools,
            tool_discovery=cfg.tool_discovery, on_event=self._broadcast, log=self.log,
        ))
        self._heartbeat: asyncio.Task | None = None
        self._lease_held = False
        self.started_at = time.time()

    async def _host_llm_chat(self, prompt: str, system: str | None = None) -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        out = await self.model.complete(messages=messages, log=self.log.child(component="host"))
        return out.message.get("content") or ""

    def acquire_lease(self) -> str | None:
        err = self.state.acquire_lease()
        if err is None:
            self._lease_held = True
        return err

    async def start(self) -> None:
        if not self._lease_held:
            err = self.acquire_lease()
            if err:
                raise RuntimeError(err)
        self.log.info("seven started", command="serve", model=self.config.model, workspace=str(self.config.workspace),
                      max_steps=self.config.max_steps, run_timeout_ms=self.config.run_timeout_ms)
        self.supervisor.start()
        self._heartbeat = asyncio.ensure_future(self._heartbeat_loop())

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(LEASE_HEARTBEAT_S)
            try:
                self.state.heartbeat_lease()
            except Exception:
                return

    async def shutdown(self) -> None:
        self.log.info("seven stopped")
        if self._heartbeat:
            self._heartbeat.cancel()
        await self.supervisor.shutdown()
        await self.runner.shutdown()
        await self.model.close()
        if self._lease_held:
            self.state.release_lease()
        self.state.close()

    def _broadcast(self, event: dict) -> None:
        for q in list(self._subscribers):
            q.put_nowait(event)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)
