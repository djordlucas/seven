"""The HTTP surface: the FastAPI app and the companion UI it serves."""

from .app import create_app

__all__ = ["create_app"]
