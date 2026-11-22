const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  view: "agents",
  agents: [],
  selectedAgent: null,
  es: null,
  tools: [],
  selectedTool: null,
  runs: [],
  selectedRun: null,
  logsFollow: false,
  logsTimer: null,
  agentsTimer: null,
  runsTimer: null,
};

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

function toast(msg, ok = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (ok ? " ok" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 6000);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
}

function modal(title, bodyHtml, actions) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHtml;
  const box = $("#modal-actions");
  box.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = "btn" + (a.primary ? " primary" : "");
    b.textContent = a.label;
    b.onclick = a.onClick;
    box.appendChild(b);
  }
  $("#modal-backdrop").classList.remove("hidden");
}

function closeModal() { $("#modal-backdrop").classList.add("hidden"); }
$("#modal-close").onclick = closeModal;
$("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") closeModal(); });

async function refreshHealth() {
  try {
    const h = await api("GET", "/api/health");
    $("#health").textContent = `v${h.version} · ${h.active_agents} agents · up ${h.uptime_s}s · ${h.workspace}`;
  } catch (e) { $("#health").textContent = "api down"; }
}

$$(".nav-btn").forEach((b) => (b.onclick = () => {
  state.view = b.dataset.view;
  $$(".nav-btn").forEach((x) => x.classList.toggle("active", x === b));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + state.view));
  if (state.view === "agents") loadAgents();
  if (state.view === "tools") loadTools();
  if (state.view === "runs") loadRuns();
  if (state.view === "logs") loadLogs();
  if (state.view === "config") loadConfig();
}));

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
  t.innerHTML = `<tr><th>agent</th><th>mode</th><th>status</th><th>inbox</th><th>description</th></tr>` +
    state.agents.map((a) => `<tr class="clickable ${a.id === state.selectedAgent ? "selected" : ""}" data-id="${esc(a.id)}">
      <td class="mono">${esc(a.id)} "${esc(a.name)}"${a.parent ? ` · from ${esc(a.parent)}` : ""}</td>
      <td>${esc(a.mode)}</td><td>${badge(a.status)}</td>
      <td class="mono">${a.inbox_pending}</td><td>${esc(a.description)}</td></tr>`).join("");
  $$("#agents-table tr.clickable").forEach((tr) => (tr.onclick = () => selectAgent(tr.dataset.id)));
}

async function selectAgent(id) {
  state.selectedAgent = id;
  renderAgents();
  const a = await api("GET", `/api/agents/${id}`);
  renderChatHeader(a);
  await loadMessages();
  openEvents(id);
  $("#send-form").classList.remove("hidden");
}

function renderChatHeader(a) {
  $("#chat-title").textContent = `${a.id} "${a.name}" · ${a.mode} ${badge(a.status)}`;
  $("#chat-status").textContent =
    `created ${a.created_at} · last turn ${a.last_turn_at ?? "never"} · inbox: ${a.inbox_tasks} tasks, ${a.inbox_messages} messages` +
    (a.result ? ` · result: ${a.result.slice(0, 200)}` : "") + (a.error ? ` · error: ${a.error}` : "");
  const actions = $("#chat-actions");
  actions.innerHTML = "";
  if (a.id !== "seven") {
    const stop = document.createElement("button");
    stop.className = "btn small danger"; stop.textContent = "Stop";
    stop.onclick = async () => {
      const reason = prompt("Reason (optional):") ?? undefined;
      try { await api("POST", `/api/agents/${a.id}/stop`, { reason }); toast("stopped", true); loadAgents(); } catch (e) { toast(String(e)); }
    };
    actions.appendChild(stop);
  }
  const compact = document.createElement("button");
  compact.className = "btn small"; compact.textContent = "Compact";
  compact.onclick = async () => { try { const r = await api("POST", `/api/agents/${a.id}/compact`); toast(`folded ${r.folded}, kept ${r.kept}`, true); } catch (e) { toast(String(e)); } };
  actions.appendChild(compact);
  const reset = document.createElement("button");
  reset.className = "btn small danger"; reset.textContent = "Reset conversation";
  reset.onclick = async () => {
    if (!confirm("Clear this agent's conversation and summary?")) return;
    try { await api("DELETE", `/api/agents/${a.id}/conversation`); toast("cleared", true); loadMessages(); } catch (e) { toast(String(e)); }
  };
  actions.appendChild(reset);
}

async function loadMessages() {
  if (!state.selectedAgent) return;
  const r = await api("GET", `/api/agents/${state.selectedAgent}/messages?limit=500`);
  renderMessages(r.messages);
}

