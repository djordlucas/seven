# Architecture

Seven is a single Node.js process: a CLI driving one agent loop, a Mistral
client, a tool store on disk, and the VM that runs every piece of code the model
writes. The agent starts with four built-in tools and grows by writing
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
            │           VM      tool store         │
            │   (QuickJS in wasm) ($SEVEN_HOME)    │
            │            │                         │
            │      seven:* host modules            │
            └────────────┼─────────────────────────┘
                         ▼
          files · shell · network · WASI · the model
```

## Components

| Component | Responsibility |
|-----------|----------------|
| CLI | Reads configuration from the environment, wires the components, runs one message (`seven "<message>"`) or an interactive session (`seven`), and lists generated tools (`seven tools`). Tool calls and results are echoed to stderr. |
| Agent loop | Sends the conversation and the current tool list to the model, runs every tool call in the reply, appends the results, and repeats until a reply has no tool calls or the step budget runs out. |
| Mistral client | One non-streamed chat completion per step, with function tools. Retries 429 and 5xx responses with backoff, honouring `retry-after`. |
| Tool store | One directory per generated tool under `$SEVEN_HOME/tools/`: its definition, the source as written, and the bundle the VM runs. |
| VM | Bundles source and runs it in a fresh QuickJS runtime per run (`vm.md`). |

## A turn

1. The user's message is appended to the conversation.
2. The system prompt is rebuilt, and the tool list is the built-ins plus every
   generated tool in the store, re-read on every step.
3. The model replies. A reply without tool calls is the answer and ends the turn.
4. Each tool call runs in order. A built-in runs as host code that may use the
   VM; a generated tool runs its bundle in the VM with the call's arguments.
   An unknown tool or invalid arguments produce an `error: …` result for the
   model, never an exception.
5. Each result is cut to 16,000 characters and appended as a `tool` message.
   The loop returns to step 2.

A turn that reaches `SEVEN_MAX_STEPS` model calls (default 40) ends with
`Stopped after N steps without a final answer.`

## Built-in tools

| Tool | Does |
|------|------|
| `run_js` | Bundles and runs code once in the VM; returns the result and console output. |
| `define_tool` | Bundles a new or revised generated tool and saves it. With `test_args`, runs it first and saves only if that run succeeds. Refuses a name that matches a built-in. |
| `read_tool` | Returns a generated tool's definition and source. |
| `delete_tool` | Deletes a generated tool. |

The built-ins are deliberately limited to running code and managing generated
tools. Reading files, searching or editing are capabilities the agent writes
for itself.

## Generated tools

A generated tool is an ES module whose default export is
`async (args) => result`, with a name (`^[a-z][a-z0-9_]{0,63}$`), a description
and a JSON Schema for its arguments. Defining a tool under an existing name
replaces it and increments its revision. The bundle is fixed when the tool is
saved: later changes to the dependency cache do not change it.

| File in `$SEVEN_HOME/tools/<name>/` | Contents |
|-------------------------------------|----------|
| `tool.json` | Name, description, parameter schema, requested dependency ranges, installed package versions, created and updated times, revision |
| `source.ts` | The source as the model wrote it |
| `bundle.js` | The self-contained module the VM runs |

## Configuration

All configuration comes from environment variables; `npm start` and
`compose.yaml` read `.env` when it exists.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SEVEN_LLM_API_KEY` | `MISTRAL_API_KEY` | Mistral API key. Required to run the agent. |
| `SEVEN_LLM_MODEL` | `mistral-medium-latest` | Any Mistral chat model with function calling. |
| `SEVEN_LLM_ENDPOINT` | `https://api.mistral.ai/v1` | API base URL. |
| `SEVEN_HOME` | `<workspace>/.seven` (`/data` in the image) | Generated tools and the dependency cache. |
| `SEVEN_WORKSPACE` | current directory (`/workspace` in the image) | Where the VM's relative paths resolve. |
| `SEVEN_MAX_STEPS` | `40` | Model calls one user message may take. |
| `SEVEN_RUN_TIMEOUT_MS` | `60000` | Wall-clock budget of one VM run. |

## Limits

| Limit | Detail |
|-------|--------|
| No session persistence | The conversation lives in memory and ends with the process; only generated tools persist. |
| No context management | The whole conversation is sent on every step; a long session eventually exceeds the model's context window and the API call fails. |
| No streaming | Each model reply arrives whole. |
| Sequential tool calls | Tool calls in one reply run one after another. |
| No self-modification of seven's own source | The agent extends itself through generated tools only; it does not edit `src/`. |
