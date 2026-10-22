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
| VM | The component that bundles and runs code: QuickJS compiled to wasm. |
| Run | One execution of one module in a fresh QuickJS runtime, from evaluation to teardown. |
| Bundle | The single self-contained ES module produced from source; its only imports are `seven:*`. |
| Host module | A `seven:*` module whose functions are implemented by the seven process. |
| Host function | One function of a host module. |
| Prelude | The script that builds the guest's globals before the module is evaluated. |
| Dependency cache | `$SEVEN_HOME/deps`, the `node_modules` shared by every bundle. |
| Workspace | The directory relative paths resolve against (`SEVEN_WORKSPACE`). |
| `SEVEN_HOME` | Seven's own state: the tool store and the dependency cache. |
