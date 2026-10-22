// Reading seven's log for `seven logs`: filter the JSON lines and print them
// readably, or follow the file as it grows.

import * as fs from "node:fs";
import { styleText } from "node:util";
import { LEVELS, type Level } from "./log.ts";

export type LogRecord = { t: string; level: Level; msg: string } & Record<string, unknown>;

export interface LogFilter {
  agent?: string;
  turn?: string;
  /** Matches a background run id (`run`, e.g. r3) or a runner id (`run_id`). */
  run?: string;
  /** Lowest level shown. */
  level?: Level;
  /** Case-insensitive substring of the raw line. */
  grep?: string;
}

/** Fields shown in the line's prefix rather than as key=value. */
const PREFIX = new Set(["t", "level", "msg", "agent", "turn", "step", "component"]);

export function parse(line: string): LogRecord | undefined {
  try {
    const r = JSON.parse(line) as LogRecord;
    return typeof r.msg === "string" && typeof r.level === "string" ? r : undefined;
  } catch {
    return undefined;
  }
}

export function matches(r: LogRecord, raw: string, f: LogFilter): boolean {
  if (f.agent && r.agent !== f.agent) return false;
  if (f.turn && r.turn !== f.turn) return false;
  if (f.run && r.run !== f.run && r.run_id !== f.run) return false;
  if (f.level && LEVELS.indexOf(r.level) < LEVELS.indexOf(f.level)) return false;
  if (f.grep && !raw.toLowerCase().includes(f.grep.toLowerCase())) return false;
  return true;
}

/** `14:05:09.123 INFO  a1 #3f2a1b9c s2  tool called  tool=run_js ok=true` */
export function format(r: LogRecord, color = false): string {
  const paint = (style: Parameters<typeof styleText>[0], s: string) => (color ? styleText(style, s) : s);
  const time = r.t.slice(11, 23);
  const level = r.level.toUpperCase().padEnd(5);
  const levelStyle = { debug: "dim", info: "green", warn: "yellow", error: "red" } as const;
  const where = [
    r.agent ?? r.component,
    r.turn ? `#${r.turn}` : undefined,
    r.step !== undefined ? `s${r.step}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const rest = Object.entries(r)
    .filter(([k]) => !PREFIX.has(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? (/[\s"]/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`)
    .join(" ");
  const parts: [Parameters<typeof styleText>[0] | undefined, string][] = [
    ["dim", time],
    [levelStyle[r.level] ?? "white", level],
    ["magenta", where],
    [undefined, r.msg],
    ["dim", rest],
  ];
  return parts
    .filter(([, s]) => s.length > 0)
    .map(([style, s]) => (style ? paint(style, s) : s))
    .join("  ");
}

/** Every line of the log, the rotated file first. */
export function readLines(file: string): string[] {
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
  return [...read(`${file}.1`), ...read(file)];
}

/** Call `onLine` for each line appended to `file` from now on, across rotations. Returns a stop function. */
export function follow(file: string, onLine: (line: string) => void, pollMs = 300): () => void {
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let partial = "";
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size < offset) offset = 0; // rotated: a new file started
    if (size === offset) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const parts = (partial + buf.toString("utf8")).split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) if (line) onLine(line);
  }, pollMs);
  return () => clearInterval(timer);
}
