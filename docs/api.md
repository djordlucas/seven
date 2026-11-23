# The API

`seven serve` runs one FastAPI app: the REST API under `/api/…`, a live event
stream at `/api/events`, and the [UI](ui.md) at `/`. The API is the only way
into a running seven — the same endpoints the UI uses.

```bash
seven serve --host 127.0.0.1 --port 8000
curl http://127.0.0.1:8000/api/health
```

Interactive docs (OpenAPI) are at `/docs` while the server runs.

## Endpoints

| Method & path | Does |
|---------------|------|
| `GET /api/health` | Version, workspace, active agent count, uptime. |
| `GET /api/config` | Configuration, with `api_key_set` instead of the key. |
| `GET /api/agents?all=` | Agents with mode, status, inbox counts, last answer. |
| `POST /api/agents` | Spawn an agent (spawned by the root): `name`, `description`, `instructions`, `mode`, `tasks`, `interval_s`, `max_steps`. 201, or 409 with the refusal. |
| `GET /api/agents/{id}` | One agent in detail (id or name). |
| `GET /api/agents/{id}/messages?limit=&offset=` | The conversation transcript, oldest first. |
| `POST /api/agents/{id}/messages` | Send `{"text"}` from the user. To the idle root agent it starts a turn at once (202 `{"turn_started": true}`); otherwise it queues an inbox message (202 `{"queued": n}`). 409 for terminal or unknown agents. |
| `GET /api/agents/{id}/inbox` | Undelivered inbox items. |
| `GET /api/agents/{id}/outbox` | What the peer has sent: recipient, kind, text, delivered. |
| `POST /api/agents/{id}/stop` | Stop an agent (`{"reason"?}`); refused for the root. |
| `POST /api/agents/{id}/compact` | Compact the conversation now; 409 when there is nothing to fold. |
| `DELETE /api/agents/{id}/conversation` | Clear the conversation and summary. |
| `GET /api/tools` | Generated tools with revision, state, run limit. |
| `POST /api/tools` | Define one: `name`, `description`, `parameters`, `code`, optional `deps`, `test_args`, `timeout_ms`. Runs the trial first when `test_args` is set. 400 on a bad name, syntax error or failed trial. |
| `GET /api/tools/{name}` | Definition and source, plus the skills using it. |
| `DELETE /api/tools/{name}` | Delete it and its history; 409 naming the skills while one uses it. |
| `POST /api/tools/{name}/disable` | `{"reason"}`; calls are refused while disabled. |
| `POST /api/tools/{name}/enable` | Re-enable unchanged. |
| `GET /api/tools/{name}/health?last=` | The `tool_health` report plus the raw run records. |
| `POST /api/tools/{name}/call` | Run it synchronously: `{"args", "timeout_ms"?}` → `{ok, value, error, logs, duration_ms}`. 409 while disabled. |
| `POST /api/tools/{name}/start` | Run it in the background; 202 `{"run": "r3"}`. |
| `POST /api/exec` | Run Python directly (`run_python`): `{"code", "args"?, "deps"?, "timeout_ms"?}` → the run result. |
| `GET /api/runs?agent=&limit=` | Background runs, newest first. |
| `GET /api/runs/{id}?tail=` | One run's summary line, result and output tail (long output is spilled; the tail is kept). |
| `POST /api/runs/{id}/kill` | Kill a live run; its result becomes `killed`. |
| `GET /api/jobs?all=` | Jobs: id, kind, spec, agent, status, turns, result or error. Active ones unless `all`. |
| `POST /api/jobs` | Start a job: `kind` (`task`/`goal`/`periodic`) plus `task`/`goal`/`interval_s`, optional `instructions`, `max_turns`, `agent`. 201, or 409 with the refusal. |
| `GET /api/jobs/{jid}` | One job. |
| `POST /api/jobs/{jid}/stop` | Stop it (`{"reason"?}`); 409 unless stopped. |
| `POST /api/jobs/{jid}/pause`, `POST /api/jobs/{jid}/resume` | Pause / resume a job; 409 on a bad transition. |
| `GET /api/skills` | All skills with description, instructions and tools. |
| `POST /api/skills` | Define one: `name`, `description`, `tools` (must exist), optional `instructions`. 201, or 400 on a bad name or unknown tool. |
| `GET /api/skills/{name}` | One skill. |
| `DELETE /api/skills/{name}` | Delete it; every agent's loaded copy is unloaded. |
| `POST /api/skills/{name}/load?agent=a1` | Load the skill for one agent: its tools join that agent's next tool list. |
| `POST /api/skills/{name}/unload?agent=a1` | Unload it from one agent. |
| `GET /api/memory` | Spilled outputs, newest first: id, agent, tool, path, chars, lines. |
| `GET /api/memory/{oid}?offset=&limit=` | One spilled output as a character window: `chunk`, `total_chars`, `next_offset`. |
| `GET /api/logs?agent=&turn=&run=&level=&grep=&tail=` | Structured log lines, filtered (`logging.md`). |
| `GET /api/events?agent=` | SSE stream of agent events (below). |
| `GET /api/files/list?rel=` | List a workspace folder (`entries`: name, kind, size, mtime; dirs first) or stat one file. |
| `GET /api/files/read?rel=` | Read a text file (256 KB cap): `content`, plus `size`, `truncated`, `binary` (binary files return `content: null`). |
| `PUT /api/files/write` | Create/overwrite a text file: `{"path", "content"}` (4 MB cap); parent folders are created. |
| `POST /api/files/mkdir` | `{"path"}`; 409 if it exists. |
| `POST /api/files/rename` | `{"src", "dst"}` — rename or move within the workspace; 409 if `dst` exists. |
| `DELETE /api/files?rel=&recursive=` | Delete a file, or a folder (`recursive=true` for non-empty ones). The workspace root is refused. |
| `POST /api/files/upload?rel=` | Upload with the raw request body as the file bytes; `rel` is the destination path (parent folders are created, or pass a directory to keep the client filename). |
| `GET /api/files/download?rel=` | Download a file. |

