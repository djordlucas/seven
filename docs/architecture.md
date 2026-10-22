# Architecture

Seven is a single Node.js process: a CLI driving one agent loop, a Mistral
client, a tool store on disk, and the runner that runs every piece of code the
model writes in a child process. The model calls a tool synchronously, waiting
for its result, or asynchronously with `start_tool`, getting a run id it can
check, wait on or kill. The agent starts with 12 built-in tools and grows by
writing generated tools, which are saved to the tool store and offered to the
model from the next step onward.

```text
            ┌────────── seven process ───────────┐
 user ────► │ CLI ──► agent loop ◄──► Mistral API │
            │            │   ▲                     │
            │   tool call│   │result               │
            │            ▼   │                     │
            │   built-ins / generated tools        │
            │            │          ▲              │
            │            ▼          │ read/write   │
            │         runner     tool store        │
            │            │      ($SEVEN_HOME)      │
            └────────────┼─────────────────────────┘
                 spawn   │  ▲ IPC: result, seven.llm.chat
                         ▼  │
            ┌── node child process (per run) ──────┐
            │  all of Node · npm packages          │
            └──────────────────────────────────────┘
                         ▼
               files · shell · network
```

## Components

| Component | Responsibility |
|-----------|----------------|
| CLI | Reads configuration from the environment, wires the components, runs one message (`seven "<message>"`) or an interactive session (`seven`), and lists generated tools (`seven tools`). Tool calls and results are echoed to stderr. |
| Agent loop | Sends the conversation and the current tool list to the model, runs every tool call in the reply, appends the results, and repeats until a reply has no tool calls or the step budget runs out. |
| Mistral client | One non-streamed chat completion per step, with function tools. Retries 429 and 5xx responses with backoff, honouring `retry-after`. |
| Tool store | One directory per generated tool under `$SEVEN_HOME/tools/`: its definition and its source, which the runner runs as-is. |
| Runner | Installs the npm packages source imports and runs it in a fresh Node.js child process per run (`runner.md`). |

## A turn

1. The user's message is appended to the conversation.
2. The system prompt is rebuilt, and the tool list is the built-ins plus every
   generated tool in the store, re-read on every step. The prompt also lists
   every background run that is still going or has finished without the model
   looking at it.
3. The model replies. A reply without tool calls is the answer and ends the turn.
4. Each tool call runs in order. A built-in runs in the seven process and may
   use the runner; a generated tool runs its source in a child process with the
   call's arguments.
   An unknown tool or invalid arguments produce an `error: …` result for the
   model, never an exception.
5. Each result is cut to 16,000 characters and appended as a `tool` message.
   The loop returns to step 2.

A turn that reaches `SEVEN_MAX_STEPS` model calls (default 40) ends with
`Stopped after N steps without a final answer.`

## Built-in tools

| Tool | Does |
|------|------|
| `run_js` | Runs code once in a child process; returns the result and the process's output. |
| `define_tool` | Installs a new or revised generated tool's packages and saves it. With `test_args`, runs it first and saves only if that run succeeds. With `timeout_ms`, gives the tool its own run limit. Refuses a name that matches a built-in. |
| `read_tool` | Returns a generated tool's definition and source. |
| `delete_tool` | Deletes a generated tool. |
| `start_tool` | Starts a generated tool or `run_js` as a background run and returns its run id at once. Takes an optional `timeout_ms`. |
| `run_status` | Shows a background run: running or finished, its result once finished, and the last `tail` output lines (default 50). |
| `wait_run` | Waits for a background run to finish, up to `timeout_ms` (default 30 s, at most 300 s), then shows its status. Waiting does not stop the run. |
| `kill_run` | Kills a background run and its process group; the run fails with `killed`. |
| `list_runs` | Lists background runs, one line each. |
| `tool_health` | Shows a generated tool's state, run limit, and its last `last` runs (default 10) with outcome, duration and first error line, plus totals over its recorded history. |
| `disable_tool` | Disables a generated tool with a reason. |
| `enable_tool` | Re-enables a disabled tool unchanged. |

The built-ins are deliberately limited to running code, managing generated
tools, controlling background runs, and handling misbehaving tools. Reading files, searching or editing are capabilities the agent writes
for itself.

## Sync and async calls

