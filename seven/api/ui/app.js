/* seven UI — single-page vanilla JS, no build step.
 * Views: agents (live chat), tools, runs, jobs, skills, memory, logs, system.
 * Data: REST under /api plus one global SSE stream from /api/events. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  view: "agents",
  subtab: "runs",
  agents: [],
  selectedAgent: null,
  mailTab: "chat",
  tools: [],
  selectedTool: null,
  jobs: [],
  skills: [],
  memory: [],
  logsFollow: false,
  logsTimer: null,
  es: null,
  esLive: false,
};

/* ── small helpers ─────────────────────────────────────────── */

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch { /* keep status text */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, ok = false) {
  const box = $("#toasts");
  const t = document.createElement("div");
  t.className = "toast" + (ok ? " ok" : "");
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

const badge = (status) => `<span class="badge ${esc(status)}">${esc(status)}</span>`;

const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
};

const fmtDur = (ms) => (ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

const pretty = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

let debounceTimers = new Map();
function debounce(key, fn, ms = 350) {
  clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(fn, ms));
}

/* ── modal ─────────────────────────────────────────────────── */

let modalGen = 0;

function openModal(title, bodyHTML, actions) {
  const gen = ++modalGen;
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHTML;
  const box = $("#modal-actions");
  box.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = "btn" + (a.primary ? " primary" : "") + (a.danger ? " danger" : "");
    b.textContent = a.label;
    b.onclick = async () => {
      try {
        const keepOpen = await a.onClick();
        // An action may open a follow-up modal (e.g. a result); only close when
        // this modal is still the current one.
        if (keepOpen !== false && gen === modalGen) closeModal();
      } catch (e) {
        toast(String(e));
      }
    };
    box.appendChild(b);
  }
  $("#modal-backdrop").classList.remove("hidden");
  const first = $("#modal-body input, #modal-body textarea, #modal-body select");
  first?.focus();
}

function closeModal() {
  $("#modal-backdrop").classList.add("hidden");
}

$("#modal-close").onclick = closeModal;
$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-backdrop") closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal-backdrop").classList.contains("hidden")) closeModal();
});

function confirmModal(title, text, onYes) {
  openModal(title, `<p style="margin:6px 0;color:var(--dim)">${esc(text)}</p>`, [
    { label: "Cancel", onClick: () => {} },
    { label: "Confirm", danger: true, primary: true, onClick: onYes },
  ]);
}

/* ── navigation ────────────────────────────────────────────── */

const loaders = {
  agents: null, // loaded explicitly
  tools: () => loadTools(),
  activity: () => { loadRuns(); if (state.subtab === "logs") loadLogs(); },
  jobs: () => loadJobs(),
  skills: () => loadSkills(),
  memory: () => loadMemory(),
  config: () => loadConfig(),
};

$$(".nav-btn").forEach((b) => (b.onclick = () => {
  state.view = b.dataset.view;
  $$(".nav-btn").forEach((x) => x.classList.toggle("active", x === b));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + state.view));
  if (state.view === "agents") loadAgents();
  else loaders[state.view]?.();
}));

$$(".subtabs .tab").forEach((b) => (b.onclick = () => {
  $$(".subtabs .tab").forEach((x) => x.classList.toggle("active", x === b));
  state.subtab = b.dataset.subtab;
  $("#subtab-runs").classList.toggle("hidden", state.subtab !== "runs");
  $("#subtab-logs").classList.toggle("hidden", state.subtab !== "logs");
  if (state.subtab === "runs") loadRuns();
  else loadLogs();
}));

/* ── theme ─────────────────────────────────────────────────── */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#theme-toggle").textContent = theme === "dark" ? "☀️" : "🌙";
  $("#theme-toggle").title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  try { localStorage.setItem("seven-theme", theme); } catch { /* private mode */ }
}
$("#theme-toggle").onclick = () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
};
(function initTheme() {
  let theme;
  try { theme = localStorage.getItem("seven-theme"); } catch { /* ignore */ }
  if (!theme) theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(theme);
})();

/* ── health + live events ──────────────────────────────────── */

async function refreshHealth() {
  try {
    const h = await api("GET", "/api/health");
    $("#health").textContent = `v${h.version} · ${h.active_agents} agents · up ${Math.round(h.uptime_s)}s`;
    const name = String(h.workspace || "").replace(/\/+$/, "").split("/").pop() || "instance";
    $("#instance-name").textContent = name;
  } catch {
    $("#health").textContent = "api unreachable";
  }
}

function setSse(live) {
  state.esLive = live;
  $("#sse-dot").className = "sse-dot " + (live ? "live" : "down");
  $("#sse-dot").title = live ? "live event stream connected" : "live event stream down — retrying";
}

function openEvents() {
  if (state.es) state.es.close();
  const es = new EventSource("/api/events");
  state.es = es;
  es.onopen = () => setSse(true);
  es.onerror = () => setSse(false);

  // A chat message appended live for the agent whose conversation is open.
  es.addEventListener("message", (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.agent && ev.agent === state.selectedAgent && ev.message && state.mailTab === "chat") {
        appendMessage(ev.message);
      }
    } catch { /* ignore malformed */ }
    debounce("agents", loadAgents, 500);
  });

  // Anything else that may change the open view or the lists.
  for (const type of ["answer", "tool_call", "tool_result", "compacted", "finished", "spawned",
                      "job_started", "job_updated", "job_finished",
                      "skill_defined", "skill_deleted", "skill_loaded", "skill_unloaded"]) {
    es.addEventListener(type, (e) => {
      let ev = {};
      try { ev = JSON.parse(e.data); } catch { /* ignore */ }
      if (state.view === "agents") debounce("agents", loadAgents, 400);
      if (state.view === "agents" && state.selectedAgent && ev.agent === state.selectedAgent) {
        debounce("messages", loadMessages, 450);
      }
      if (state.view === "jobs") debounce("jobs", loadJobs, 400);
      if (state.view === "skills") debounce("skills", loadSkills, 400);
      if (state.view === "activity") debounce("runs", loadRuns, 400);
    });
  }
}

