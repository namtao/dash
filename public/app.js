"use strict";
// Dash frontend: vanilla JS, không build. Trạng thái tiến trình được poll mỗi 2s
// và vá vào DOM tại chỗ (data-*), nên form đang nhập không bị vẽ lại.

const S = {
  config: null,
  status: { runs: {}, ports: [] },
  sel: null, // id dự án đang xem
  tab: "commands",
  info: null, // git, env, manifests của dự án đang xem
  logKey: null,
  filter: "",
  pkg: { manifest: null, rows: null, outdated: null, filter: "", directOnly: true, results: null, searching: false, loading: false, error: "" },
  waiters: [],
  condaEnvs: [],
  system: null, // công cụ có trên máy, địa chỉ đang nghe
};
const TASK = "_task";

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const keyOf = (pid, cid) => `${pid}/${cid}`;
const project = (id = S.sel) => S.config?.projects.find((p) => p.id === id);
const store = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem(`dash:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(`dash:${k}`, JSON.stringify(v));
    } catch {}
  },
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-Dash": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) toLogin();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Báo server là người dùng đang thao tác (gõ phím, bấm, cuộn, di chuột), tối đa mỗi phút. Vào qua Tailscale mà 30 phút
// không thao tác thì server tự đăng xuất; request tự động (giá coin, usage…) không tính.
(() => {
  let last = 0;
  const ping = () => {
    if (Date.now() - last < 60000) return;
    last = Date.now();
    fetch("/api/auth/active", { method: "POST", headers: { "X-Dash": "1" } })
      .then((r) => r.status === 401 && toLogin())
      .catch(() => {});
  };
  for (const t of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"]) window.addEventListener(t, ping, { capture: true, passive: true });
})();

// Phiên đăng nhập hết hạn / bị thu hồi: đưa cả cửa sổ (không phải khung tab) về trang đăng nhập
function toLogin() {
  const t = window.top.location;
  if (!t.pathname.startsWith("/login.html")) t.href = `/login.html?next=${encodeURIComponent(t.pathname + t.search)}`;
}

// Toast nằm trong top layer (popover) và được đưa lên lại mỗi lần hiện, nên luôn nổi trên modal đang mở
function toast(msg, type = "info", ms = 3500) {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.append(el);
  try {
    if (box.matches(":popover-open")) box.hidePopover();
    box.showPopover();
  } catch {}
  setTimeout(() => {
    el.remove();
    try {
      if (!box.children.length) box.hidePopover();
    } catch {}
  }, type === "error" ? 7000 : ms);
}

// Hộp thoại hỏi (thay cho confirm/alert của trình duyệt). Mỗi lần mở là một <dialog> riêng nên xếp chồng
// được lên modal đang mở mà không xoá nội dung của nó. Trả về id của nút được bấm ("cancel" khi Esc).
function askDialog({ title = "Confirm", message = "", detail = "", buttons }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "modal ask-modal";
    d.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2></div>
      <div class="modal-body"><p class="ask-msg">${esc(message)}</p>${detail ? `<pre class="ask-detail">${esc(detail)}</pre>` : ""}</div>
      <div class="modal-foot">${buttons.map((b) => `<button class="btn ${b.cls || ""}" data-ask="${esc(b.id)}">${esc(b.label)}</button>`).join("")}</div>`;
    let result = "cancel";
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ask]");
      if (b) result = b.dataset.ask;
      if (b || e.target === d) d.close();
    });
    d.addEventListener("close", () => {
      d.remove();
      resolve(result);
    });
    document.body.append(d);
    d.showModal();
    $(".modal-foot .btn:last-child", d).focus();
  });
}
const confirmDialog = (message, { title = "Confirm", ok = "OK", danger = false, detail = "" } = {}) =>
  askDialog({ title, message, detail, buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: ok, cls: danger ? "danger" : "primary" }] }).then((r) => r === "ok");
window.confirmDialog = confirmDialog;

async function guarded(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, "ok");
    return r;
  } catch (e) {
    toast(e.message, "error");
    return null;
  }
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const fmtMem = (kb) => (kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);
const ago = (t) => `${fmtDuration(Date.now() - t)} ago`;

const runOf = (key) => S.status.runs[key];
const isRunning = (key) => Boolean(runOf(key)?.running);
const portOpen = (port) => S.status.ports.includes(port);
const runningCount = (p) => p.commands.filter((c) => isRunning(keyOf(p.id, c.id))).length + (isRunning(keyOf(p.id, TASK)) ? 1 : 0);

function whenTaskDone(key, cb) {
  S.waiters.push({ key, cb, after: Date.now() - 1000 });
}

// ---------- routing ----------
function go(id, tab) {
  location.hash = id ? `#/p/${encodeURIComponent(id)}/${tab || "commands"}` : "#/";
}