function renderMessages(messages) {
  const box = $("#messages");
  box.innerHTML = "";
  for (const m of messages) appendMessage(m.message);
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m) {
  const box = $("#messages");
  const div = document.createElement("div");
  div.className = "msg " + (m.role || "user");
  let html = `<div class="role">${esc(m.role)}${m.name ? " · " + esc(m.name) : ""}</div>`;
  if (m.role === "assistant" && m.tool_calls) {
    html += esc(m.content ?? "");
    for (const c of m.tool_calls) {
      html += `<div class="toolcall"><details><summary>${esc(c.function.name)}(${esc(c.function.arguments)})</summary><pre>${esc(c.function.arguments)}</pre></details></div>`;
    }
  } else if (m.role === "tool") {
    html += `<details><summary>result</summary><pre>${esc(m.content ?? "")}</pre></details>`;
  } else {
    html += esc(m.content ?? "");
  }
  div.innerHTML = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function openEvents(agentId) {
  if (state.es) { state.es.close(); state.es = null; }
  state.es = new EventSource(`/api/events?agent=${encodeURIComponent(agentId)}`);
  state.es.addEventListener("message", (e) => {
    const ev = JSON.parse(e.data);
    if (ev.message) appendMessage(ev.message);
  });
  for (const type of ["answer", "tool_call", "tool_result", "compacted", "finished", "spawned", "message"]) {
    state.es.addEventListener(type, () => { loadAgents(); if (state.selectedAgent) loadMessages(); });
  }
  state.es.onerror = () => {};
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
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#send-form").requestSubmit(); }
});

$("#btn-spawn").onclick = () => {
  modal("New agent", `
    <label>Name (unique among active agents)</label><input id="f-name" placeholder="researcher">
    <label>Description</label><input id="f-description">
    <label>Instructions</label><textarea id="f-instructions" rows="3"></textarea>
    <label>Mode</label><select id="f-mode"><option>request</option><option>sequence</option><option>continuous</option></select>
    <label>Tasks (one per line; request takes exactly one)</label><textarea id="f-tasks" rows="3"></textarea>
    <label>interval_s (continuous only)</label><input id="f-interval" type="number">
    <label>max_steps (blank = default)</label><input id="f-maxsteps" type="number">`,
    [{ label: "Cancel", onClick: closeModal },
     { label: "Spawn", primary: true, onClick: async () => {
        try {
          const body = {
            name: $("#f-name").value.trim(), description: $("#f-description").value,
            instructions: $("#f-instructions").value, mode: $("#f-mode").value,
            tasks: $("#f-tasks").value.split("\n").map((s) => s.trim()).filter(Boolean),
            interval_s: $("#f-interval").value ? Number($("#f-interval").value) : null,
            max_steps: $("#f-maxsteps").value ? Number($("#f-maxsteps").value) : null,
          };
          const a = await api("POST", "/api/agents", body);
          closeModal(); toast(`spawned ${a.id}`, true); loadAgents(); selectAgent(a.id);
        } catch (e) { toast(String(e)); }
      } }]);
};

async function loadTools() {
  try {
    state.tools = await api("GET", "/api/tools");
    renderTools();
  } catch (e) { toast(String(e)); }
}

function renderTools() {
  const t = $("#tools-table");
  if (!state.tools.length) { t.innerHTML = `<tr><td colspan="5" class="kv">no tools yet — agents define them with define_tool, or you can define one</td></tr>`; return; }
  t.innerHTML = `<tr><th>name</th><th>revision</th><th>state</th><th>run limit</th><th>updated</th></tr>` +
    state.tools.map((x) => `<tr class="clickable ${state.selectedTool === x.name ? "selected" : ""}" data-name="${esc(x.name)}">
      <td class="mono">${esc(x.name)}</td><td class="mono">r${x.revision}</td>
      <td>${x.disabled ? `<span class="badge disabled">disabled</span>` : `<span class="badge done">enabled</span>`}</td>
      <td class="mono">${x.timeout_ms ? x.timeout_ms + "ms" : "default"}</td><td class="mono">${esc(x.updated_at)}</td></tr>`).join("");
  $$("#tools-table tr.clickable").forEach((tr) => (tr.onclick = () => selectTool(tr.dataset.name)));
}