/* ── agents ────────────────────────────────────────────────── */

async function loadAgents() {
  try {
    state.agents = await api("GET", "/api/agents?all=false");
    renderAgents();
    if (state.selectedAgent) {
      const a = state.agents.find((x) => x.id === state.selectedAgent);
      if (a) renderChatHeader(a);
    }
  } catch (e) { toast(String(e)); }
}

function renderAgents() {
  const t = $("#agents-table");
  if (!state.agents.length) {
    t.innerHTML = `<tr><td class="kv">no active agents</td></tr>`;
    return;
  }
  t.innerHTML =
    `<tr><th>agent</th><th>mode</th><th>status</th><th>inbox</th></tr>` +
    state.agents.map((a) => `<tr class="clickable ${a.id === state.selectedAgent ? "selected" : ""}" data-id="${esc(a.id)}">
      <td><span class="mono">${esc(a.id)}</span> <span class="kv">“${esc(a.name)}”</span>${a.busy ? ' <span class="badge running">busy</span>' : ""}</td>
      <td>${esc(a.mode)}</td>
      <td>${badge(a.status)}</td>
      <td class="mono">${a.inbox_pending}</td>
    </tr>`).join("");
  $$("#agents-table tr.clickable").forEach((tr) => (tr.onclick = () => selectAgent(tr.dataset.id)));
}

/* Floating detail box for a roster row, shown after a short hover delay.
   Delegated on the table so the 3s re-render never cancels a hover. */
let tooltipTimer = null;
let tooltipAgent = null;
let hoverRowId = null;
$("#agents-table").addEventListener("mouseover", (e) => {
  const tr = e.target.closest("tr.clickable");
  const id = tr?.dataset.id ?? null;
  if (id === hoverRowId) return; // same row, even after a re-render
  hoverRowId = id;
  if (!tr) { disarmTooltip(); return; }
  const a = state.agents.find((x) => x.id === id);
  if (a) armTooltip(a, e);
});
$("#agents-table").addEventListener("mouseleave", () => { hoverRowId = null; disarmTooltip(); });
$("#agents-table").addEventListener("mousemove", moveTooltip);

function armTooltip(a, e) {
  disarmTooltip();
  tooltipAgent = a;
  tooltipTimer = setTimeout(() => {
    if (tooltipAgent !== a) return;
    showTooltip(a, e.clientX, e.clientY);
  }, 900);
}
function disarmTooltip() {
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
  tooltipAgent = null;
  $("#tooltip").classList.add("hidden");
}
function moveTooltip(e) {
  if (!$("#tooltip").classList.contains("hidden") && tooltipAgent) showTooltip(tooltipAgent, e.clientX, e.clientY);
}
function showTooltip(a, x, y) {
  const t = $("#tooltip");
  t.innerHTML = `
    <div class="tt-title">${esc(a.id)} “${esc(a.name)}”</div>
    <div class="tt-row">mode ${esc(a.mode)} · status ${esc(a.status)}${a.busy ? " · busy" : ""} · inbox ${a.inbox_pending} (${a.inbox_tasks} tasks, ${a.inbox_messages} messages)</div>
    ${a.parent ? `<div class="tt-row">spawned by ${esc(a.parent)}</div>` : ""}
    <div class="tt-row">created ${esc(fmtTime(a.created_at))}</div>
    <div class="tt-desc">${esc(a.description || "no description")}</div>`;
  t.classList.remove("hidden");
  const r = t.getBoundingClientRect();
  const px = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
  const py = Math.min(Math.max(8, y + 16), window.innerHeight - r.height - 8);
  t.style.left = `${px}px`;
  t.style.top = `${py}px`;
}

async function selectAgent(id) {
  state.selectedAgent = id;
  renderAgents();
  try {
    const a = await api("GET", `/api/agents/${id}`);
    renderChatHeader(a);
    await loadMessages();
    $("#send-form").classList.remove("hidden");
    if (state.mailTab !== "chat") loadMail(state.mailTab);
  } catch (e) { toast(String(e)); }
}

function renderChatHeader(a) {
  const title = $("#chat-title");
  title.textContent = `${a.id} “${a.name}”`;
  const mode = document.createElement("span");
  mode.className = "kv";
  mode.textContent = ` · ${a.mode} `;
  title.appendChild(mode);
  title.insertAdjacentHTML("beforeend", badge(a.status));

  $("#chat-status").textContent =
    `created ${fmtTime(a.created_at)} · last turn ${a.last_turn_at ? fmtTime(a.last_turn_at) : "never"} · ` +
    `inbox ${a.inbox_tasks} tasks / ${a.inbox_messages} messages` +
    (a.result ? ` · result: ${a.result.slice(0, 160)}` : "") +
    (a.error ? ` · error: ${a.error}` : "");

  const actions = $("#chat-actions");
  actions.innerHTML = "";
  if (a.id !== "seven") {
    const stop = document.createElement("button");
    stop.className = "btn small danger";
    stop.textContent = "Stop";
    stop.onclick = () => stopAgentModal(a.id);
    actions.appendChild(stop);
  }
  const compact = document.createElement("button");
  compact.className = "btn small";
  compact.textContent = "Compact";
  compact.onclick = async () => {
    try {
      const r = await api("POST", `/api/agents/${a.id}/compact`);
      toast(`compacted: folded ${r.folded}, kept ${r.kept}`, true);
      loadMessages();
    } catch (e) { toast(String(e)); }
  };
  actions.appendChild(compact);
  const reset = document.createElement("button");
  reset.className = "btn small danger";
  reset.textContent = "Reset conversation";
  reset.onclick = () => confirmModal("Reset conversation", `Clear the whole conversation and summary of agent “${a.id}”?`, async () => {
    await api("DELETE", `/api/agents/${a.id}/conversation`);
    toast("conversation cleared", true);
    await loadMessages();
  });
  actions.appendChild(reset);
}

