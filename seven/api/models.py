"""Request bodies for the API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class SpawnRequest(BaseModel):
    name: str
    description: str = ""
    instructions: str = ""
    mode: str = "request"
    tasks: list[str] = Field(default_factory=list)
    interval_s: int | None = None
    max_steps: int | None = None


class MessageRequest(BaseModel):
    text: str


class StopRequest(BaseModel):
    reason: str | None = None


class DefineToolRequest(BaseModel):
    name: str
    description: str
    parameters: dict = Field(default_factory=lambda: {"type": "object"})
    code: str
    deps: dict[str, str] | None = None
    libs: list[str] | None = None
    test_args: dict | None = None
    timeout_ms: int | None = None


class DefineLibRequest(BaseModel):
    name: str
    description: str = ""
    code: str


class RebundleRequest(BaseModel):
    libs: list[str] | None = None


class DisableRequest(BaseModel):
    reason: str


class CallRequest(BaseModel):
    args: dict = Field(default_factory=dict)
    timeout_ms: int | None = None


class ExecRequest(BaseModel):
    code: str
    args: dict | None = None
    deps: dict[str, str] | None = None
    timeout_ms: int | None = None


class JobRequest(BaseModel):
    kind: str
    task: str = ""
    goal: str = ""
    instructions: str = ""
    interval_s: int | None = None
    max_turns: int = 20
    agent: str | None = None


class SkillRequest(BaseModel):
    name: str
    description: str = ""
    instructions: str = ""
    tools: list[str] = Field(default_factory=list)
