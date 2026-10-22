# Architecture

Seven is a single Node.js process: a CLI driving one agent loop, a Mistral
client, a tool store on disk, and the runner that runs every piece of code the
model writes in a child process. The agent starts with four built-in tools and grows by writing
generated tools, which are saved to the tool store and offered to the model
from the next step onward.

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
   generated tool in the store, re-read on every step.
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
| `define_tool` | Installs a new or revised generated tool's packages and saves it. With `test_args`, runs it first and saves only if that run succeeds. Refuses a name that matches a built-in. |
| `read_tool` | Returns a generated tool's definition and source. |
| `delete_tool` | Deletes a generated tool. |

The built-ins are deliberately limited to running code and managing generated
tools. Reading files, searching or editing are capabilities the agent writes
for itself.

## Generated tools

A generated tool is an ES module whose default export is
`async (args) => result`, with a name (`^[a-z][a-z0-9_]{0,63}$`), a description
and a JSON Schema for its arguments. Defining a tool under an existing name
replaces it and increments its revision. A tool imports packages from the
shared `$SEVEN_HOME/node_modules`, so upgrading a package changes every tool that
uses it.

| File in `$SEVEN_HOME/tools/<name>/` | Contents |
|-------------------------------------|----------|
| `tool.json` | Name, description, parameter schema, requested dependency ranges, package versions installed when it was saved, created and updated times, revision |
| `source.ts` | The source as the model wrote it, which the runner runs |

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
| Sequential tool calls | Tool calls in one reply run one after another. |
| No self-modification of seven's own source | The agent extends itself through generated tools only; it does not edit `src/`. |