function stopAgentModal(id) {
  openModal(`Stop agent ${id}`, `
    <div class="form-grid"><div class="full">
      <label>Reason (optional, recorded in the log)</label>
      <input id="stop-reason" placeholder="stopped from the UI">
    </div></div>`, [
    { label: "Cancel", onClick: () => {} },
    { label: "Stop", danger: true, primary: true, onClick: async () => {
      const reason = $("#stop-reason").value.trim() || null;
      await api("POST", `/api/agents/${id}/stop`, { reason });
      toast(`stopped ${id}`, true);
      loadAgents();
    } },
  ]);
}

$$(".chat-tabs .tab").forEach((b) => (b.onclick = () => {
  $$(".chat-tabs .tab").forEach((x) => x.classList.toggle("active", x === b));
  state.mailTab = b.dataset.tab;
  const chat = state.mailTab === "chat";
  $("#messages").classList.toggle("hidden", !chat);
  $("#send-form").classList.toggle("hidden", !chat || !state.selectedAgent);
  $("#mail-pane").classList.toggle("hidden", chat);
  if (!chat && state.selectedAgent) loadMail(state.mailTab);
}));

async function loadMail(folder) {
  const pane = $("#mail-pane");
  try {
    const rows = await api("GET", `/api/agents/${state.selectedAgent}/${folder}`);
    pane.innerHTML = rows.length
      ? rows.map((r) => {
          const head = folder === "inbox"
            ? `#${r.id} · ${esc(r.kind)} · from ${esc(r.sender)} · ${r.delivered_at ? "delivered" : "PENDING"}`
            : `#${r.id} · ${esc(r.kind)} · to ${esc(r.recipient)} · ${r.delivered_at ? "delivered" : "undelivered"}`;
          return `<div class="mrow ${r.delivered_at ? "" : "pending"}"><div class="mhead">${head}</div>${esc(r.text ?? "")}</div>`;
        }).join("")
      : `<div class="mrow"><div class="mhead">empty</div></div>`;
  } catch (e) {
    pane.innerHTML = `<div class="mrow">${esc(String(e))}</div>`;
  }
}

async function loadMessages() {
  if (!state.selectedAgent) return;
  try {
    const r = await api("GET", `/api/agents/${state.selectedAgent}/messages?limit=500`);
    renderMessages(r.messages);
  } catch (e) { toast(String(e)); }
}

function renderMessages(messages) {
  const box = $("#messages");
  box.innerHTML = "";
  if (!messages.length) {
    box.innerHTML = `<div class="msg system">No messages yet — send one below.</div>`;
  }
  for (const m of messages) appendMessage(m.message);
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m) {
  const box = $("#messages");
  const div = document.createElement("div");
  div.className = "msg " + (m.role || "user");
  let html = `<div class="role">${esc(m.role)}${m.name ? " · " + esc(m.name) : ""}</div>`;
  if (m.role === "assistant" && m.tool_calls) {
    html += esc(m.content ?? "") ? `<div>${esc(m.content)}</div>` : "";
    for (const c of m.tool_calls) {
      let args = c.function?.arguments ?? "";
      try { args = JSON.stringify(JSON.parse(args), null, 2); } catch { /* keep raw */ }
      html += `<div class="toolcall"><details><summary>⚙ ${esc(c.function?.name)}(${esc(c.function?.arguments ?? "")})</summary><pre>${esc(args)}</pre></details></div>`;
    }
  } else if (m.role === "tool") {
    html += `<details><summary>↳ result${m.name ? " · " + esc(m.name) : ""}</summary><pre>${esc(m.content ?? "")}</pre></details>`;
  } else {
    html += esc(m.content ?? "");
  }
  div.innerHTML = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

$("#send-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#send-input").value.trim();
  if (!text || !state.selectedAgent) return;
  $("#send-input").value = "";
  try {
    await api("POST", `/api/agents/${state.selectedAgent}/messages`, { text });
    loadAgents();
  } catch (err) { toast(String(err)); }
};
$("#send-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#send-form").requestSubmit();
  }
});

