"""FastAPI dependency that hands routes the running SevenApp."""

from __future__ import annotations

from fastapi import Request

from ..app import SevenApp


def get_seven(request: Request) -> SevenApp:
    return request.app.state.seven
