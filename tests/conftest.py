from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fake_model import ScriptedModel

from seven.agent import Supervisor, SupervisorOpts
from seven.core.config import load_config
from seven.core.log import Logger
from seven.core.state import State
from seven.execution.runner import Runner
from seven.execution.runs import RunTable
from seven.tools import ToolStore


def make_config(tmp_path, **overrides) -> object:
    env = {
        "SEVEN_WORKSPACE": str(tmp_path),
        "SEVEN_LLM_API_KEY": "test-key",
        "SEVEN_RUN_TIMEOUT_MS": "8000",
        "SEVEN_RUN_MEMORY_MB": "512",
        "SEVEN_LOG_LEVEL": "debug",
        **{k: str(v) for k, v in overrides.items()},
    }
    return load_config(env)


@pytest.fixture
def env(tmp_path):
    cfg = make_config(tmp_path)
    log = Logger(level="debug", file=cfg.log_file, stderr=False)
    state = State(cfg.state_db)
    store = ToolStore(state, cfg.tools_dir)
    model = ScriptedModel()

    async def host_chat(prompt, system=None):
        return f"host reply to: {prompt}"

    runner = Runner(home=cfg.home, cwd=str(cfg.workspace), timeout_ms=cfg.run_timeout_ms,
                    memory_mb=cfg.run_memory_mb, host={"llm": {"chat": host_chat}}, log=log)
    runs = RunTable(state, log)
    sup = Supervisor(SupervisorOpts(state=state, store=store, runner=runner, model=model,
                                    workspace=str(cfg.workspace), max_steps=10, context_tokens=128_000,
                                    max_agents=4, log=log))
    return SimpleNamespace(cfg=cfg, log=log, state=state, store=store, model=model, runner=runner,
                           runs=runs, sup=sup)


@pytest.fixture
async def started_env(env):
    env.sup.start()
    yield env
    await env.sup.shutdown()
    await env.runner.shutdown()
    env.state.close()


async def until(predicate, timeout: float = 10.0, interval: float = 0.05) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()
