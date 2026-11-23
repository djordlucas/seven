# The UI

`seven serve` serves a companion single-page UI at `/` — vanilla HTML/CSS/JS
in `seven/api/ui/`, no build step. It is feature-complete: every endpoint in
[api.md](api.md) has a surface here.

| View | Covers |
|------|--------|
| Agents | The agent list (live, the supervisor peer included), a chat pane per agent with the full transcript, tool calls and results, Inbox and Outbox tabs per agent, sending a message with Enter (Shift+Enter for a newline — no send button), a 📎 button that uploads file(s) to `uploads/` in the workspace and sends the agent a message with their paths, spawning an agent (all modes), stopping, compacting, resetting the conversation. Live updates arrive over `/api/events`. |
| Tools | Two sub-tabs. **Tools**: the generated tool list, one tool's definition, source, health and pinned libraries (`name@rN` chips with a rebundle button), calling a tool with JSON args, starting a background run, disabling/enabling/deleting (refused with the using skills while one does), defining a new tool (with optional bundled `libs`), and a Run Python box for `/api/exec`. **Libraries**: the generated library list (revision, dependent count), one library's source and which tools bundle it at which revision, define/delete, and a revalidate-dependents button. |
| Files | The workspace file manager: breadcrumb navigation, folder up, new file/folder, upload (multi-file), refresh; clicking a folder navigates, clicking a file opens an editor panel with save (Ctrl+S), download, rename/move and delete (per-row ✕ as well). Text files are editable (256 KB read cap), images preview inline, other binaries download-only. Dotfiles (`.seven`) are hidden. |
| Activity | Runs and logs in one place, as sub-tabs: background runs (live) with one run's status, result and output and killing a live run; the structured log with agent/level/grep/tail filters and a follow mode. |
| Jobs | Jobs (live): kind, spec, agent, status, turns, result or error; start (task/goal/periodic, on an agent), stop, pause, resume. |
| Skills | Skills: list, define, edit, delete, read, and load/unload per agent. |
| Memory | Spilled outputs (live) with size and tool, and one output read in character chunks. |
| Config | `/api/config` and `/api/health` as a table (the API key is never sent). |

The top bar keeps the logo leftmost next to the nav (Agents, Memory, Skills,
Tools, Files, Activity, Jobs, System) and centers only the name label with the instance
name (the workspace directory's basename) as a chip; the right side holds the
theme switcher (dark/light, remembered in `localStorage`), the live-stream dot
and the health readout. The agent roster is grouped into sections per root
agent (sticky headers with a spawned count, children indented by depth) and
grows with its items up to the viewport height; the chat panel always matches
the roster's height exactly. Agent descriptions appear in a floating box after
hovering a roster row for about a second (inline under the name on touch
devices). |

Message bodies (conversation, inbox, outbox) are rendered as markdown by
`seven/api/ui/markdown.js` — a small dependency-free renderer that escapes all
HTML first, so LLM output can never inject markup. It covers headings, fenced
code blocks, blockquotes, GFM tables, lists, links and images (non-http(s)
URLs are dropped), plus inline code/bold/italic/strikethrough. Tool results
stay raw monospace in a `<pre>`. |

## Limits

| Limit | Detail |
|-------|--------|
| No build step | The UI is hand-written JS served as static files; there is no bundler or framework to update. |
| Polling + SSE | Agent and run lists poll every few seconds; the open conversation streams over SSE. |
| Single workspace | The UI shows the workspace of the one server it is served by. |
| Responsive | Below 1100px the agents view stacks; on phones (≤760px) the top bar wraps to two rows (brand + controls, then a scrollable nav), wide tables drop their secondary columns, the send button goes full-width, and modals/forms go single-column. On touch devices the hover tooltip is replaced by an inline description under the agent name. |