async function selectTool(name) {
  state.selectedTool = name;
  renderTools();
  const t = await api("GET", `/api/tools/${name}`);
  const h = await api("GET", `/api/tools/${name}/health?last=20`);
  const d = $("#tool-detail");
  d.classList.remove("hidden");
  d.innerHTML = `
    <h3 class="mono">${esc(t.meta.name)} r${t.meta.revision} ${t.meta.disabled ? `(disabled: ${esc(t.meta.disabled.reason)})` : ""}</h3>
    <div class="kv">${esc(t.meta.description)}</div>
    <div class="actions">
      <button class="btn small" id="td-call">Call…</button>
      <button class="btn small" id="td-start">Start background</button>
      ${t.meta.disabled ? `<button class="btn small" id="td-enable">Enable</button>` : `<button class="btn small" id="td-disable">Disable…</button>`}
      <button class="btn small danger" id="td-delete">Delete</button>
    </div>
    <label>parameters (JSON Schema)</label><pre>${esc(JSON.stringify(t.meta.parameters, null, 2))}</pre>
    <label>source</label><pre>${esc(t.source)}</pre>
    <label>health</label><pre>${esc(h.report)}</pre>`;
  $("#td-call").onclick = () => toolCallModal(name, "call");
  $("#td-start").onclick = () => toolCallModal(name, "start");
  const dis = $("#td-disable");
  if (dis) dis.onclick = async () => {
    const reason = prompt("Reason:") ?? "";
    try { await api("POST", `/api/tools/${name}/disable`, { reason }); toast("disabled", true); selectTool(name); loadTools(); } catch (e) { toast(String(e)); }
  };
  const en = $("#td-enable");
  if (en) en.onclick = async () => { try { await api("POST", `/api/tools/${name}/enable`); toast("enabled", true); selectTool(name); } catch (e) { toast(String(e)); } };
  $("#td-delete").onclick = async () => {
    if (!confirm(`Delete tool ${name} and its history?`)) return;
    try { await api("DELETE", `/api/tools/${name}`); toast("deleted", true); state.selectedTool = null; $("#tool-detail").classList.add("hidden"); loadTools(); } catch (e) { toast(String(e)); }
  };
}

function toolCallModal(name, mode) {
  modal(`${mode === "call" ? "Call" : "Start background"} ${name}`, `
    <label>args (JSON object)</label><textarea id="c-args" rows="5">{}</textarea>
    <label>timeout_ms (blank = default)</label><input id="c-timeout" type="number">`,
    [{ label: "Cancel", onClick: closeModal },
     { label: mode === "call" ? "Call" : "Start", primary: true, onClick: async () => {
        let args, timeout_ms;
        try { args = JSON.parse($("#c-args").value || "{}"); } catch { toast("args is not valid JSON"); return; }
        timeout_ms = $("#c-timeout").value ? Number($("#c-timeout").value) : null;
        try {
          if (mode === "call") {
            const r = await api("POST", `/api/tools/${name}/call`, { args, timeout_ms });
            closeModal();
            modal(`Result of ${name}`, `<pre>${esc(r.ok ? (typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)) : "error: " + r.error)}\n${r.logs?.length ? "--- output ---\n" + esc(r.logs.join("\n")) : ""}\n(${r.duration_ms}ms)</pre>`, [{ label: "Close", onClick: closeModal }]);
          } else {
            const r = await api("POST", `/api/tools/${name}/start`, { args, timeout_ms });
            closeModal(); toast(`started ${r.run}`, true); loadRuns();
          }
        } catch (e) { toast(String(e)); }
      } }]);
}

$("#btn-define").onclick = () => {
  modal("Define tool", `
    <label>Name (snake_case)</label><input id="d-name" placeholder="read_files">
    <label>Description (what callers see)</label><input id="d-description">
    <label>parameters (JSON Schema)</label><textarea id="d-params" rows="3">{"type":"object"}</textarea>
    <label>code (module source; <code>default(args)</code> is the result)</label><textarea id="d-code" rows="10">def default(args):\n    return ...</textarea>
    <label>deps (JSON, pip packages, optional)</label><input id="d-deps" placeholder='{"requests": ">=2"}'>
    <label>test_args (JSON, optional trial run)</label><input id="d-testargs">
    <label>timeout_ms (optional)</label><input id="d-timeout" type="number">`,
    [{ label: "Cancel", onClick: closeModal },
     { label: "Save", primary: true, onClick: async () => {
        const parse = (id, fallback) => { const v = $(id).value.trim(); if (!v) return fallback; try { return JSON.parse(v); } catch { toast(`${id} is not valid JSON`); throw new Error("stop"); } };
        try {
          const body = { name: $("#d-name").value.trim(), description: $("#d-description").value,
            parameters: parse("#d-params", { type: "object" }), code: $("#d-code").value,
            deps: parse("#d-deps", null), test_args: parse("#d-testargs", null),
            timeout_ms: $("#d-timeout").value ? Number($("#d-timeout").value) : null };
          const m = await api("POST", "/api/tools", body);
          closeModal(); toast(`saved ${m.name} r${m.revision}`, true); loadTools();
        } catch (e) { if (String(e) !== "stop") toast(String(e)); }
      } }]);
};