function readHash() {
  const m = location.hash.match(/^#\/p\/([^/]+)(?:\/(\w+))?/);
  const id = m ? decodeURIComponent(m[1]) : null;
  const tab = m?.[2] || "commands";
  const changedProject = id !== S.sel;
  S.sel = id && project(id) ? id : null;
  S.tab = tab;
  if (changedProject) {
    S.info = null;
    S.logKey = null;
    S.pkg = { ...S.pkg, manifest: null, rows: null, outdated: null, results: null, error: "" };
  }
  render();
  if (S.sel && (changedProject || !S.info)) loadInfo();
}

async function loadInfo() {
  const id = S.sel;
  const info = await guarded(() => api("GET", `/api/projects/${id}/info`));
  if (id !== S.sel || !info) return;
  S.info = info;
  if (!S.pkg.manifest || !info.manifests.some((m) => m.id === S.pkg.manifest)) S.pkg.manifest = info.manifests[0]?.id || null;
  renderMain();
}

async function loadConfig() {
  S.config = await api("GET", "/api/config");
}

// ---------- render: khung ----------
function render() {
  renderSidebar();
  renderMain();
}

function matches(p, q) {
  if (!q) return true;
  const hay = [p.name, p.description, p.path, ...p.tags, ...p.commands.map((c) => `${c.name} ${c.cmd}`)].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

// Dự án đang chạy lên trước (nhiều tiến trình hơn đứng trên), giữ thứ tự cấu hình trong mỗi nhóm.
function byActivity(list) {
  return list
    .map((p, i) => ({ p, i, n: runningCount(p) }))
    .sort((a, b) => (b.n > 0) - (a.n > 0) || b.n - a.n || a.i - b.i)
    .map((x) => x.p);
}

function renderSidebar() {
  const list = byActivity((S.config?.projects || []).filter((p) => matches(p, S.filter)));
  $("#project-count").textContent = S.config ? `(${S.config.projects.length})` : "";
  $("#project-list").innerHTML =
    list
      .map((p) => {
        const n = runningCount(p);
        return `<li class="${p.id === S.sel ? "active" : ""}" data-action="open-project" data-id="${esc(p.id)}" title="${esc(p.path)}">
          <span class="dot ${n ? "on" : ""}"></span>
          <span class="pl-name">${esc(p.name)}</span>
          ${n ? `<span class="pl-count">${n}</span>` : `<span class="pl-kind">${esc(p.tags[0] || "")}</span>`}
        </li>`;
      })
      .join("") || `<li class="faint" style="cursor:default">No projects</li>`;
  $(".nav-home").classList.toggle("active", !S.sel);
}

function renderMain() {
  const main = $("#main");
  if (!S.config) {
    main.innerHTML = `<div class="page"><div class="empty"><span class="spinner"></span></div></div>`;
    return;
  }
  const p = project();
  // Một trang: phần trên (thống kê + đang chạy) luôn hiện, phần dưới là lưới dự án hoặc chi tiết dự án đang chọn
  main.innerHTML = `<div class="page">
    ${p ? "" : `<div id="overview-top">${overviewTop()}</div>`}
    <div id="detail" class="section">${p ? projectView(p) : projectsGrid()}</div>
  </div>`;
  afterRender();
}

// ---------- Tổng quan ----------
function overviewTop() {
  const runs = Object.entries(S.status.runs).filter(([, r]) => r.running);
  const mem = runs.reduce((a, [, r]) => a + r.rssKB, 0);
  const ports = S.config.projects.flatMap((p) => p.commands.filter((c) => c.port && portOpen(c.port)));
  return `<div class="stats">
      <div class="card stat"><div class="label">Projects</div><div class="value">${S.config.projects.length}</div></div>
      <div class="card stat"><div class="label">Running processes</div><div class="value" style="color:var(--green)">${runs.length}</div></div>
      <div class="card stat"><div class="label">Open ports</div><div class="value">${new Set(ports.map((c) => c.port)).size}</div></div>
      <div class="card stat"><div class="label">Memory used</div><div class="value">${fmtMem(mem)}</div></div>
    </div>
    <div class="card section">
      <div class="card-head"><h3>Running</h3>
        <div class="btn-group">${runs.length ? `<button class="btn sm danger" data-action="stop-all">■ Stop all</button>` : ""}</div>
      </div>
      <div id="running-table">${runningTable()}</div>
    </div>`;
}

function projectsGrid() {
  const projects = byActivity(S.config.projects.filter((p) => matches(p, S.filter)));
  return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <h3 style="font-size:14px">Projects</h3><span class="muted" style="font-size:12.5px">${projects.length}${S.filter ? ` / ${S.config.projects.length} (filtered)` : ""}</span>
    </div>
    ${
      projects.length
        ? `<div class="grid">${projects.map(projectCard).join("")}</div>`
        : `<div class="card empty">No projects yet. <a href="#" data-action="add-project">Add a project</a> or <a href="#" data-action="scan">scan a folder</a>.</div>`
    }`;
}

function runningTable() {
  const rows = [];
  for (const [key, r] of Object.entries(S.status.runs)) {
    if (!r.running) continue;
    const [pid, cid] = key.split("/");
    const p = project(pid);
    rows.push(`<tr>
      <td><a href="#/p/${esc(pid)}/commands">${esc(p?.name || pid)}</a></td>
      <td><strong>${esc(r.label || cid)}</strong> ${r.background ? `<span class="chip violet">background</span>` : ""}<div class="sub mono">${esc(r.display || "")}</div></td>
      <td class="mono">${r.pid}</td>
      <td>${fmtDuration(Date.now() - r.startedAt)}</td>
      <td>${r.cpu}%</td>
      <td>${fmtMem(r.rssKB)}</td>
      <td class="actions">
        ${cid === TASK ? `<button class="btn sm danger" data-action="task-stop" data-pid="${esc(pid)}">Stop</button>` : `<button class="btn sm" data-action="cmd-restart" data-pid="${esc(pid)}" data-cid="${esc(cid)}">↻</button>
        <button class="btn sm danger" data-action="cmd-stop" data-pid="${esc(pid)}" data-cid="${esc(cid)}">■ Stop</button>`}
      </td></tr>`);
  }
  if (!rows.length) return `<div class="empty">Nothing is running.</div>`;
  return `<div class="table-wrap"><table class="run-table"><thead><tr><th>Project</th><th>Command</th><th>PID</th><th>Uptime</th><th>CPU</th><th>RAM</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

const isRemotePath = (p) => String(p || "").startsWith("ssh://");
// ssh://<id>/dir -> "Nhãn:/dir"
function displayPath(p) {
  const m = String(p || "").match(/^ssh:\/\/([^/]+)(\/.*)$/);
  if (!m) return p;
  return `${S.config?.ssh.find((x) => x.id === m[1])?.label || m[1]}:${m[2]}`;
}

function projectCard(p) {
  const n = runningCount(p);
  const main = p.commands.find((c) => c.background) || p.commands[0];
  const key = main && keyOf(p.id, main.id);
  return `<div class="card pcard" data-action="open-project" data-id="${esc(p.id)}">
    <div class="pc-top"><span class="dot ${n ? "on" : ""}"></span><span class="pc-name">${esc(p.name)}</span>
      ${n ? `<span class="chip green">${n} running</span>` : ""}
    </div>
    <div class="pc-path">${esc(displayPath(p.path))}</div>
    ${p.description ? `<div class="pc-desc">${esc(p.description)}</div>` : ""}
    <div class="tags">${p.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}
      ${p.env.type !== "none" ? `<span class="chip blue">${esc(p.env.type)}${p.env.name ? `: ${esc(p.env.name)}` : ""}</span>` : ""}
    </div>
    ${
      main
        ? `<div class="btn-group" style="margin-top:10px">${
            isRunning(key)
              ? `<button class="btn sm danger" data-action="cmd-stop" data-pid="${esc(p.id)}" data-cid="${esc(main.id)}">■ ${esc(main.name)}</button>`
              : `<button class="btn sm success" data-action="cmd-start" data-pid="${esc(p.id)}" data-cid="${esc(main.id)}">▶ ${esc(main.name)}</button>`
          }${p.url ? `<button class="btn sm ghost" data-action="open-url" data-url="${esc(p.url)}">↗ Open web</button>` : ""}</div>`
        : ""
    }
  </div>`;
}

// ---------- Trang dự án ----------
function projectView(p) {
  const info = S.info;
  const git = info?.git;
  const remote = isRemotePath(p.path);
  const tabs = [
    ["commands", "Commands", p.commands.length],
    ...(remote ? [] : [["env", "Env", null], ["packages", "Packages", null]]),
    ["settings", "Config", null],
  ];
  const body = { commands: commandsTab, env: envTab, packages: packagesTab, settings: settingsTab }[S.tab] || commandsTab;
  return `<div class="project-detail">
    <div class="phead">
      <div style="min-width:0">
        <h1>${esc(p.name)}</h1>
        <div class="ph-path" data-action="copy" data-text="${esc(p.path)}" title="Click to copy path">${esc(displayPath(p.path))}</div>
        <div class="ph-meta">
          ${remote ? `<span class="chip violet">SSH</span>` : ""}
          ${p.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}
          ${info && !info.exists ? `<span class="chip red">folder not found</span>` : ""}
          ${
            git
              ? `<span class="chip outline mono" title="${esc(git.last)}">⎇ ${esc(git.branch)}${git.changes ? ` · ${git.changes} changes` : ""}${git.ahead ? ` · ↑${git.ahead}` : ""}${git.behind ? ` · ↓${git.behind}` : ""}</span>
                 <span class="chip outline" title="Last commit">${esc(git.last)}</span>`
              : ""
          }
        </div>
        ${p.description ? `<div class="muted" style="margin-top:8px">${esc(p.description)}</div>` : ""}
      </div>
      <div class="btn-group">
        ${p.url ? `<button class="btn sm" data-action="open-url" data-url="${esc(p.url)}">↗ Open web</button>` : ""}
        ${remote ? "" : `<button class="btn sm" data-action="open" data-what="folder" title="Open in the file manager">${W.ICON.files} Folder</button>`}
      </div>
    </div>
    <nav class="tabs">${tabs
      .map(([id, label, count]) => `<button class="tab ${S.tab === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}${count != null ? `<span class="chip">${count}</span>` : ""}</button>`)
      .join("")}</nav>
    ${body(p)}
  </div>`;
}

// ----- Tab Lệnh -----
function commandsTab(p) {
  const rows = p.commands.map((c) => commandRow(p, c)).join("");
  return `<div class="card">
      <div class="card-head"><h3>Commands</h3>
        <div class="btn-group">
          ${isRemotePath(p.path) ? "" : `<button class="btn sm" data-action="detect-commands">Auto-detect</button>`}
          <button class="btn sm primary" data-action="cmd-new">+ Add command</button>
        </div>
      </div>
      <div class="cmd-list">${rows || `<div class="empty">No commands yet. Click <b>Auto-detect</b> or <b>+ Add command</b>.</div>`}</div>
    </div>
    ${logCard(p, [...p.commands.map((c) => [c.id, c.name]), [TASK, "Task"]], true)}`;
}

function commandRow(p, c) {
  const key = keyOf(p.id, c.id);
  const sel = S.logKey === key;
  return `<div class="cmd ${sel ? "selected" : ""}" data-cmd-row="${esc(key)}">
    <span class="dot" data-dot="${esc(key)}"></span>
    <div style="min-width:0">
      <div class="cmd-title">
        <strong>${esc(c.name)}</strong>
        ${c.background ? `<span class="chip violet" title="Keeps running when Dash exits">background</span>` : `<span class="chip outline" title="Stopped when Dash exits">foreground</span>`}
        ${c.port ? `<span data-port-chip="${c.port}">${portChip(c.port, c.url)}</span>` : ""}
        ${c.autostart ? `<span class="chip blue" title="Starts when Dash starts">autostart</span>` : ""}
        ${c.autoRestart ? `<span class="chip amber" title="Restarts on failure">auto-restart</span>` : ""}
        ${c.cwd ? `<span class="chip outline mono">./${esc(c.cwd)}</span>` : ""}
      </div>
      <div class="cmd-line" title="${esc(c.cmd)}">$ ${esc(c.cmd)}${c.stopCmd ? `  <span class="faint">· stop: ${esc(c.stopCmd)}</span>` : ""}</div>
      <div class="cmd-stats" data-stats="${esc(key)}"></div>
    </div>
    <div class="btn-group" data-btns="${esc(key)}"></div>
  </div>`;
}

function portChip(port, url) {
  const open = portOpen(port);
  const href = url || `http://localhost:${port}`;
  return open
    ? `<a class="chip green" href="${esc(href)}" target="_blank" rel="noopener" title="Port is open · click to open">:${port} ↗</a>`
    : `<span class="chip outline" title="Port is closed">:${port}</span>`;
}

function statsHTML(key) {
  const r = runOf(key);
  if (!r) return `<span class="faint">Not started</span>`;
  if (r.running) {
    return `<span>PID <b class="mono">${r.pid}</b></span><span>uptime ${fmtDuration(Date.now() - r.startedAt)}</span><span>CPU ${r.cpu}%</span><span>RAM ${fmtMem(r.rssKB)}</span>${r.procs > 1 ? `<span>${r.procs} processes</span>` : ""}${r.adopted ? `<span title="Dash restarted and re-adopted this process">adopted</span>` : ""}`;
  }
  if (r.restarting) return `<span style="color:var(--amber)">Auto-restarting…</span>`;
  const bad = r.exitCode && !r.signal;
  const why = r.signal ? `stopped (${r.signal})` : r.exitCode == null ? "stopped" : `exit code ${r.exitCode}`;
  return `<span style="color:${bad ? "var(--red)" : "inherit"}">${why}</span>${r.exitedAt ? `<span>${ago(r.exitedAt)}</span>` : ""}`;
}

function buttonsHTML(p, c) {
  const key = keyOf(p.id, c.id);
  const on = isRunning(key);
  const a = `data-pid="${esc(p.id)}" data-cid="${esc(c.id)}"`;
  const idx = p.commands.indexOf(c);
  return `${
    on
      ? `<button class="btn sm danger" data-action="cmd-stop" ${a}>■ Stop</button><button class="btn sm" data-action="cmd-restart" ${a} title="Restart">↻</button>`
      : `<button class="btn sm success" data-action="cmd-start" ${a}>▶ Start</button>${c.stopCmd ? `<button class="btn sm" data-action="cmd-stop" ${a} title="Run stop command: ${esc(c.stopCmd)}">■</button>` : ""}`
  }
    <button class="btn sm ${S.logKey === key ? "primary" : ""}" data-action="show-log" data-key="${esc(key)}">Log</button>
    <button class="btn sm icon ghost" data-action="cmd-move" data-dir="-1" ${a} title="Move up" ${idx === 0 ? "disabled" : ""}>↑</button>
    <button class="btn sm icon ghost" data-action="cmd-move" data-dir="1" ${a} title="Move down" ${idx === p.commands.length - 1 ? "disabled" : ""}>↓</button>
    <button class="btn sm icon ghost" data-action="cmd-edit" ${a} title="Edit">✎</button>
    <button class="btn sm icon ghost" data-action="cmd-delete" ${a} title="Delete">✕</button>`;
}

// ----- Log viewer -----
function logCard(p, entries, withShell) {
  const keys = entries.map(([id]) => keyOf(p.id, id));
  if (!S.logKey || !keys.includes(S.logKey)) {
    S.logKey = keys.find((k) => isRunning(k)) || keys.find((k) => runOf(k)) || keys[0];
  }
  const wrap = store.get("logWrap", false);
  const tall = store.get("logTall", false);
  return `<div class="card log-card">
    <div class="card-head">
      <div class="log-tabs">${entries
        .map(([id, label]) => {
          const k = keyOf(p.id, id);
          return `<button class="log-tab ${k === S.logKey ? "active" : ""}" data-action="show-log" data-key="${esc(k)}"><span class="dot" data-dot="${esc(k)}"></span>${esc(label)}</button>`;
        })
        .join("")}</div>
      <div class="btn-group">
        <button class="btn sm ghost" data-action="log-wrap" title="Wrap long lines">${wrap ? "↩ Wrap: on" : "↩ Wrap: off"}</button>
        <button class="btn sm ghost" data-action="log-tall">${tall ? "Collapse" : "Expand"}</button>
        <a class="btn sm ghost" href="/api/logs/download?key=${encodeURIComponent(S.logKey)}" data-log-download>Download</a>
        <button class="btn sm ghost" data-action="log-clear">Clear</button>
      </div>
    </div>
    <pre class="log ${wrap ? "wrap" : ""} ${tall ? "tall" : ""}" id="log"></pre>
    ${
      withShell
        ? `<div class="shell">
            <span class="prompt">$</span>
            <input class="cmd-input" id="shell-cmd" placeholder="Run a command in the project env (Enter) — e.g. pip list, git pull, npm run build" autocomplete="off" />
            <input class="cwd-input" id="shell-cwd" placeholder="cwd" title="Subfolder (empty = project root)" />
            <button class="btn sm primary" data-action="shell-run">Run</button>
            <button class="btn sm danger" data-action="task-stop" data-pid="${esc(p.id)}" data-task-stop>Stop task</button>
          </div>`
        : ""
    }
  </div>`;
}

const LOG = { es: null, key: null, text: "", raf: 0 };

function mountLog() {
  const pre = $("#log");
  if (!pre) return closeLog();
  if (LOG.key === S.logKey && LOG.es) return paintLog(true);
  closeLog();
  LOG.key = S.logKey;
  LOG.text = "";
  if (!LOG.key) return;
  const es = new EventSource(`/api/logs/stream?key=${encodeURIComponent(LOG.key)}`);
  LOG.es = es;
  es.addEventListener("reset", () => {
    LOG.text = "";
    paintLog();
  });
  es.addEventListener("data", (e) => {
    LOG.text += JSON.parse(e.data);
    if (LOG.text.length > 400000) LOG.text = LOG.text.slice(-300000);
    paintLog();
  });
}

function closeLog() {
  LOG.es?.close();
  LOG.es = null;
  LOG.key = null;
}

function paintLog(force) {
  cancelAnimationFrame(LOG.raf);
  LOG.raf = requestAnimationFrame(() => {
    const pre = $("#log");
    if (!pre) return;
    const stick = force || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    if (!LOG.text.trim()) {
      pre.innerHTML = `<span class="log-empty">No log yet. Run the command to see its output here.</span>`;
      return;
    }
    // Giữ màu ANSI của chương trình; dòng không có màu thì tô theo nội dung (lỗi, cảnh báo, thành công)
    const tail = LOG.text.split("\n").slice(-5000).join("\n");
    pre.innerHTML = ansiToHtml(tail, {
      lineClass: (l) => {
        if (l.startsWith("━━━")) return "l-head";
        if (l.startsWith("$ ")) return "l-cmd";
        if (/^\s*(warn(ing)?\b|\[warn)/i.test(l)) return "l-warn";
        if (/^(!!!|Traceback|\s*File ".*", line)|\b(error|exception|failed|fatal|err!)\b/i.test(l)) return "l-err";
        if (/\b(warn|warning|deprecat)/i.test(l)) return "l-warn";
        if (/^✓|\b(successfully|ready in|running on|listening|compiled|started server)/i.test(l)) return "l-ok";
        return "";
      },
    }).replace(/<span class="l-cmd">\$ ([^\n]*)<\/span>/g, (_, cmd) => `<span class="l-cmd"><span class="l-prompt">$</span> ${window.W?.highlightShell ? W.highlightShell(cmd.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")) : cmd}</span>`);
    if (stick) pre.scrollTop = pre.scrollHeight;
  });
}

// ----- Tab Môi trường -----
function envTab(p) {
  const env = p.env;
  const st = S.info?.env;
  const pyManifests = (S.info?.manifests || []).filter((m) => m.kind === "python");
  const statusBox = !S.info
    ? `<div class="empty"><span class="spinner"></span></div>`
    : env.type === "none"
      ? `<div class="notice">This project has no Python env; commands use the system Python. Pick <b>conda</b>, <b>venv</b> or <b>uv</b> and save to set one up.</div>`
      : `<dl class="kv">
          <dt>Status</dt><dd>${st.exists ? `<span class="chip green">✓ created</span>` : `<span class="chip amber">not created</span>`}</dd>
          <dt>Type</dt><dd>${esc(env.type)}</dd>
          <dt>${env.type === "conda" ? "Name" : "Path"}</dt><dd>${esc(st.target || "")}</dd>
          ${st.exists ? `<dt>Prefix</dt><dd>${esc(st.prefix)}</dd><dt>Python</dt><dd>${esc(st.pythonVersion || "?")}</dd><dt>Installer</dt><dd>${st.hasPip ? "pip" : "uv pip"}</dd>` : ""}
        </dl>
        <div class="btn-group" style="margin-top:14px">
          ${!st.exists ? `<button class="btn primary" data-action="env-create">Create env</button>` : ""}
          ${
            st.exists
              ? pyManifests
                  .filter((m) => m.files.length)
                  .map((m) => `<button class="btn" data-action="pkg-install-all" data-manifest="${esc(m.id)}">Install packages ${m.dir === "." ? "" : `(${esc(m.dir)})`} · ${esc(m.files[0])}</button>`)
                  .join("")
              : ""
          }
          ${st.exists ? `<button class="btn danger" data-action="env-remove">Delete env</button>` : ""}
        </div>`;
  return `<div class="two-col">
    <div class="card">
      <div class="card-head"><h3>Env config</h3></div>
      <form class="card-body" id="env-form">
        <div class="form">
          <label class="field"><span>Type</span>
            <select name="type">
              ${[
                ["none", "None"],
                ["conda", "conda"],
                ["venv", "venv (python -m venv)"],
                ["uv", "uv venv"],
              ]
                .map(([v, l]) => {
                  const missing = (v === "conda" || v === "uv") && S.system && !S.system.tools[v];
                  return `<option value="${v}" ${env.type === v ? "selected" : ""}>${l}${missing ? " (not installed)" : ""}</option>`;
                })
                .join("")}
            </select>
          </label>
          <label class="field"><span>Python version</span>
            <input name="python" value="${esc(env.python || "")}" placeholder="e.g. 3.12 (empty = default)" />
          </label>
          <label class="field full" data-env-show="conda"><span>Conda env name</span>
            <input name="name" list="conda-envs" value="${esc(env.name || "")}" placeholder=".env-${esc(p.id)}" />
            <datalist id="conda-envs">${S.condaEnvs.map((e) => `<option value="${esc(e.name)}">${esc(e.prefix)}</option>`).join("")}</datalist>
            <small>Pick an existing env, or type a new name and click Create env.</small>
          </label>
          <label class="field full" data-env-show="venv uv"><span>Venv folder (relative to project)</span>
            <input name="path" value="${esc(env.path || ".venv")}" placeholder=".venv" />
          </label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save</button></div>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h3>Status</h3><div class="btn-group"><button class="btn sm ghost" data-action="refresh-info">Refresh</button></div></div>
      <div class="card-body">${statusBox}
        <div class="notice" style="margin-top:14px">Every project command runs with the env's <code>bin/</code> first on PATH, so <code>python</code>, <code>pip</code>, <code>uvicorn</code>… come from this env. No <code>activate</code> needed. New terminals opened inside the project folder (bash or zsh) activate it automatically.</div>
      </div>
    </div>
  </div>
  ${logCard(p, [[TASK, "Task"]], false)}`;
}

// ----- Tab Thư viện -----
function packagesTab(p) {
  if (!S.info) return `<div class="empty"><span class="spinner"></span></div>`;
  const ms = S.info.manifests;
  if (!ms.length)
    return `<div class="card empty">No <code>requirements.txt</code>, <code>pyproject.toml</code> or <code>package.json</code> found (project root and first-level subfolders). For Python, set up a venv in the <a href="#/p/${esc(p.id)}/env">Env</a> tab.</div>`;
  const m = ms.find((x) => x.id === S.pkg.manifest) || ms[0];
  const isPy = m.kind === "python";
  const hasReq = m.files.includes("requirements.txt");
  return `<div class="card" style="margin-bottom:16px">
      <div class="card-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="manifest-select" style="min-width:260px">
          ${ms.map((x) => `<option value="${esc(x.id)}" ${x.id === m.id ? "selected" : ""}>${x.kind === "python" ? "Python" : "Node"} · ${esc(x.manager)} · ${x.dir === "." ? "project root" : esc(x.dir) + "/"}${x.files.length ? ` (${esc(x.files.join(", "))})` : ""}</option>`).join("")}
        </select>
        <div class="btn-group" style="margin-left:auto">
          <button class="btn sm" data-action="pkg-refresh">Refresh</button>
          <button class="btn sm" data-action="pkg-outdated">Check outdated</button>
          ${m.files.length ? `<button class="btn sm primary" data-action="pkg-install-all" data-manifest="${esc(m.id)}">Install all (${isPy ? esc(m.files[0]) : `${esc(m.manager)} install`})</button>` : ""}
        </div>
      </div>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="card-head"><h3>Installed</h3>
          <div class="btn-group">
            ${isPy ? `<label class="check"><input type="checkbox" id="pkg-direct" ${S.pkg.directOnly ? "checked" : ""}/> Direct dependencies only</label>` : ""}
            <input id="pkg-filter" placeholder="Filter…" value="${esc(S.pkg.filter)}" style="width:150px;height:30px" />
          </div>
        </div>
        <div class="pkg-scroll" id="pkg-table">${pkgTable(m)}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Search package</h3><span class="chip blue">${isPy ? "PyPI" : "npm"}</span></div>
        <div class="card-body" style="padding-bottom:10px">
          <form id="pkg-search" style="display:flex;gap:8px">
            <input name="q" id="pkg-q" placeholder="${isPy ? "vd: requests, fastapi==0.115.0" : "vd: axios, react-router@7"}" style="flex:1" autocomplete="off" />
            <button class="btn" type="submit">Search</button>
            <button class="btn primary" type="button" data-action="pkg-add-typed" title="Install exactly the name/version typed">Install</button>
          </form>
          <div class="checks" style="margin-top:10px">
            ${isPy ? `<label class="check"><input type="checkbox" id="pkg-save-req" ${hasReq ? "checked" : ""}/> Save to requirements.txt</label>` : `<label class="check"><input type="checkbox" id="pkg-dev"/> devDependency</label>`}
          </div>
        </div>
        <div class="results" id="pkg-results">${searchResults(m)}</div>
      </div>
    </div>
    ${logCard(p, [[TASK, "Task"]], false)}`;
}

function pkgTable(m) {
  if (S.pkg.error) return `<div class="card-body"><div class="notice danger">${esc(S.pkg.error)}</div></div>`;
  if (!S.pkg.rows) return `<div class="empty"><span class="spinner"></span> Loading packages…</div>`;
  const isPy = m.kind === "python";
  const q = S.pkg.filter.toLowerCase();
  const hasDirect = S.pkg.rows.some((r) => r.direct);
  let rows = S.pkg.rows.filter((r) => !q || r.name.toLowerCase().includes(q));
  if (isPy && S.pkg.directOnly && hasDirect) rows = rows.filter((r) => r.direct);
  const out = S.pkg.outdated || {};
  if (!rows.length) return `<div class="empty">No packages${q ? " match the filter" : ""}.</div>`;
  return `<table><thead><tr><th>Package</th><th>Version</th><th>Latest</th><th></th></tr></thead><tbody>${rows
    .map((r) => {
      const latest = out[r.name];
      return `<tr>
        <td><span class="mono">${esc(r.name)}</span> ${r.dev ? `<span class="chip outline">dev</span>` : ""}${isPy && r.direct && !S.pkg.directOnly ? ` <span class="chip blue">direct</span>` : ""}</td>
        <td class="mono">${r.version ? esc(r.version) : `<span class="chip amber">not installed</span>`}${r.wanted ? `<div class="sub">${esc(r.wanted)}</div>` : ""}</td>
        <td class="mono">${S.pkg.outdated ? (latest ? `<span class="chip amber">${esc(latest)}</span>` : `<span class="faint">✓</span>`) : `<span class="faint">—</span>`}</td>
        <td class="actions">
          ${latest ? `<button class="btn sm" data-action="pkg-op" data-op="upgrade" data-name="${esc(r.name)}" data-dev="${r.dev ? 1 : ""}" title="Upgrade to ${esc(latest)}">↑</button>` : ""}
          <button class="btn sm danger" data-action="pkg-op" data-op="remove" data-name="${esc(r.name)}">Uninstall</button>
        </td></tr>`;
    })
    .join("")}</tbody></table>`;
}

function searchResults() {
  if (S.pkg.searching) return `<div class="empty"><span class="spinner"></span> Searching… (the first PyPI search downloads the package name index, which takes a few seconds)</div>`;
  if (!S.pkg.results) return `<div class="empty faint">Type a package name to search.</div>`;
  if (!S.pkg.results.length) return `<div class="empty">No results.</div>`;
  const installed = new Set((S.pkg.rows || []).map((r) => r.name.toLowerCase()));
  return S.pkg.results
    .map(
      (r) => `<div class="result">
        <div class="r-main">
          <div><span class="r-name">${esc(r.name)}</span> <span class="chip outline mono">${esc(r.version)}</span>
            ${r.downloads != null ? `<span class="faint" style="font-size:12px">${r.downloads.toLocaleString("en-US")}/week</span>` : ""}
            ${installed.has(r.name.toLowerCase()) ? `<span class="chip green">installed</span>` : ""}</div>
          <div class="r-desc">${esc(r.description)}</div>
          <a href="${esc(r.homepage)}" target="_blank" rel="noopener" style="font-size:12px">${esc(r.homepage)}</a>
        </div>
        <button class="btn sm primary" data-action="pkg-op" data-op="add" data-name="${esc(r.name)}">+ Install</button>
      </div>`
    )
    .join("");
}

async function loadPackages(withOutdated = false) {
  const p = project();
  const manifest = S.pkg.manifest;
  if (!p || !manifest) return;
  S.pkg.error = "";
  S.pkg.rows = null;
  if (!withOutdated) S.pkg.outdated = null;
  repaintPkgTable();
  try {
    S.pkg.rows = await api("GET", `/api/projects/${p.id}/packages?manifest=${encodeURIComponent(manifest)}`);
    if (withOutdated) S.pkg.outdated = await api("GET", `/api/projects/${p.id}/packages/outdated?manifest=${encodeURIComponent(manifest)}`);
  } catch (e) {
    S.pkg.error = e.message;
  }
  if (manifest === S.pkg.manifest) repaintPkgTable();
}

function repaintPkgTable() {
  const el = $("#pkg-table");
  const m = S.info?.manifests.find((x) => x.id === S.pkg.manifest);
  if (el && m) el.innerHTML = pkgTable(m);
}

// ----- Tab Cấu hình -----
function settingsTab(p) {
  const vars = Object.entries(p.envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return `<div class="card">
      <div class="card-head"><h3>Project info</h3></div>
      <form class="card-body" id="project-form">
        <div class="form">
          <label class="field"><span>Name</span><input name="name" value="${esc(p.name)}" required /></label>
          <label class="field"><span>Path</span><input name="path" value="${esc(p.path)}" required class="mono" title="Local absolute path, or ssh://<SSH profile id>/absolute/path" /></label>
          <label class="field full"><span>Description</span><input name="description" value="${esc(p.description)}" /></label>
          <label class="field"><span>Tags</span><input name="tags" value="${esc(p.tags.join(", "))}" placeholder="flask, docker" /><small>Comma-separated</small></label>
          <label class="field"><span>URL</span><input name="url" value="${esc(p.url)}" placeholder="http://localhost:5000" /></label>
          <label class="field full"><span>Environment variables</span>
            <textarea name="envVars" rows="5" placeholder="KEY=value (one per line)">${esc(vars)}</textarea>
            <small>Added to the environment of every command in this project. The project's own .env file is still read by the app itself.</small>
          </label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Save</button></div>
      </form>
    </div>
    <div class="card section">
      <div class="card-head"><h3 style="color:var(--red)">Delete project</h3></div>
      <div class="card-body" style="display:flex;align-items:center;gap:12px">
        <span class="muted">Removes it from Dash only. Files in the project folder are not touched.</span>
        <button class="btn danger" style="margin-left:auto" data-action="project-delete">Remove from Dash</button>
      </div>
    </div>`;
}

function parseEnvVars(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

// ---------- vá trạng thái sau mỗi lần poll ----------
function patchStatus() {
  window.W?.paintWorkspaceTabs?.();
  renderSidebar();
  const p = project();
  // phần trên và lưới dự án không có ô nhập: vẽ lại để số liệu luôn mới
  const top = $("#overview-top");
  if (top && S.config) {
    // vẽ lại sẽ đưa bảng đang chạy về đầu khi đang cuộn ngang: giữ vị trí cuộn
    const x = top.querySelector(".table-wrap")?.scrollLeft || 0;
    top.innerHTML = overviewTop();
    const wrap = top.querySelector(".table-wrap");
    if (wrap) wrap.scrollLeft = x;
  }
  if (!p) {
    const detail = $("#detail");
    if (detail && S.config) detail.innerHTML = projectsGrid();
    return;
  }
  for (const el of $$("[data-dot]")) {
    const r = runOf(el.dataset.dot);
    el.className = `dot ${r?.running ? "on" : r?.exitCode && !r.signal ? "err" : ""}`;
  }
  for (const el of $$("[data-stats]")) el.innerHTML = statsHTML(el.dataset.stats);
  for (const el of $$("[data-btns]")) {
    const [, cid] = el.dataset.btns.split("/");
    const c = p.commands.find((x) => x.id === cid);
    if (c) el.innerHTML = buttonsHTML(p, c);
  }
  for (const el of $$("[data-port-chip]")) {
    const c = p.commands.find((x) => x.port === Number(el.dataset.portChip));
    el.innerHTML = portChip(Number(el.dataset.portChip), c?.url);
  }
  const taskBtn = $("[data-task-stop]");
  if (taskBtn) taskBtn.classList.toggle("hidden", !isRunning(keyOf(p.id, TASK)));
}

async function poll() {
  try {
    S.status = await api("GET", "/api/status");
    patchStatus();
    for (const w of [...S.waiters]) {
      const r = runOf(w.key);
      if (r && !r.running && r.startedAt >= w.after) {
        S.waiters.splice(S.waiters.indexOf(w), 1);
        w.cb(r);
      }
    }
  } catch {}
  // Tab dự án đang ẩn thì hỏi thưa hơn
  setTimeout(poll, window.__dashHidden ? 10000 : 2000);
}

function afterRender() {
  patchStatus();
  mountLog();
  const envForm = $("#env-form");
  if (envForm) {
    const sync = () => {
      const type = envForm.type.value;
      for (const el of $$("[data-env-show]", envForm)) el.classList.toggle("hidden", !el.dataset.envShow.split(" ").includes(type));
      envForm.python.closest(".field").classList.toggle("hidden", type === "none");
    };
    envForm.type.onchange = sync;
    sync();
  }
  if (S.tab === "packages" && S.info && S.pkg.manifest && !S.pkg.rows && !S.pkg.error) loadPackages();
}

// ---------- actions ----------
async function cmdAction(action, pid, cid) {
  const verb = { start: "Started", stop: "Stopped", restart: "Restarted" }[action];
  if (S.sel === pid) {
    S.logKey = keyOf(pid, cid);
    if (S.tab === "commands") {
      $$(".cmd").forEach((el) => el.classList.toggle("selected", el.dataset.cmdRow === S.logKey));
      $$(".log-tab").forEach((el) => el.classList.toggle("active", el.dataset.key === S.logKey));
      mountLog();
    }
  }
  const c = project(pid)?.commands.find((x) => x.id === cid);
  if (action === "stop" && c?.stopCmd) toast(`Running stop command: ${c.stopCmd}`);
  await guarded(() => api("POST", `/api/projects/${pid}/commands/${cid}/${action}`), `${verb}: ${c?.name || cid}`);
  S.status = await api("GET", "/api/status").catch(() => S.status);
  patchStatus();
}

async function saveProject(p, patch, msg = "Saved") {
  const updated = await guarded(() => api("PUT", `/api/projects/${p.id}`, { ...p, ...patch }), msg);
  if (!updated) return null;
  await loadConfig();
  if (typeof W !== "undefined") W.emit("config");
  return updated;
}

async function startProjectTask(url, body, after) {
  const p = project();
  const r = await guarded(() => api("POST", url, body));
  if (!r) return;
  S.logKey = r.key;
  mountLog();
  toast("Task started, see the log below");
  whenTaskDone(r.key, (run) => {
    toast(run?.exitCode === 0 ? "Task finished" : `Task failed, exit code ${run?.exitCode ?? "?"}`, run?.exitCode === 0 ? "ok" : "error");
    if (S.sel === p.id) after?.();
  });
  setTimeout(() => $("#log")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
}

async function pkgOp(op, name, dev) {
  const p = project();
  if (op === "remove" && !(await confirmDialog(`Uninstall ${name}?`, { title: "Uninstall package", ok: "Uninstall", danger: true }))) return;
  const body = {
    manifest: S.pkg.manifest,
    action: op,
    spec: name,
    dev: dev ?? $("#pkg-dev")?.checked,
    saveRequirements: $("#pkg-save-req")?.checked ?? false,
  };
  await startProjectTask(`/api/projects/${p.id}/packages`, body, () => {
    loadPackages(Boolean(S.pkg.outdated));
    const res = $("#pkg-results");
    if (res) res.innerHTML = searchResults();
  });
}

const actions = {
  // Trong tab dự án, "Overview" chuyển về tab Overview chung
  home: () => (window.W?.shell && W.wsId !== "main" ? W.shell.activate("main") : go(null)),
  // Mỗi dự án mở trong cửa sổ riêng; dự án của chính cửa sổ này thì mở chi tiết tại chỗ
  "open-project": (el) => (el.dataset.id === W.wsId ? go(el.dataset.id) : W.openWorkspace(el.dataset.id)),
  tab: (el) => go(S.sel, el.dataset.tab),
  "cmd-start": (el) => cmdAction("start", el.dataset.pid, el.dataset.cid),
  "cmd-stop": (el) => cmdAction("stop", el.dataset.pid, el.dataset.cid),
  "cmd-restart": (el) => cmdAction("restart", el.dataset.pid, el.dataset.cid),
  "stop-all": async () => {
    if (await confirmDialog("Stop all running processes?", { title: "Stop all", ok: "Stop all", danger: true })) await guarded(() => api("POST", "/api/stop-all"), "Stopped all");
  },
  "task-stop": (el) => guarded(() => api("POST", `/api/projects/${el.dataset.pid}/task/stop`), "Task stopped"),
  "show-log": (el) => {
    S.logKey = el.dataset.key;
    $$(".log-tab").forEach((t) => t.classList.toggle("active", t.dataset.key === S.logKey));
    $$(".cmd").forEach((r) => r.classList.toggle("selected", r.dataset.cmdRow === S.logKey));
    const dl = $("[data-log-download]");
    if (dl) dl.href = `/api/logs/download?key=${encodeURIComponent(S.logKey)}`;
    mountLog();
    patchStatus();
  },
  "log-wrap": () => {
    store.set("logWrap", !store.get("logWrap", false));
    renderMain();
  },
  "log-tall": () => {
    store.set("logTall", !store.get("logTall", false));
    renderMain();
  },
  "log-clear": () => guarded(() => api("DELETE", `/api/logs?key=${encodeURIComponent(S.logKey)}`)),
  "shell-run": () => runShell(),
  "cmd-new": () => commandModal(project()),
  "cmd-edit": (el) => commandModal(project(el.dataset.pid), el.dataset.cid),
  "cmd-delete": async (el) => {
    const p = project(el.dataset.pid);
    const c = p.commands.find((x) => x.id === el.dataset.cid);
    if (isRunning(keyOf(p.id, c.id))) return toast("Stop the command before deleting it", "error");
    if (!(await confirmDialog(`Delete command "${c.name}"?`, { title: "Delete command", ok: "Delete", danger: true }))) return;
    if (await saveProject(p, { commands: p.commands.filter((x) => x.id !== c.id) }, "Command deleted")) renderMain();
  },
  "detect-commands": () => detectCommandsModal(project()),
  "cmd-move": async (el) => {
    const p = project(el.dataset.pid);
    const i = p.commands.findIndex((x) => x.id === el.dataset.cid);
    const j = i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= p.commands.length) return;
    const commands = [...p.commands];
    [commands[i], commands[j]] = [commands[j], commands[i]];
    if (await saveProject(p, { commands }, null)) renderMain();
  },
  open: (el) => guarded(() => api("POST", "/api/open", { project: S.sel, what: el.dataset.what })),
  "open-url": (el) => window.open(el.dataset.url, "_blank", "noopener"),
  copy: (el) => {
    navigator.clipboard?.writeText(el.dataset.text).then(() => toast("Path copied", "ok"));
  },
  "refresh-info": () => loadInfo(),
  "env-create": () => {
    const p = project();
    startProjectTask(`/api/projects/${p.id}/env/create`, {}, () => {
      loadInfo();
      W.emit("pyenv");
    });
  },
  "env-remove": async () => {
    const p = project();
    const target = S.info?.env?.target;
    if (!(await confirmDialog(`Delete env ${target}?\nAll packages installed in it will be lost.`, { title: "Delete env", ok: "Delete", danger: true }))) return;
    startProjectTask(`/api/projects/${p.id}/env/remove`, {}, () => {
      loadInfo();
      W.emit("pyenv");
    });
  },
  "pkg-refresh": () => loadPackages(),
  "pkg-outdated": () => {
    toast("Checking for outdated packages…");
    loadPackages(true);
  },
  "pkg-install-all": (el) => {
    const p = project();
    S.pkg.manifest = el.dataset.manifest;
    startProjectTask(`/api/projects/${p.id}/packages`, { manifest: el.dataset.manifest, action: "install" }, () => {
      loadInfo();
      if (S.tab === "packages") loadPackages();
    });
  },
  "pkg-op": (el) => pkgOp(el.dataset.op, el.dataset.name, el.dataset.dev ? true : undefined),
  "pkg-add-typed": async () => {
    const q = $("#pkg-q").value.trim();
    if (!q) return toast("Type a package name first", "error");
    if (await confirmDialog(`Install "${q}"?`, { title: "Install package", ok: "Install" })) pkgOp("add", q);
  },
  "project-delete": async () => {
    const p = project();
    if (!(await confirmDialog(`Remove "${p.name}" from Dash?\nFiles on disk are not deleted.`, { title: "Remove project", ok: "Remove", danger: true }))) return;
    if (await guarded(() => api("DELETE", `/api/projects/${p.id}`), "Project removed")) {
      await loadConfig();
      go(null);
    }
  },
  "add-project": () => addProjectModal(),
  scan: () => scanModal(),
  ports: () => portsModal(),
  json: () => jsonModal(),
  settings: () => settingsModal(),
  "close-modal": () => closeModal(),
  theme: () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    store.set("theme", dark ? "dark" : "light");
    applyTheme();
  },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.tagName === "A" || el.tagName === "LI" || el.classList.contains("pcard")) {
    // thẻ dự án chứa nút: để nút xử lý trước
    if (el.classList.contains("pcard") && e.target.closest("button, a") && e.target.closest("button, a") !== el) return;
    e.preventDefault();
  }
  fn(el, e);
});

document.addEventListener("submit", async (e) => {
  const form = e.target;
  const p = project();
  if (form.id === "env-form") {
    e.preventDefault();
    const env = { type: form.type.value, name: form.name.value.trim(), path: form.path.value.trim(), python: form.python.value.trim() };
    if (await saveProject(p, { env }, "Env saved")) loadInfo();
  } else if (form.id === "project-form") {
    e.preventDefault();
    const f = new FormData(form);
    const updated = await saveProject(p, {
      name: f.get("name"),
      path: f.get("path"),
      description: f.get("description"),
      tags: f.get("tags"),
      url: f.get("url"),
      envVars: parseEnvVars(f.get("envVars")),
    });
    if (updated) {
      if (updated.id !== S.sel) go(updated.id, "settings");
      else loadInfo();
    }
  } else if (form.id === "pkg-search") {
    e.preventDefault();
    const q = form.q.value.trim();
    if (!q) return;
    const m = S.info.manifests.find((x) => x.id === S.pkg.manifest);
    S.pkg.searching = true;
    $("#pkg-results").innerHTML = searchResults();
    try {
      S.pkg.results = await api("GET", `/api/search?registry=${m.kind === "node" ? "npm" : "pypi"}&q=${encodeURIComponent(q.replace(/[=<>~!@^].*$/, "") || q)}`);
    } catch (err) {
      S.pkg.results = [];
      toast(err.message, "error");
    }
    S.pkg.searching = false;
    const res = $("#pkg-results");
    if (res) res.innerHTML = searchResults();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    S.filter = e.target.value;
    renderSidebar();
    if (!S.sel) renderMain();
  } else if (e.target.id === "pkg-filter") {
    S.pkg.filter = e.target.value;
    repaintPkgTable();
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "manifest-select") {
    S.pkg.manifest = e.target.value;
    S.pkg.rows = null;
    S.pkg.outdated = null;
    S.pkg.results = null;
    renderMain();
  } else if (e.target.id === "pkg-direct") {
    S.pkg.directOnly = e.target.checked;
    repaintPkgTable();
  }
});

// ----- lệnh nhanh + lịch sử ↑/↓ -----
let histIdx = -1;
async function runShell() {
  const input = $("#shell-cmd");
  const cmd = input.value.trim();
  if (!cmd) return;
  const p = project();
  const hist = store.get(`hist:${p.id}`, []).filter((h) => h !== cmd);
  hist.unshift(cmd);
  store.set(`hist:${p.id}`, hist.slice(0, 50));
  histIdx = -1;
  const r = await guarded(() => api("POST", `/api/projects/${p.id}/shell`, { cmd, cwd: $("#shell-cwd").value.trim() }));
  if (!r) return;
  input.value = "";
  S.logKey = r.key;
  $$(".log-tab").forEach((t) => t.classList.toggle("active", t.dataset.key === S.logKey));
  $$(".cmd").forEach((row) => row.classList.remove("selected"));
  mountLog();
}

document.addEventListener("keydown", (e) => {
  if (e.target.id === "shell-cmd") {
    const hist = store.get(`hist:${S.sel}`, []);
    if (e.key === "Enter") runShell();
    else if (e.key === "ArrowUp" && hist.length) {
      histIdx = Math.min(histIdx + 1, hist.length - 1);
      e.target.value = hist[histIdx];
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      histIdx = Math.max(histIdx - 1, -1);
      e.target.value = histIdx < 0 ? "" : hist[histIdx];
      e.preventDefault();
    }
    return;
  }
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    $("#search").focus();
  }
});

// ---------- modals ----------
const modal = () => $("#modal");

function openModal(title, body, foot = "", wide = false) {
  const m = modal();
  m.className = `modal ${wide ? "wide" : ""}`;
  m.innerHTML = `<div class="modal-head"><h2>${title}</h2><button class="btn sm ghost" data-action="close-modal">✕</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}`;
  if (!m.open) m.showModal();
  return m;
}

function closeModal() {
  modal().close();
}

modal().addEventListener("click", (e) => {
  if (e.target === modal()) closeModal();
});

function commandFields(c = {}) {
  return `<div class="form">
    <label class="field"><span>Name</span><input name="name" value="${esc(c.name || "")}" placeholder="Dev server" required /></label>
    <label class="field"><span>Working dir (cwd)</span><input name="cwd" value="${esc(c.cwd || "")}" placeholder="empty = project root" class="mono" /></label>
    <label class="field full"><span>Command</span><textarea name="cmd" rows="3" placeholder="python app.py" required>${esc(c.cmd || "")}</textarea>
      <small>Runs with bash in the project folder, with the project env on PATH. &&, |, env vars… all work.</small></label>
    <label class="field"><span>Port</span><input name="port" type="number" min="1" max="65535" value="${esc(c.port || "")}" placeholder="5000" /><small>Used to show whether the port is open</small></label>
    <label class="field"><span>URL</span><input name="url" value="${esc(c.url || "")}" placeholder="http://localhost:5000" /></label>
    <label class="field full"><span>Stop command (optional)</span><input name="stopCmd" value="${esc(c.stopCmd || "")}" placeholder="docker compose down" class="mono" />
      <small>Runs when you click Stop, before the process is killed. Useful for Docker or commands that exit right away.</small></label>
    <div class="field full checks">
      <label class="check"><input type="checkbox" name="background" ${c.background ? "checked" : ""}/> Background (keeps running when Dash exits)</label>
      <label class="check"><input type="checkbox" name="autostart" ${c.autostart ? "checked" : ""}/> Autostart when Dash starts</label>
      <label class="check"><input type="checkbox" name="autoRestart" ${c.autoRestart ? "checked" : ""}/> Auto-restart on failure</label>
    </div>
  </div>`;
}

function readCommandForm(form) {
  const f = new FormData(form);
  return {
    name: f.get("name"),
    cmd: f.get("cmd"),
    cwd: f.get("cwd"),
    port: f.get("port"),
    url: f.get("url"),
    stopCmd: f.get("stopCmd"),
    background: f.get("background") === "on",
    autostart: f.get("autostart") === "on",
    autoRestart: f.get("autoRestart") === "on",
  };
}

function commandModal(p, cid) {
  const c = cid ? p.commands.find((x) => x.id === cid) : { background: true };
  const m = openModal(cid ? `Edit command · ${esc(c.name)}` : "Add command", `<form id="cmd-form">${commandFields(c)}</form>`, `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="cmd-form">Save</button>`);
  $("#cmd-form", m).onsubmit = async (e) => {
    e.preventDefault();
    const data = readCommandForm(e.target);
    const commands = cid ? p.commands.map((x) => (x.id === cid ? { ...x, ...data } : x)) : [...p.commands, data];
    if (await saveProject(p, { commands }, cid ? "Command saved" : "Command added")) {
      closeModal();
      renderMain();
    }
  };
}

function suggestionList(cmds, existing = []) {
  if (!cmds.length) return `<div class="notice warn">No commands detected. You can add them manually.</div>`;
  const have = new Set(existing.map((c) => `${c.cwd}|${c.cmd}`));
  return `<div class="suggest">${cmds
    .map((c, i) => {
      const dup = have.has(`${c.cwd || ""}|${c.cmd}`);
      return `<label><input type="checkbox" name="s${i}" ${dup ? "disabled" : "checked"} />
        <div><b>${esc(c.name)}</b> ${c.background ? `<span class="chip violet">background</span>` : ""} ${c.port ? `<span class="chip outline">:${c.port}</span>` : ""} ${dup ? `<span class="chip">exists</span>` : ""}
        <div><code>${c.cwd ? `[${esc(c.cwd)}] ` : ""}${esc(c.cmd)}</code>${c.stopCmd ? ` <span class="faint">· stop: ${esc(c.stopCmd)}</span>` : ""}</div></div></label>`;
    })
    .join("")}</div>`;
}

async function detectCommandsModal(p) {
  openModal("Auto-detect commands", `<div class="empty"><span class="spinner"></span> Detecting…</div>`);
  const d = await guarded(() => api("POST", "/api/detect", { path: p.path }));
  if (!d) return closeModal();
  const m = openModal(
    "Auto-detect commands",
    `<p class="muted" style="margin-top:0">Detected: ${d.frameworks.map((f) => `<span class="chip blue">${esc(f)}</span>`).join(" ") || "unknown"}</p>
     <form id="suggest-form">${suggestionList(d.commands, p.commands)}</form>`,
    `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="suggest-form">Add selected commands</button>`
  );
  $("#suggest-form", m).onsubmit = async (e) => {
    e.preventDefault();
    const picked = d.commands.filter((_, i) => e.target[`s${i}`]?.checked);
    if (!picked.length) return closeModal();
    if (await saveProject(p, { commands: [...p.commands, ...picked] }, `Added ${picked.length} command(s)`)) {
      closeModal();
      renderMain();
    }
  };
}

function addProjectModal(prefillPath) {
  const root = S.config.settings.projectsRoot || "";
  const ssh = S.config.ssh || [];
  const m = openModal(
    "Add project",
    `<form id="detect-form" class="detect-form">
        <select name="where" title="Where the project lives">
          <option value="">This machine</option>
          ${ssh.map((p) => `<option value="${esc(p.id)}">SSH · ${esc(p.label)} (${esc(p.user ? `${p.user}@` : "")}${esc(p.host)})</option>`).join("")}
        </select>
        <input name="path" class="mono" style="flex:1" value="${esc(prefillPath || root + "/")}" placeholder="/path/to/project" required />
        <button class="btn primary" type="submit">Detect</button>
      </form>
      <p class="muted detect-help" style="font-size:12.5px">Enter an absolute path and click <b>Detect</b>. Dash guesses the framework (Flask, FastAPI, Django, React/Vite, Next.js, Docker…), the env and the run commands.</p>
      <div id="detect-result"></div>`,
    "",
    true
  );
  const form = $("#detect-form", m);
  // Gợi ý thư mục con theo đường dẫn đang gõ (trên máy này hoặc máy SSH đang chọn); thư mục đã là dự án có ghi chú
  let dirs = W.dirSuggester();
  const suggest = W.attachSuggest(form.path, async (text) =>
    (await dirs(text)).map((d) => ({ label: d.name, hl: d.hl, value: `${d.typed}/`, icon: W.folderIcon(d.name) || W.ICON.files, badge: d.project ? "project" : "", detail: d.project ? `Already added: ${d.project}` : "" }))
  );
  form.where.onchange = () => {
    const prof = ssh.find((p) => p.id === form.where.value);
    form.path.value = prof ? prof.remoteDir || "/home/" + (prof.user || "") : root + "/";
    dirs = W.dirSuggester({ remote: form.where.value });
    form.path.focus();
    suggest.refresh();
    $(".detect-help", m).innerHTML = prof
      ? `Project on <b>${esc(prof.label)}</b>: enter the absolute path on that machine. Commands run there over SSH (key or ssh-agent login), and Files opens the remote folder.`
      : `Enter an absolute path and click <b>Detect</b>. Dash guesses the framework, the env and the run commands.`;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const box = $("#detect-result", m);
    box.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    // gợi ý chèn "/" cuối để gõ tiếp; "~" chỉ có nghĩa trên máy này
    const typed = form.path.value.trim().replace(/(.)\/+$/, "$1");
    if (form.where.value) return remoteProjectForm(m, box, form.where.value, typed);
    const local = typed === "~" || typed.startsWith("~/") ? W.home + typed.slice(1) : typed;
    const d = await guarded(() => api("POST", "/api/detect", { path: local }));
    if (!d) return (box.innerHTML = "");
    box.innerHTML = `<form id="new-project-form">
      <div class="form">
        <label class="field"><span>Name</span><input name="name" value="${esc(d.name)}" required /></label>
        <label class="field"><span>Tags</span><input name="tags" value="${esc(d.tags.join(", "))}" /></label>
        <label class="field"><span>URL</span><input name="url" value="${esc(d.url || "")}" /></label>
        <label class="field"><span>Env</span>
          <select name="envType">${["none", "conda", "venv", "uv"].map((t) => `<option ${d.env.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
        </label>
        <label class="field"><span>Conda name / venv folder</span><input name="envTarget" value="${esc(d.env.name || d.env.path || "")}" class="mono" /></label>
        <label class="field full"><span>Description</span><input name="description" /></label>
      </div>
      <h3 style="font-size:13.5px;margin:16px 0 4px">Suggested commands ${d.frameworks.map((f) => `<span class="chip blue">${esc(f)}</span>`).join(" ")}</h3>
      ${suggestionList(d.commands)}
    </form>`;
    m.querySelector(".modal-foot")?.remove();
    m.insertAdjacentHTML("beforeend", `<div class="modal-foot"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="new-project-form">Add project</button></div>`);
    $("#new-project-form", m).onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const type = f.envType.value;
      const target = f.envTarget.value.trim();
      const env = type === "conda" ? { type, name: target } : type === "none" ? { type } : { type, path: target || ".venv" };
      const body = {
        name: f.name.value,
        path: d.path,
        tags: f.tags.value,
        url: f.url.value,
        description: f.description.value,
        env,
        commands: d.commands.filter((_, i) => f[`s${i}`]?.checked),
      };
      const created = await guarded(() => api("POST", "/api/projects", body), "Project added");
      if (!created) return;
      await loadConfig();
      closeModal();
      go(created.id);
    };
  };
  if (prefillPath) form.requestSubmit();
}

// Dự án trên máy SSH: kiểm tra thư mục có tồn tại (qua ssh) rồi điền tên, tag, mô tả; lệnh thêm sau.
async function remoteProjectForm(m, box, profileId, dir) {
  if (!dir.startsWith("/")) {
    box.innerHTML = "";
    return toast("Enter an absolute path on the remote machine", "error");
  }
  const target = `ssh://${profileId}${dir}`;
  const listing = await guarded(() => api("GET", `/api/files/list?path=${encodeURIComponent(target)}`));
  if (!listing) return (box.innerHTML = "");
  const files = listing.items.map((it) => it.name);
  box.innerHTML = `<form id="new-project-form"><div class="form">
      <label class="field"><span>Name</span><input name="name" value="${esc(W.base(dir))}" required /></label>
      <label class="field"><span>Tags</span><input name="tags" value="ssh" /></label>
      <label class="field full"><span>Description</span><input name="description" /></label>
    </div>
    <p class="muted" style="font-size:12.5px">${listing.items.length} item(s) found: <span class="mono">${esc(files.slice(0, 12).join("  "))}${files.length > 12 ? " …" : ""}</span></p></form>`;
  m.querySelector(".modal-foot")?.remove();
  m.insertAdjacentHTML("beforeend", `<div class="modal-foot"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="new-project-form">Add project</button></div>`);
  $("#new-project-form", m).onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const created = await guarded(() => api("POST", "/api/projects", { name: f.name.value, path: target, tags: f.tags.value, description: f.description.value, commands: [] }), "Project added");
    if (!created) return;
    await loadConfig();
    closeModal();
    go(created.id);
  };
}

async function scanModal() {
  const root = S.config.settings.projectsRoot || "";
  const m = openModal(
    "Scan for projects",
    `<form id="scan-form" style="display:flex;gap:8px;margin-bottom:12px"><input name="root" class="mono" style="flex:1" value="${esc(root)}" /><button class="btn primary">Scan</button></form><div id="scan-result"></div>`,
    "",
    true
  );
  const form = $("#scan-form", m);
  form.onsubmit = async (e) => {
    e?.preventDefault();
    const box = $("#scan-result", m);
    box.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    const list = await guarded(() => api("GET", `/api/scan?root=${encodeURIComponent(form.root.value.trim())}`));
    if (!list) return (box.innerHTML = "");
    box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Folder</th><th>Detected</th><th>Commands</th><th></th></tr></thead><tbody>${list
      .map(
        (d) => `<tr><td><b>${esc(d.name)}</b><div class="sub mono">${esc(d.path)}</div></td>
        <td>${d.frameworks.map((f) => `<span class="chip blue">${esc(f)}</span>`).join(" ") || `<span class="faint">—</span>`}</td>
        <td>${d.commands}</td>
        <td class="actions">${d.added ? `<span class="chip green">added</span>` : `<button class="btn sm primary" data-scan-add="${esc(d.path)}">+ Add</button>`}</td></tr>`
      )
      .join("")}</tbody></table></div>`;
    for (const b of $$("[data-scan-add]", box)) b.onclick = () => addProjectModal(b.dataset.scanAdd);
  };
  form.onsubmit();
}

async function portsModal() {
  const m = openModal("Listening ports", `<div class="empty"><span class="spinner"></span></div>`, `<button class="btn" data-action="ports">Refresh</button>`, true);
  const ports = await guarded(() => api("GET", "/api/ports"));
  if (!ports) return;
  const owner = (cwd) => S.config.projects.find((p) => cwd && (cwd === p.path || cwd.startsWith(p.path + "/")));
  const configured = new Map(S.config.projects.flatMap((p) => p.commands.filter((c) => c.port).map((c) => [c.port, `${p.name} · ${c.name}`])));
  $(".modal-body", m).innerHTML = `<p class="muted" style="margin-top:0;font-size:12.5px">Processes owned by other users or root (e.g. Docker) show no PID and cannot be killed from here.</p>
  <div class="table-wrap"><table><thead><tr><th>Port</th><th>Address</th><th>Process</th><th>Project</th><th></th></tr></thead><tbody>${ports
    .map((p) => {
      const proj = owner(p.cwd);
      return `<tr>
        <td><a class="mono" href="http://localhost:${p.port}" target="_blank" rel="noopener"><b>${p.port}</b></a></td>
        <td class="mono">${esc(p.address)}</td>
        <td>${p.pid ? `<span class="mono">${esc(p.process)}</span> <span class="faint">PID ${p.pid}</span><div class="sub mono" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.cmdline)}">${esc(p.cmdline || "")}</div>` : `<span class="faint">—</span>`}</td>
        <td>${p.self ? `<span class="chip blue">Dash</span>` : proj ? `<a href="#/p/${esc(proj.id)}">${esc(proj.name)}</a>` : configured.has(p.port) ? `<span class="faint">${esc(configured.get(p.port))}?</span>` : ""}</td>
        <td class="actions">${p.pid && !p.self ? `<button class="btn sm danger" data-kill="${p.pid}">Stop</button><button class="btn sm danger" data-kill="${p.pid}" data-force="1" title="SIGKILL">Kill -9</button>` : ""}</td>
      </tr>`;
    })
    .join("")}</tbody></table></div>`;
  for (const b of $$("[data-kill]", m)) {
    b.onclick = async () => {
      if (!(await confirmDialog(`${b.dataset.force ? "Kill -9" : "Stop"} process PID ${b.dataset.kill}?`, { title: "Stop process", ok: b.dataset.force ? "Kill -9" : "Stop", danger: true }))) return;
      if (await guarded(() => api("POST", "/api/kill", { pid: Number(b.dataset.kill), force: Boolean(b.dataset.force) }), "Signal sent")) setTimeout(portsModal, 600);
    };
  }
}

async function settingsModal() {
  await loadConfig();
  S.system = await api("GET", "/api/system").catch(() => S.system);
  const st = S.config.settings;
  const sys = S.system || { tools: {}, listening: {} };
  const restart = sys.listening && (sys.listening.host !== st.host || sys.listening.port !== st.port);
  const m = openModal(
    "Projects & server",
    `<form id="settings-form">
      <h3 class="form-title">Projects</h3>
      <div class="form">
        <label class="field full"><span>Projects folder</span>
          <input name="projectsRoot" class="mono" value="${esc(st.projectsRoot)}" placeholder="/home/me/Projects" />
          <small>Default folder for Scan and Add project.</small></label>
        <label class="field full"><span>Python used to create venvs</span>
          <input name="python" class="mono" value="${esc(st.python)}" placeholder="python3" />
          <small>Interpreter command or path. If an env sets a version (e.g. 3.12), <code>python3.12</code> is used instead.</small></label>
      </div>
      <h3 class="form-title">Server</h3>
      <div class="form">
        <label class="field"><span>Host</span>
          <select name="host">
            ${[
              ["127.0.0.1", "127.0.0.1 (this machine only)"],
              ["0.0.0.0", "0.0.0.0 (whole network, not recommended)"],
            ]
              .concat([["127.0.0.1", "0.0.0.0"].includes(st.host) ? [] : [[st.host, st.host]]])
              .map(([v, l]) => `<option value="${esc(v)}" ${st.host === v ? "selected" : ""}>${esc(l)}</option>`)
              .join("")}
          </select></label>
        <label class="field"><span>Port</span><input name="port" type="number" min="1" max="65535" value="${esc(st.port)}" required /></label>
        <div class="field full">
          <div class="notice ${restart ? "warn" : ""}">${
            restart
              ? `Dash is running on <code>${esc(sys.listening.host)}:${esc(sys.listening.port)}</code>. Restart Dash to use the new host/port.`
              : `Changing host/port requires a Dash restart. Dash can run arbitrary commands, so only expose it to the network if you really need to.`
          }</div>
        </div>
      </div>
      <h3 class="form-title">Installed tools</h3>
      <div class="tags">${Object.entries(sys.tools)
        .map(([t, ok]) => `<span class="chip ${ok ? "green" : "outline"}">${ok ? "✓" : "✕"} ${esc(t)}</span>`)
        .join("")}</div>
      <p class="muted" style="font-size:12.5px;margin-bottom:0">Config is saved to <code>${esc(sys.configPath || "projects.json")}</code>.</p>
    </form>`,
    `<button class="btn ghost" data-action="json" style="margin-right:auto">Edit JSON (advanced)</button>
     <button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="settings-form">Save</button>`
  );
  $("#settings-form", m).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const f = Object.fromEntries(fd);
    const saved = await guarded(() => api("PUT", "/api/settings", { ...f, port: Number(f.port) }), "Settings saved");
    if (!saved) return;
    await loadConfig();
    const moved = saved.host !== sys.listening?.host || saved.port !== sys.listening?.port;
    if (moved) toast(`Restart Dash to run on ${saved.host}:${saved.port}`, "info", 6000);
    closeModal();
  };
}

async function jsonModal() {
  await loadConfig();
  const m = openModal(
    "JSON config · projects.json",
    `<textarea id="json-text" rows="28" style="width:100%" spellcheck="false">${esc(JSON.stringify(S.config, null, 2))}</textarea>
     <p class="muted" style="font-size:12.5px;margin-bottom:0">Edit the whole config (settings + projects) directly. It is validated and normalized on save.</p>`,
    `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" id="json-save">Save</button>`,
    true
  );
  $("#json-save", m).onclick = async () => {
    let data;
    try {
      data = JSON.parse($("#json-text", m).value);
    } catch (e) {
      return toast(`Invalid JSON: ${e.message}`, "error");
    }
    if (await guarded(() => api("PUT", "/api/config", data), "Config saved")) {
      await loadConfig();
      closeModal();
      readHash();
    }
  };
}

function applyTheme() {
  const dark = store.get("theme", "dark") === "dark";
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  const btn = $("#theme-toggle");
  if (btn) {
    btn.textContent = dark ? "☀" : "☾";
    btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  }
  document.dispatchEvent(new CustomEvent("dash:theme", { detail: { dark } }));
}

// ---------- khởi động ----------
(async function init() {
  applyTheme();
  render();
  try {
    await loadConfig();
  } catch (e) {
    toast(`Could not load config: ${e.message}`, "error");
  }
  S.status = await api("GET", "/api/status").catch(() => S.status);
  api("GET", "/api/system")
    .then((sys) => (S.system = sys))
    .catch(() => {});
  api("GET", "/api/conda-envs")
    .then((envs) => (S.condaEnvs = envs))
    .catch(() => {});
  window.addEventListener("hashchange", readHash);
  // Đổi theme ở một tab dự án thì các tab khác đổi theo
  window.addEventListener("storage", (e) => e.key === "dash:theme" && applyTheme());
  readHash();
  poll();
  setInterval(() => {
    // cập nhật thời gian "chạy …" giữa các lần poll
    for (const el of $$("[data-stats]")) el.innerHTML = statsHTML(el.dataset.stats);
  }, 1000);
})();
