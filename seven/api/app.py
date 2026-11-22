"""The FastAPI app: lifespan over SevenApp, the UI at /, and the API routers."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..app import SevenApp
from ..core.config import load_config
from .common import UI_DIR
from .routes import agents, jobs, memory, meta, runs, skills, tools


def create_app(seven: SevenApp | None = None) -> FastAPI:
    seven = seven or SevenApp(load_config())

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await seven.start()
        yield
        await seven.shutdown()

    app = FastAPI(title="seven", version=__version__, lifespan=lifespan)
    app.state.seven = seven

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(UI_DIR / "index.html")

    app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")

    for r in (meta.router, agents.router, tools.router, runs.router, jobs.router, skills.router, memory.router):
        app.include_router(r)

    return app