$("#btn-spawn").onclick = () => {
  openModal("New agent", `
    <div class="form-grid">
      <div><label>Name (unique among active agents)</label><input id="f-name" placeholder="researcher"></div>
      <div><label>Mode</label><select id="f-mode"><option>request</option><option>sequence</option><option>continuous</option></select></div>
      <div class="full"><label>Description</label><input id="f-description"></div>
      <div class="full"><label>Instructions</label><textarea id="f-instructions" rows="3"></textarea></div>
      <div class="full"><label>Tasks (one per line; request takes exactly one)</label><textarea id="f-tasks" rows="3"></textarea></div>
      <div><label>interval_s (continuous only)</label><input id="f-interval" type="number" min="1"></div>
      <div><label>max_steps (blank = default)</label><input id="f-maxsteps" type="number" min="1"></div>
    </div>`, [
    { label: "Cancel", onClick: () => {} },
    { label: "Spawn", primary: true, onClick: async () => {
      const name = $("#f-name").value.trim();
      if (!name) { toast("name is required"); return false; }
      const body = {
        name,
        description: $("#f-description").value,
        instructions: $("#f-instructions").value,
        mode: $("#f-mode").value,
        tasks: $("#f-tasks").value.split("\n").map((s) => s.trim()).filter(Boolean),
        interval_s: $("#f-interval").value ? Number($("#f-interval").value) : null,
        max_steps: $("#f-maxsteps").value ? Number($("#f-maxsteps").value) : null,
      };
      const a = await api("POST", "/api/agents", body);
      toast(`spawned ${a.id}`, true);
      loadAgents();
      selectAgent(a.id);
    } },
  ]);
};

/* ── tools ─────────────────────────────────────────────────── */

async function loadTools() {
  try {
    state.tools = await api("GET", "/api/tools");
    renderTools();
  } catch (e) { toast(String(e)); }
}

function renderTools() {
  const t = $("#tools-table");
  if (!state.tools.length) {
    t.innerHTML = `<tr><td class="kv">No tools yet — agents define them as they work, or define one above.</td></tr>`;
    return;
  }
  t.innerHTML =
    `<tr><th style="width:22%">name</th><th style="width:7%">rev</th><th style="width:10%">state</th><th style="width:10%">run limit</th><th>description</th><th style="width:15%">updated</th></tr>` +
    state.tools.map((x) => `<tr class="clickable ${state.selectedTool === x.name ? "selected" : ""}" data-name="${esc(x.name)}">
      <td class="mono">${esc(x.name)}</td>
      <td class="mono">r${x.revision}</td>
      <td>${x.disabled ? `<span class="badge disabled">disabled</span>` : `<span class="badge enabled">enabled</span>`}</td>
      <td class="mono">${x.timeout_ms ? fmtDur(x.timeout_ms) : "default"}</td>
      <td title="${esc(x.description)}">${esc(x.description)}</td>
      <td class="mono">${esc(x.updated_at)}</td>
    </tr>`).join("");
  $$("#tools-table tr.clickable").forEach((tr) => (tr.onclick = () => selectTool(tr.dataset.name)));
}

async function selectTool(name) {
  state.selectedTool = name;
  renderTools();
  try {
    const t = await api("GET", `/api/tools/${name}`);
    const h = await api("GET", `/api/tools/${name}/health?last=20`);
    const d = $("#tool-detail");
    d.classList.remove("hidden");
    const meta = t.meta;
    d.innerHTML = `
      <div class="panel-head">
        <h3 class="mono">${esc(meta.name)} <span class="kv">r${meta.revision}</span></h3>
        ${meta.disabled ? badge("disabled") : badge("enabled")}
        <div class="actions">
          <button class="btn small primary" id="td-call">Call…</button>
          <button class="btn small" id="td-start">Run in background</button>
          ${meta.disabled
            ? `<button class="btn small" id="td-enable">Enable</button>`
            : `<button class="btn small" id="td-disable">Disable…</button>`}
          <button class="btn small danger" id="td-delete">Delete</button>
        </div>
      </div>
      <div class="kv">${esc(meta.description)}</div>
      ${meta.disabled ? `<div class="kv">disabled: ${esc(meta.disabled.reason)} (${esc(meta.disabled.at)})</div>` : ""}
      ${t.used_by_skills?.length ? `<div class="kv">used by skills: ${esc(t.used_by_skills.join(", "))}</div>` : ""}
      <label>parameters (JSON Schema)</label><pre>${esc(pretty(meta.parameters))}</pre>
      <label>source</label><pre>${esc(t.source)}</pre>
      <label>health</label><pre>${esc(h.report)}</pre>`;
    $("#td-call").onclick = () => toolCallModal(name, "call");
    $("#td-start").onclick = () => toolCallModal(name, "start");
    $("#td-disable")?.addEventListener("click", () => {
      openModal(`Disable ${name}`, `
        <label>Reason (recorded in the log)</label><input id="dis-reason" placeholder="flaky / unsafe / …">`, [
        { label: "Cancel", onClick: () => {} },
        { label: "Disable", danger: true, primary: true, onClick: async () => {
          const reason = $("#dis-reason").value.trim();
          if (!reason) { toast("a reason is required"); return false; }
          await api("POST", `/api/tools/${name}/disable`, { reason });
          toast(`disabled ${name}`, true);
          selectTool(name);
          loadTools();
        } },
      ]);
    });
    $("#td-enable")?.addEventListener("click", async () => {
      try {
        await api("POST", `/api/tools/${name}/enable`);
        toast(`enabled ${name}`, true);
        selectTool(name);
        loadTools();
      } catch (e) { toast(String(e)); }
    });
    $("#td-delete").onclick = () => confirmModal("Delete tool", `Delete ${name} and its run history? Skills using it block deletion.`, async () => {
      await api("DELETE", `/api/tools/${name}`);
      toast(`deleted ${name}`, true);
      state.selectedTool = null;
      $("#tool-detail").classList.add("hidden");
      loadTools();
    });
  } catch (e) { toast(String(e)); }
}