All `/api/files` paths are relative to the workspace root and resolved before
use — anything escaping it (`..`, absolute paths, symlinks out) gets a 400.

Errors are `{"detail": "…"}` with a 4xx status.

## Events

`GET /api/events` streams Server-Sent Events; `?agent=a1` limits the stream to
one agent's events (plus messages to or from it). Event types:

| `event:` | `data` |
|----------|--------|
| `message` | A conversation message was appended: `{type, agent, message}`. |
| `tool_call` / `tool_result` | A tool was called / returned: `{type, agent, name, args|result}`. |
| `answer` | A turn ended with an answer: `{type, agent, text}`. |
| `compacted` | The conversation was compacted: `{type, agent, folded, kept}`. |
| `spawned` / `finished` | An agent was spawned / ended: `{type, agent, …}`. |
| `job_started` / `job_updated` / `job_finished` | A job started, changed status, or ended: `{type, job, kind?, status, detail?}`. |
| `skill_defined` / `skill_deleted` / `skill_loaded` / `skill_unloaded` | A skill changed: `{type, skill, tools?|agent?}`. |

```bash
curl -N "http://127.0.0.1:8000/api/events?agent=seven"
```

## Examples

```bash
# say something to the root agent
curl -X POST localhost:8000/api/agents/seven/messages -H 'content-type: application/json' \
  -d '{"text": "summarize the workspace"}'

# read its conversation
curl "localhost:8000/api/agents/seven/messages?limit=50"

# define and call a tool from the shell
curl -X POST localhost:8000/api/tools -H 'content-type: application/json' -d '{
  "name": "file_list", "description": "list files under a dir",
  "parameters": {"type": "object"},
  "code": "import os\ndef default(args):\n    return sorted(os.listdir(args.get(\"dir\", \".\")))"}'
curl -X POST localhost:8000/api/tools/file_list/call -H 'content-type: application/json' -d '{"args": {"dir": "."}}'
```

## Limits

| Limit | Detail |
|-------|--------|
| No authentication | The API trusts whoever can reach it; bind it to loopback or put it behind your own auth. |
| No pagination cursors | `messages` uses `limit`/`offset`; very long transcripts are fetched in pages. |
| SSE is best-effort | Events are fanned out from one in-memory bus; a client that reconnects gets only new events. |