A direct tool call is synchronous: the loop waits for the run, up to its time
limit, and the result is the tool message. `start_tool` makes the same call
asynchronous: the run starts, the tool message is `started r<N> (<tool>)`, and
the loop continues while the run's process keeps going.

| Background run state | Shown as |
|----------------------|----------|
| Installing packages or running | `r3 fetch_all: running for 12.4s` |
| Finished, not yet looked at | `r3 fetch_all: finished in 14.0s, ok (not checked yet)` |
| Finished and looked at | `r3 fetch_all: finished in 14.0s, ok` |

A finished run counts as looked at once `run_status`, `wait_run` or `kill_run`
has shown it. Background runs belong to the seven process: they survive across
turns, end when it exits, and are numbered from `r1` in each process. The 50
most recently finished runs are kept.

## Generated tools

A generated tool is an ES module whose default export is
`async (args) => result`, with a name (`^[a-z][a-z0-9_]{0,63}$`), a description
and a JSON Schema for its arguments. Defining a tool under an existing name
replaces it and increments its revision. A tool imports packages from the
shared `$SEVEN_HOME/node_modules`, so upgrading a package changes every tool that
uses it.

| File in `$SEVEN_HOME/tools/<name>/` | Contents |
|-------------------------------------|----------|
| `tool.json` | Name, description, parameter schema, requested dependency ranges, package versions installed when it was saved, created and updated times, revision, optional run limit (`timeoutMs`), and `disabled` (time and reason) while disabled |
| `source.ts` | The source as the model wrote it, which the runner runs |
| `runs.jsonl` | One line per finished run: start time, revision, `sync` or `async`, ok, duration, first error line. Kept across redefinitions; trimmed to the newest 100 when it reaches 200. |

## Misbehaving tools

Every run of a generated tool, synchronous or background, is appended to its
`runs.jsonl`; trial runs from `define_tool` are not. `tool_health` reads it.

A disabled tool stays in the tool store but is left out of the tool list sent
to the model, and the system prompt names it with its reason. A direct call or
`start_tool` to it returns
`error: tool "<name>" is disabled (<reason>). Fix it with define_tool, or enable_tool to use it as is.`
Redefining the tool clears `disabled`, because the new revision is the fix.

A tool's `timeoutMs` replaces the default run limit (`SEVEN_RUN_TIMEOUT_MS`)
for every run of that tool; `start_tool`'s own `timeout_ms` overrides both.

## Configuration

All configuration comes from environment variables; `npm start` and
`compose.yaml` read `.env` when it exists.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SEVEN_LLM_API_KEY` | `MISTRAL_API_KEY` | Mistral API key. Required to run the agent. |
| `SEVEN_LLM_MODEL` | `mistral-medium-latest` | Any Mistral chat model with function calling. |
| `SEVEN_LLM_ENDPOINT` | `https://api.mistral.ai/v1` | API base URL. |
| `SEVEN_HOME` | `<workspace>/.seven` (`/data` in the image) | Generated tools and the `node_modules` they import from. |
| `SEVEN_WORKSPACE` | current directory (`/workspace` in the image) | The working directory of every run. |
| `SEVEN_MAX_STEPS` | `40` | Model calls one user message may take. |
| `SEVEN_RUN_TIMEOUT_MS` | `60000` | Wall-clock budget of one run. |
| `SEVEN_RUN_MEMORY_MB` | `1024` | V8 heap cap of one run, in MiB. |

## Limits

| Limit | Detail |
|-------|--------|
| No session persistence | The conversation lives in memory and ends with the process; only generated tools persist. |
| No context management | The whole conversation is sent on every step; a long session eventually exceeds the model's context window and the API call fails. |
| No streaming | Each model reply arrives whole. |
| Sequential tool calls | Tool calls in one reply run one after another; `start_tool` is how work overlaps. |
| Background runs are not persisted | They live in the seven process's memory; a restart loses their ids, results and output. |
| No automatic disabling | Seven does not disable a tool on its own, however often it fails; the model decides from `tool_health`. |
| No push notification | The model learns that a background run finished from the system prompt at its next step, or by asking; nothing interrupts a step in progress. |
| No self-modification of seven's own source | The agent extends itself through generated tools only; it does not edit `src/`. |