function toolCallModal(name, mode) {
  openModal(`${mode === "call" ? "Call" : "Run in background"} ${name}`, `
    <div class="form-grid">
      <div class="full"><label>args (JSON object)</label><textarea id="c-args" rows="5">{}</textarea></div>
      <div><label>timeout_ms (blank = default)</label><input id="c-timeout" type="number" min="1"></div>
    </div>`, [
    { label: "Cancel", onClick: () => {} },
    { label: mode === "call" ? "Call" : "Start", primary: true, onClick: async () => {
      let args;
      try { args = JSON.parse($("#c-args").value || "{}"); } catch { toast("args is not valid JSON"); return false; }
      const timeout_ms = $("#c-timeout").value ? Number($("#c-timeout").value) : null;
      if (mode === "call") {
        const r = await api("POST", `/api/tools/${name}/call`, { args, timeout_ms });
        resultModal(`Result of ${name}`, r);
      } else {
        const r = await api("POST", `/api/tools/${name}/start`, { args, timeout_ms });
        toast(`started run ${r.run}`, true);
        if (state.view !== "activity") $(".nav-btn[data-view='activity']").click();
        else loadRuns();
      }
    } },
  ]);
}

function resultModal(title, r) {
  openModal(title, `<pre>${esc(
    (r.ok ? pretty(r.value) : "error: " + (r.error ?? "")) +
    (r.logs?.length ? "\n--- output ---\n" + r.logs.join("\n") : "") +
    `\n(${fmtDur(r.duration_ms)})`
  )}</pre>`, [{ label: "Close", primary: true, onClick: () => {} }]);
}

$("#btn-define").onclick = () => {
  openModal("Define tool", `
    <div class="form-grid">
      <div><label>Name (snake_case)</label><input id="d-name" placeholder="read_files"></div>
      <div><label>timeout_ms (optional)</label><input id="d-timeout" type="number" min="1"></div>
      <div class="full"><label>Description (what callers see)</label><input id="d-description"></div>
      <div class="full"><label>parameters (JSON Schema)</label><textarea id="d-params" rows="3">{"type":"object"}</textarea></div>
      <div class="full"><label>code (module source; <code>default(args)</code> returns the result)</label><textarea id="d-code" rows="9">def default(args):\n    return ...</textarea></div>
      <div><label>deps (JSON of pip packages, optional)</label><input id="d-deps" placeholder='{"requests": ">=2"}'></div>
      <div><label>test_args (JSON, optional trial run)</label><input id="d-testargs" placeholder="{}"></div>
    </div>`, [
    { label: "Cancel", onClick: () => {} },
    { label: "Save", primary: true, onClick: async () => {
      const parseJSON = (id, fallback) => {
        const v = $(id).value.trim();
        if (!v) return fallback;
        try { return JSON.parse(v); } catch { toast(`${id} is not valid JSON`); return undefined; }
      };
      const parameters = parseJSON("#d-params", { type: "object" });
      const deps = parseJSON("#d-deps", null);
      const test_args = parseJSON("#d-testargs", null);
      if (parameters === undefined || deps === undefined || test_args === undefined) return false;
      const name = $("#d-name").value.trim();
      if (!name) { toast("name is required"); return false; }
      const m = await api("POST", "/api/tools", {
        name,
        description: $("#d-description").value,
        parameters,
        code: $("#d-code").value,
        deps,
        test_args,
        timeout_ms: $("#d-timeout").value ? Number($("#d-timeout").value) : null,
      });
      toast(`saved ${m.name} r${m.revision}`, true);
      loadTools();
    } },
  ]);
};

$("#btn-exec").onclick = () => {
  openModal("Run Python", `
    <div class="form-grid">
      <div class="full"><label>code (module source; <code>default(args)</code> returns the result)</label>
        <textarea id="e-code" rows="9">print("hello")\ndef default(args):\n    return {"ok": True}</textarea></div>
      <div><label>args (JSON, optional)</label><input id="e-args" placeholder="{}"></div>
      <div><label>deps (JSON of pip packages, optional)</label><input id="e-deps" placeholder='{"requests": ">=2"}'></div>
      <div><label>timeout_ms (optional)</label><input id="e-timeout" type="number" min="1"></div>
    </div>`, [
    { label: "Cancel", onClick: () => {} },
    { label: "Run", primary: true, onClick: async () => {
      const parseJSON = (id) => {
        const v = $(id).value.trim();
        if (!v) return null;
        try { return JSON.parse(v); } catch { toast(`${id} is not valid JSON`); return undefined; }
      };
      const args = parseJSON("#e-args");
      const deps = parseJSON("#e-deps");
      if (args === undefined || deps === undefined) return false;
      const r = await api("POST", "/api/exec", {
        code: $("#e-code").value,
        args,
        deps,
        timeout_ms: $("#e-timeout").value ? Number($("#e-timeout").value) : null,
      });
      resultModal("Run result", r);
    } },
  ]);
};

/* ── runs ──────────────────────────────────────────────────── */

async function loadRuns() {
  try {
    state.runs = await api("GET", "/api/runs?limit=200");
    renderRuns();
  } catch (e) { toast(String(e)); }
}

function renderRuns() {
  const t = $("#runs-table");
  if (!state.runs.length) {
    t.innerHTML = `<tr><td class="kv">No background runs yet.</td></tr>`;
    return;
  }
  t.innerHTML =
    `<tr><th style="width:9%">run</th><th style="width:12%">agent</th><th style="width:16%">tool</th><th style="width:10%">status</th><th style="width:9%">outcome</th><th style="width:9%">duration</th><th>started</th></tr>` +
    state.runs.map((r) => `<tr class="clickable" data-id="${esc(r.id)}">
      <td class="mono">${esc(r.id)}</td>
      <td class="mono">${esc(r.agent)}</td>
      <td class="mono">${esc(r.tool)}</td>
      <td>${badge(r.status)}</td>
      <td>${r.status === "done" ? (r.ok ? badge("ok") : badge("failed")) : ""}</td>
      <td class="mono">${fmtDur(r.duration_ms)}</td>
      <td class="mono">${esc(r.started_at)}</td>
    </tr>`).join("");
  $$("#runs-table tr.clickable").forEach((tr) => (tr.onclick = () => selectRun(tr.dataset.id)));
}

