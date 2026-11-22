"""Errors the agent layer raises at its boundaries."""


class RefusedError(Exception):
    """An operation was refused; the message is safe to show to agents and the API."""