$("#btn-exec").onclick = () => {
  modal("Run Python", `
    <label>code (module source; <code>default(args)</code> is the result; <code>seven.llm.chat</code>, <code>seven.db</code> available)</label>
    <textarea id="e-code" rows="10">print("hello")\ndef default(args):\n    return {"ok": True}</textarea>
    <label>args (JSON, optional)</label><input id="e-args" placeholder="{}">
    <label>timeout_ms (optional)</label><input id="e-timeout" type="number">`,
    [{ label: "Cancel", onClick: closeModal },
     { label: "Run", primary: true, onClick: async () => {
        try {
          const args = $("#e-args").value.trim() ? JSON.parse($("#e-args").value) : null;
          const r = await api("POST", "/api/exec", { code: $("#e-code").value, args,
            timeout_ms: $("#e-timeout").value ? Number($("#e-timeout").value) : null });
          closeModal();
          modal("Run result", `<pre>${esc(r.ok ? (typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)) : "error: " + (r.error ?? ""))}\n${r.logs?.length ? "--- output ---\n" + esc(r.logs.join("\n")) : ""}\n(${r.duration_ms}ms)</pre>`, [{ label: "Close", onClick: closeModal }]);
        } catch (e) { toast(String(e)); }
      } }]);
};

async function loadRuns() {
  try {
    state.runs = await api("GET", "/api/runs?limit=200");
    renderRuns();
  } catch (e) { toast(String(e)); }
}

function renderRuns() {
  const t = $("#runs-table");
  if (!state.runs.length) { t.innerHTML = `<tr><td class="kv">no background runs</td></tr>`; return; }
  t.innerHTML = `<tr><th>run</th><th>agent</th><th>tool</th><th>status</th><th>outcome</th><th>duration</th><th>started</th></tr>` +
    state.runs.map((r) => `<tr class="clickable" data-id="${esc(r.id)}">
      <td class="mono">${esc(r.id)}</td><td class="mono">${esc(r.agent)}</td><td class="mono">${esc(r.tool)}</td>
      <td>${badge(r.status)}</td>
      <td>${r.status === "done" ? (r.ok ? '<span class="badge done">ok</span>' : '<span class="badge failed">failed</span>') : r.status === "lost" ? '<span class="badge stopped">lost</span>' : ""}</td>
      <td class="mono">${r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + "s" : ""}</td>
      <td class="mono">${esc(r.started_at)}</td></tr>`).join("");
  $$("#runs-table tr.clickable").forEach((tr) => (tr.onclick = () => selectRun(tr.dataset.id)));
}

async function selectRun(id) {
  state.selectedRun = id;
  const r = await api("GET", `/api/runs/${id}?tail=200`);
  const d = $("#run-detail");
  d.classList.remove("hidden");
  d.innerHTML = `
    <h3 class="mono">${esc(r.run.id)} ${esc(r.run.tool)} (agent ${esc(r.run.agent)}) ${badge(r.run.status)}</h3>
    <div class="actions">${r.run.status === "running" ? `<button class="btn small danger" id="rd-kill">Kill run</button>` : ""}</div>
    <pre>${esc(r.summary)}</pre>`;
  const kill = $("#rd-kill");
  if (kill) kill.onclick = async () => { try { await api("POST", `/api/runs/${id}/kill`); toast("killed", true); loadRuns(); selectRun(id); } catch (e) { toast(String(e)); } };
}

$("#btn-refresh-runs").onclick = loadRuns;

async function loadLogs() {
  const params = new URLSearchParams();
  const agent = $("#log-agent").value.trim(); if (agent) params.set("agent", agent);
  const level = $("#log-level").value; if (level) params.set("level", level);
  const grep = $("#log-grep").value.trim(); if (grep) params.set("grep", grep);
  params.set("tail", $("#log-tail").value || "200");
  try {
    const recs = await api("GET", "/api/logs?" + params.toString());
    const box = $("#logs-table");
    box.innerHTML = recs.map((r) => `<div class="line ${esc(r.level)}">${esc(JSON.stringify(r))}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  } catch (e) { toast(String(e)); }
}

$("#btn-logs").onclick = loadLogs;
$("#log-follow").onchange = (e) => {
  state.logsFollow = e.target.checked;
  if (state.logsTimer) { clearInterval(state.logsTimer); state.logsTimer = null; }
  if (state.logsFollow) state.logsTimer = setInterval(loadLogs, 2000);
};

async function loadConfig() {
  const cfg = await api("GET", "/api/config");
  const health = await api("GET", "/api/health");
  const rows = Object.entries({ ...health, ...cfg }).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join("");
  $("#config-table").innerHTML = `<tr><th>key</th><th>value</th></tr>${rows}`;
}

refreshHealth();
loadAgents();
state.agentsTimer = setInterval(() => { if (state.view === "agents") loadAgents(); refreshHealth(); }, 3000);
state.runsTimer = setInterval(() => { if (state.view === "runs") loadRuns(); }, 2500);