async function selectRun(id) {
  try {
    const r = await api("GET", `/api/runs/${id}?tail=200`);
    const d = $("#run-detail");
    d.classList.remove("hidden");
    d.innerHTML = `
      <div class="panel-head">
        <h3 class="mono">${esc(r.run.id)} · ${esc(r.run.tool)} <span class="kv">agent ${esc(r.run.agent)}</span></h3>
        ${badge(r.run.status)}
        <div class="actions">${r.run.status === "running" ? `<button class="btn small danger" id="rd-kill">Kill run</button>` : ""}</div>
      </div>
      <pre>${esc(r.summary)}</pre>`;
    const kill = $("#rd-kill");
    if (kill) kill.onclick = () => confirmModal("Kill run", `Kill run ${id}?`, async () => {
      await api("POST", `/api/runs/${id}/kill`);
      toast(`killed ${id}`, true);
      loadRuns();
      selectRun(id);
    });
  } catch (e) { toast(String(e)); }
}

$("#btn-refresh-runs").onclick = loadRuns;

/* ── jobs ──────────────────────────────────────────────────── */

async function loadJobs() {
  try {
    state.jobs = await api("GET", "/api/jobs?all=" + ($("#jobs-all").checked ? "true" : "false"));
    renderJobs();
  } catch (e) { toast(String(e)); }
}

function renderJobs() {
  const t = $("#jobs-table");
  if (!state.jobs?.length) {
    t.innerHTML = `<tr><td class="kv">No jobs — start one from the UI, the API, or a message to the supervisor.</td></tr>`;
    return;
  }
  t.innerHTML =
    `<tr><th style="width:9%">job</th><th style="width:10%">kind</th><th style="width:10%">status</th><th style="width:14%">agent</th><th style="width:7%">turns</th><th>result / error</th></tr>` +
    state.jobs.map((j) => `<tr class="clickable" data-id="${esc(j.id)}">
      <td class="mono">${esc(j.id)}</td>
      <td>${esc(j.kind)}</td>
      <td>${badge(j.status)}</td>
      <td class="mono">${esc(j.agent)}</td>
      <td class="mono">${j.turns}</td>
      <td class="kv" title="${esc(j.result || j.error || "")}">${esc((j.result || j.error || "").slice(0, 120))}</td>
    </tr>`).join("");
  $$("#jobs-table tr.clickable").forEach((tr) => (tr.onclick = () => selectJob(tr.dataset.id)));
}

async function selectJob(id) {
  try {
    const j = await api("GET", `/api/jobs/${id}`);
    const d = $("#job-detail");
    d.classList.remove("hidden");
    d.innerHTML = `
      <div class="panel-head">
        <h3 class="mono">${esc(j.id)} · ${esc(j.kind)} <span class="kv">agent ${esc(j.agent)} · by ${esc(j.created_by)}</span></h3>
        ${badge(j.status)}
        <div class="actions">
          ${j.status === "running" ? `<button class="btn small" id="jd-pause">Pause</button>` : ""}
          ${j.status === "paused" ? `<button class="btn small" id="jd-resume">Resume</button>` : ""}
          ${j.status === "running" || j.status === "paused" ? `<button class="btn small danger" id="jd-stop">Stop</button>` : ""}
        </div>
      </div>
      <label>spec</label><pre>${esc(pretty(j.spec))}</pre>
      ${j.result ? `<label>result</label><pre>${esc(j.result.slice(0, 6000))}</pre>` : ""}
      ${j.error ? `<label>error</label><pre>${esc(j.error.slice(0, 3000))}</pre>` : ""}`;
    $("#jd-stop")?.addEventListener("click", () => confirmModal("Stop job", `Stop job ${id}?`, async () => {
      await api("POST", `/api/jobs/${id}/stop`, { reason: "stopped from UI" });
      toast(`stopped ${id}`, true);
      loadJobs();
      selectJob(id);
    }));
    $("#jd-pause")?.addEventListener("click", async () => {
      try { await api("POST", `/api/jobs/${id}/pause`); toast(`paused ${id}`, true); loadJobs(); selectJob(id); }
      catch (e) { toast(String(e)); }
    });
    $("#jd-resume")?.addEventListener("click", async () => {
      try { await api("POST", `/api/jobs/${id}/resume`); toast(`resumed ${id}`, true); loadJobs(); selectJob(id); }
      catch (e) { toast(String(e)); }
    });
  } catch (e) { toast(String(e)); }
}

$("#jobs-all").onchange = loadJobs;

