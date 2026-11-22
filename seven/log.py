"""Structured JSON-lines logging: one object per line, with the context it belongs to."""

from __future__ import annotations

import json
import os
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}
ROTATE_AT = 50 * 1024 * 1024


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def preview(s: object, n: int = 500) -> str:
    text = s if isinstance(s, str) else json.dumps(s, default=str)
    return text if len(text) <= n else text[:n] + f"… [{len(text) - n} chars cut]"


class Logger:
    def __init__(self, ctx: dict | None = None, level: str = "info", file: Path | None = None, stderr: bool = False):
        self.ctx = dict(ctx or {})
        self.level = level
        self.file = file
        self.stderr = stderr
        self._lock = threading.Lock()

    def child(self, **extra) -> Logger:
        return Logger({**self.ctx, **extra}, self.level, self.file, self.stderr)

    def enabled(self, level: str) -> bool:
        return LEVELS[level] >= LEVELS[self.level]

    def log(self, level: str, msg: str, **fields) -> None:
        if not self.enabled(level):
            return
        line = {"t": now_iso(), "level": level, "msg": msg, "pid": os.getpid(), **self.ctx}
        for k, v in fields.items():
            if isinstance(v, BaseException):
                line[k] = str(v)
                line[k + "_stack"] = "" if not getattr(v, "__traceback__", None) else repr(v)
            else:
                line[k] = v
        text = json.dumps(line, default=str)
        with self._lock:
            if self.file is not None:
                self.file.parent.mkdir(parents=True, exist_ok=True)
                if self.file.exists() and self.file.stat().st_size >= ROTATE_AT:
                    rotated = self.file.with_suffix(self.file.suffix + ".1")
                    rotated.unlink(missing_ok=True)
                    self.file.rename(rotated)
                with self.file.open("a", encoding="utf-8") as f:
                    f.write(text + "\n")
                    f.flush()
            if self.stderr:
                sys.stderr.write(text + "\n")
                sys.stderr.flush()

    def debug(self, msg: str, **fields) -> None:
        self.log("debug", msg, **fields)

    def info(self, msg: str, **fields) -> None:
        self.log("info", msg, **fields)

    def warn(self, msg: str, **fields) -> None:
        self.log("warn", msg, **fields)

    def warning(self, msg: str, **fields) -> None:
        self.warn(msg, **fields)

    def error(self, msg: str, **fields) -> None:
        self.log("error", msg, **fields)


noop_logger = Logger(level="error")


def read_log(log_file: Path, agent: str | None = None, turn: str | None = None, run: str | None = None,
             level: str | None = None, grep: str | None = None, tail: int = 100) -> list[dict]:
    files = []
    if log_file is not None:
        files.append(log_file)
        rotated = log_file.with_suffix(log_file.suffix + ".1")
        if rotated.exists():
            files.insert(0, rotated)
    lines: list[str] = []
    for f in files:
        if f.exists():
            lines.extend(f.read_text(encoding="utf-8", errors="replace").splitlines())
    out: list[dict] = []
    min_level = LEVELS.get(level, 0)
    needle = grep.lower() if grep else None
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if agent and rec.get("agent") != agent:
            continue
        if turn and rec.get("turn") != turn:
            continue
        if run and rec.get("run") != run and rec.get("run_id") != run:
            continue
        if LEVELS.get(rec.get("level", "info"), 20) < min_level:
            continue
        if needle and needle not in line.lower():
            continue
        out.append(rec)
    if tail > 0:
        out = out[-tail:]
    return out


def format_readable(rec: dict) -> str:
    t = str(rec.get("t", ""))[11:23]
    level = str(rec.get("level", "info")).upper()
    ctx = " ".join(
        str(rec[k])
        for k in ("agent", "turn", "step", "call", "run", "run_id", "component")
        if rec.get(k) is not None
    )
    extra = " ".join(f"{k}={v}" for k, v in rec.items() if k not in ("t", "level", "msg", "pid", "agent", "turn", "step", "call", "run", "run_id", "component"))
    parts = [p for p in (t, f"{level:<6}", ctx, str(rec.get("msg", "")), f"pid={rec.get('pid', '')}", extra) if p]
    return "  ".join(parts)
