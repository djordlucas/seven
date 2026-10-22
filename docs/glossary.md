# Glossary

The terms below have one meaning each across `docs/`, `spec/` and `adr/`.

| Term | Meaning |
|------|---------|
| Agent loop | The cycle of model call → tool calls → results that handles one user message. |
| Turn | One user message and everything the agent loop does until it answers. |
| Step | One model call within a turn. A turn has at most `SEVEN_MAX_STEPS` steps. |
| Tool | Anything the model can call by name: a built-in or a generated tool. |
| Built-in | One of the four tools seven ships with: `run_js`, `define_tool`, `read_tool`, `delete_tool`. |
| Generated tool | A tool the agent wrote with `define_tool`, saved in the tool store. |
| Tool store | `$SEVEN_HOME/tools/`, one directory per generated tool. |
| Revision | A generated tool's version counter; it starts at 1 and increments on each redefinition. |
| Runner | The component that installs a module's packages and runs it in a child process. |
| Run | One execution of one module in a fresh Node.js child process, from spawn to the kill of its process group. |
| Host function | A function in the seven process that a run calls as `seven.<module>.<fn>` over IPC. |
| Workspace | The working directory of every run (`SEVEN_WORKSPACE`). |
| `SEVEN_HOME` | Seven's own state: the tool store and the `node_modules` runs import from. |