$("#btn-new-job").onclick = async () => {
  try {
    const agents = await api("GET", "/api/agents?all=false");
    const opts = agents
      .filter((a) => a.id !== "seven")
      .map((a) => `<option value="${esc(a.id)}">${esc(a.id)} “${esc(a.name)}”</option>`)
      .join("");
    openModal("New job", `
      <div class="form-grid">
        <div><label>Kind</label><select id="j-kind"><option>task</option><option>goal</option><option>periodic</option></select></div>
        <div><label>Agent (blank = spawn a dedicated worker)</label><select id="j-agent"><option value="">— spawn worker —</option>${opts}</select></div>
        <div class="full"><label>Task / goal text</label><textarea id="j-text" rows="3"></textarea></div>
        <div class="full"><label>Instructions (optional; periodic uses the text above when blank)</label><input id="j-instr"></div>
        <div><label>interval_s (periodic only)</label><input id="j-interval" type="number" min="1"></div>
        <div><label>max_turns (goal only, default 20)</label><input id="j-maxturns" type="number" min="1" value="20"></div>
      </div>`, [
      { label: "Cancel", onClick: () => {} },
      { label: "Start", primary: true, onClick: async () => {
        const kind = $("#j-kind").value;
        const text = $("#j-text").value.trim();
        if (!text) { toast("task / goal text is required"); return false; }
        const body = {
          kind,
          instructions: $("#j-instr").value,
          agent: $("#j-agent").value || null,
          interval_s: $("#j-interval").value ? Number($("#j-interval").value) : null,
          max_turns: $("#j-maxturns").value ? Number($("#j-maxturns").value) : 20,
        };
        if (kind === "periodic") body.instructions = body.instructions || text;
        else body[kind] = text;
        const j = await api("POST", "/api/jobs", body);
        toast(`started ${j.id}`, true);
        loadJobs();
      } },
    ]);
  } catch (e) { toast(String(e)); }
};

/* ── skills ────────────────────────────────────────────────── */

async function loadSkills() {
  try {
    state.skills = await api("GET", "/api/skills");
    renderSkills();
  } catch (e) { toast(String(e)); }
}

function renderSkills() {
  const t = $("#skills-table");
  if (!state.skills?.length) {
    t.innerHTML = `<tr><td class="kv">No skills yet — bundle generated tools into one here.</td></tr>`;
    return;
  }
  t.innerHTML =
    `<tr><th style="width:20%">name</th><th>description</th><th style="width:26%">tools</th><th style="width:15%">updated</th></tr>` +
    state.skills.map((s) => `<tr class="clickable" data-name="${esc(s.name)}">
      <td class="mono">${esc(s.name)}</td>
      <td title="${esc(s.description)}">${esc(s.description)}</td>
      <td class="mono">${esc(s.tools.join(", ") || "—")}</td>
      <td class="mono">${esc(s.updated_at)}</td>
    </tr>`).join("");
  $$("#skills-table tr.clickable").forEach((tr) => (tr.onclick = () => selectSkill(tr.dataset.name)));
}

async function selectSkill(name) {
  try {
    const s = await api("GET", `/api/skills/${name}`);
    const agents = await api("GET", "/api/agents?all=false");
    const d = $("#skill-detail");
    d.classList.remove("hidden");
    const loadedBy = agents.filter((a) => (a.loaded_skills || []).includes(name)).map((a) => a.id).join(", ") || "none";
    d.innerHTML = `
      <div class="panel-head">
        <h3 class="mono">${esc(s.name)}</h3>
        <div class="actions">
          <select id="sk-agent">${agents.map((a) => `<option value="${esc(a.id)}">${esc(a.id)} “${esc(a.name)}”</option>`).join("")}</select>
          <button class="btn small primary" id="sk-load">Load for agent</button>
          <button class="btn small" id="sk-unload">Unload</button>
          <button class="btn small danger" id="sk-delete">Delete</button>
        </div>
      </div>
      <div class="kv">${esc(s.description)}</div>
      <div class="kv">loaded by: ${esc(loadedBy)}</div>
      <label>instructions</label><pre>${esc(s.instructions || "—")}</pre>
      <label>tools</label><pre>${esc(s.tools.join("\n") || "—")}</pre>`;
    $("#sk-load").onclick = async () => {
      try {
        await api("POST", `/api/skills/${name}/load?agent=${$("#sk-agent").value}`);
        toast(`loaded ${name} for ${$("#sk-agent").value}`, true);
        selectSkill(name);
        loadAgents();
      } catch (e) { toast(String(e)); }
    };
    $("#sk-unload").onclick = async () => {
      try {
        await api("POST", `/api/skills/${name}/unload?agent=${$("#sk-agent").value}`);
        toast(`unloaded ${name}`, true);
        selectSkill(name);
      } catch (e) { toast(String(e)); }
    };
    $("#sk-delete").onclick = () => confirmModal("Delete skill", `Delete skill “${name}”?`, async () => {
      await api("DELETE", `/api/skills/${name}`);
      toast(`deleted ${name}`, true);
      d.classList.add("hidden");
      loadSkills();
    });
  } catch (e) { toast(String(e)); }
}

$("#btn-new-skill").onclick = async () => {
  try {
    const tools = await api("GET", "/api/tools");
    const checks = tools.length
      ? tools.map((t) => `<label class="check" style="margin:3px 0"><input type="checkbox" class="sk-tool" value="${esc(t.name)}"> <span class="mono">${esc(t.name)}</span> <span class="kv">— ${esc((t.description || "").slice(0, 70))}</span></label>`).join("")
      : `<div class="kv">no tools exist yet</div>`;
    openModal("New / replace skill", `
      <div class="form-grid">
        <div><label>Name (snake_case)</label><input id="s-name"></div>
        <div class="full"><label>Description</label><input id="s-description"></div>
        <div class="full"><label>Instructions (apply while loaded)</label><textarea id="s-instructions" rows="4"></textarea></div>
        <div class="full"><label>Tools (all must exist)</label><div style="max-height:32vh;overflow-y:auto">${checks}</div></div>
      </div>`, [
      { label: "Cancel", onClick: () => {} },
      { label: "Save", primary: true, onClick: async () => {
        const name = $("#s-name").value.trim();
        if (!name) { toast("name is required"); return false; }
        await api("POST", "/api/skills", {
          name,
          description: $("#s-description").value,
          instructions: $("#s-instructions").value,
          tools: $$(".sk-tool").filter((c) => c.checked).map((c) => c.value),
        });
        toast(`saved ${name}`, true);
        loadSkills();
      } },
    ]);
  } catch (e) { toast(String(e)); }
};

/* ── memory ────────────────────────────────────────────────── */

async function loadMemory() {
  try {
    state.memory = await api("GET", "/api/memory");
    renderMemory();
  } catch (e) { toast(String(e)); }
}

function renderMemory() {
  const t = $("#memory-table");
  if (!state.memory?.length) {
    t.innerHTML = `<tr><td class="kv">Nothing spilled yet — long tool/run output lands here.</td></tr>`;
    return;
  }
  t.innerHTML =
    `<tr><th style="width:9%">id</th><th style="width:14%">agent</th><th style="width:18%">tool / run</th><th style="width:9%">chars</th><th style="width:8%">lines</th><th>created</th></tr>` +
    state.memory.map((o) => `<tr class="clickable" data-id="${esc(o.id)}">
      <td class="mono">${esc(o.id)}</td>
      <td class="mono">${esc(o.agent)}</td>
      <td class="mono">${esc(o.tool)}</td>
      <td class="mono">${o.chars}</td>
      <td class="mono">${o.lines}</td>
      <td class="mono">${esc(o.created_at ?? "")}</td>
    </tr>`).join("");
  $$("#memory-table tr.clickable").forEach((tr) => (tr.onclick = () => selectMemory(tr.dataset.id, 0)));
}

async function selectMemory(id, offset) {
  try {
    const r = await api("GET", `/api/memory/${id}?offset=${offset}&limit=4000`);
    const d = $("#memory-detail");
    d.classList.remove("hidden");
    d.innerHTML = `
      <div class="panel-head"><h3 class="mono">memory ${esc(id)} <span class="kv">${r.total_chars} chars total</span></h3></div>
      <div class="mem-nav">
        <button class="btn small" id="m-prev" ${offset > 0 ? "" : "disabled"}>← prev</button>
        <span class="kv mono">showing [${r.offset}, ${r.offset + r.chunk.length})${r.next_offset != null ? ` of ${r.total_chars}` : ""}</span>
        <button class="btn small" id="m-next" ${r.next_offset != null ? "" : "disabled"}>next →</button>
      </div>
      <pre>${esc(r.chunk)}</pre>`;
    $("#m-prev").onclick = () => selectMemory(id, Math.max(0, offset - 4000));
    $("#m-next").onclick = () => selectMemory(id, r.next_offset ?? offset);
  } catch (e) { toast(String(e)); }
}

$("#btn-refresh-memory").onclick = loadMemory;

/* ── logs ──────────────────────────────────────────────────── */

async function loadLogs() {
  const params = new URLSearchParams();
  const agent = $("#log-agent").value.trim(); if (agent) params.set("agent", agent);
  const level = $("#log-level").value; if (level) params.set("level", level);
  const grep = $("#log-grep").value.trim(); if (grep) params.set("grep", grep);
  params.set("tail", $("#log-tail").value || "200");
  try {
    const recs = await api("GET", "/api/logs?" + params.toString());
    const box = $("#logs-table");
    if (!recs.length) {
      box.innerHTML = `<div class="line"><span class="lm kv">no matching log lines</span></div>`;
    } else {
      box.innerHTML = recs.map((r) => {
        const t = String(r.t ?? "").replace("T", " ").replace("Z", "").slice(0, 23);
        const extra = Object.entries(r).filter(([k]) => !["t", "level", "msg", "pid"].includes(k));
        const extraHtml = extra.length ? ` <span class="lx">${esc(extra.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" "))}</span>` : "";
        return `<div class="line"><span class="lt">${esc(t)}</span><span class="lv ${esc(r.level)}">${esc(r.level)}</span><span class="lm">${esc(r.msg ?? "")}</span>${extraHtml}</div>`;
      }).join("");
    }
    box.scrollTop = box.scrollHeight;
  } catch (e) { toast(String(e)); }
}

$("#btn-logs").onclick = loadLogs;
$("#log-follow").onchange = (e) => {
  state.logsFollow = e.target.checked;
  if (state.logsTimer) { clearInterval(state.logsTimer); state.logsTimer = null; }
  if (state.logsFollow) state.logsTimer = setInterval(loadLogs, 2000);
};

/* ── system (config & health) ──────────────────────────────── */

async function loadConfig() {
  try {
    const cfg = await api("GET", "/api/config");
    const health = await api("GET", "/api/health");
    const fmtVal = (v) => (v == null ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "object" ? JSON.stringify(v) : String(v));
    const rows = Object.entries({ ...health, ...cfg })
      .map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(fmtVal(v))}</td></tr>`)
      .join("");
    $("#config-table").innerHTML = `<tr><th style="width:24%">key</th><th>value</th></tr>${rows}`;
  } catch (e) { toast(String(e)); }
}

/* ── boot ──────────────────────────────────────────────────── */

refreshHealth();
openEvents();
loadAgents();

setInterval(() => {
  refreshHealth();
  if (state.view === "agents") loadAgents();
  else if (state.view === "activity") { loadRuns(); if (state.subtab === "logs" && state.logsFollow) loadLogs(); }
  else if (state.view === "jobs") loadJobs();
  else if (state.view === "skills") loadSkills();
  else if (state.view === "memory") loadMemory();
}, 3000);
