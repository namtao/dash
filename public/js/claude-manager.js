"use strict";
// Claude Manager (tab editor): quản lý toàn bộ Claude Code trên máy.
// Lịch sử chat của mọi thư mục (xem, mở lại, đổi tên, xoá), prompt đã gõ, skills, agents, lệnh /, output style,
// CLAUDE.md và memory, rules, hooks, quyền, MCP server, plugin và marketplace, các file settings.json.
// Phạm vi "project" theo thư mục hiện tại của cửa sổ (W.folder); thư mục SSH chỉ có phạm vi user.
(() => {
  const SECTIONS = [
    ["sessions", "Conversations"],
    ["prompts", "Prompt history"],
    ["skills", "Skills"],
    ["agents", "Agents"],
    ["commands", "Slash commands"],
    ["outputStyles", "Output styles"],
    ["memory", "Memory (CLAUDE.md)"],
    ["rules", "Rules"],
    ["hooks", "Hooks"],
    ["permissions", "Permissions"],
    ["mcp", "MCP servers"],
    ["plugins", "Plugins"],
    ["settings", "Settings files"],
  ];
  const ITEM_KINDS = { skills: ["skill", "skill"], agents: ["agent", "agent"], commands: ["command", "slash command"], outputStyles: ["outputStyle", "output style"], rules: ["rule", "rule"] };
  const SCOPES = [["folder", "This folder"], ["tree", "This folder + subfolders"], ["all", "All folders"]];
  const PERM_MODES = ["", "default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

  const st = { section: "sessions", q: "", cfg: null, sessions: null, scope: "folder", folderPick: "", prompts: null, promptScope: "folder", hookScope: "user", permScope: "user", plugins: null, available: null, rows: [] };
  let host = null;

  const cwd = () => (W.isRemote(W.folder) ? "" : W.folder || "");
  const enc = encodeURIComponent;
  const shq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "");
  const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`);
  const clip = (s, n) => (String(s || "").length > n ? `${String(s).slice(0, n)}…` : String(s || ""));
  const ref = (item) => st.rows.push(item) - 1;
  const matches = (text) => !st.q || text.toLowerCase().includes(st.q.toLowerCase());
  const scopeChip = (s) => `<span class="chip ${s === "user" ? "blue" : s === "project" ? "green" : s === "local" ? "amber" : "violet"}">${esc(s.startsWith("plugin:") ? s.slice(7) : s)}</span>`;
  const empty = (text) => `<div class="empty">${esc(text)}</div>`;
  const search = (ph) => `<input type="search" class="cm-search" data-cm-q placeholder="${esc(ph)}" value="${esc(st.q)}" />`;
  const select = (key, opts, val) => `<select data-cm-set="${key}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const scopeSelect = (key) => select(key, [["user", "User (~/.claude)"], ...(cwd() ? [["project", "Project (.claude/settings.json)"], ["local", "Local (.claude/settings.local.json)"]] : [])], st[key]);

  // ---------- dữ liệu ----------
  async function loadCfg() {
    st.cfg = await api("GET", `/api/claude/manage/config?cwd=${enc(cwd())}`).catch((e) => (toast(e.message, "error"), st.cfg));
  }
  async function loadSessions() {
    st.sessions = await api("GET", "/api/claude/manage/sessions?scope=all").catch((e) => (toast(e.message, "error"), []));
  }
  async function loadPrompts() {
    st.prompts = await api("GET", `/api/claude/manage/prompts?cwd=${enc(cwd())}&scope=${st.promptScope}`).catch(() => []);
  }
  async function loadPlugins() {
    st.plugins = await api("GET", `/api/claude/manage/plugins?cwd=${enc(cwd())}`).catch((e) => ({ installed: [], marketplaces: {}, error: e.message }));
  }
  async function reload() {
    if (!host) return;
    await Promise.all([loadCfg(), loadSessions(), st.section === "prompts" && loadPrompts(), st.section === "plugins" && loadPlugins()]);
    paint();
  }

  // ---------- Conversations ----------
  function scopedSessions() {
    const cur = st.cfg?.cwd ?? cwd(); // đường dẫn thật do server trả về
    return (st.sessions || []).filter((x) => st.scope === "all" || !cur || x.cwd === cur || (st.scope === "tree" && x.cwd.startsWith(cur.replace(/\/$/, "") + "/")));
  }
  const sessionsBar = () => `${select("scope", SCOPES, st.scope)}${search("Search title, first prompt, folder, branch…")}<button class="btn sm" data-cm="refresh">Refresh</button>`;
  function sessionsList() {
    if (!st.sessions) return empty("Loading…");
    const scoped = scopedSessions();
    const folders = new Map();
    for (const x of scoped) {
      const f = folders.get(x.cwd) || { cwd: x.cwd, n: 0, last: 0 };
      f.n++;
      f.last = Math.max(f.last, x.lastModified);
      folders.set(x.cwd, f);
    }
    if (st.folderPick && !folders.has(st.folderPick)) st.folderPick = "";
    const list = scoped.filter((x) => (!st.folderPick || x.cwd === st.folderPick) && matches(`${x.title} ${x.firstPrompt} ${x.cwd} ${x.gitBranch} ${x.tag} ${x.sessionId}`));
    const side =
      folders.size > 1
        ? `<div class="cm-folders"><div class="cm-folder ${st.folderPick ? "" : "active"}" data-cm="pick-folder" data-folder="">All folders <span class="faint">${scoped.length}</span></div>${[...folders.values()]
            .sort((a, b) => b.last - a.last)
            .map((f) => `<div class="cm-folder ${st.folderPick === f.cwd ? "active" : ""}" data-cm="pick-folder" data-folder="${esc(f.cwd)}" title="${esc(f.cwd)}">${esc(W.shortPath(f.cwd) || "(unknown)")} <span class="faint">${f.n}</span></div>`)
            .join("")}</div>`
        : "";
    const rows = list.slice(0, 400).map((x) => {
      const i = ref({ type: "session", ...x });
      return `<div class="cm-row" data-row="${i}" data-open>
        <div class="cm-row-main"><b>${esc(clip(x.title, 160))}</b>
          <small>${esc(W.shortPath(x.cwd))}${x.gitBranch ? ` · ⎇ ${esc(x.gitBranch)}` : ""} · ${esc(when(x.lastModified))} · ${size(x.fileSize)}${x.tag ? ` · #${esc(x.tag)}` : ""}</small></div>
        <div class="cm-row-actions"><button class="btn sm" data-cm="resume" title="Continue in the Claude panel">Resume</button><button class="icon" data-cm="session-menu" title="More">⋯</button></div></div>`;
    });
    const more = list.length > 400 ? `<div class="faint cm-note">${list.length - 400} more; narrow the search.</div>` : "";
    return `<div class="cm-split">${side}<div class="cm-rows">${rows.join("") || empty(scoped.length ? "No match." : `No Claude conversations ${st.scope === "all" ? "yet" : `in ${W.shortPath(cwd()) || "this folder"}`}.`)}${more}</div></div>`;
  }

  function sessionMenu(e, s) {
    W.menu(e, [
      { label: "Open transcript", run: () => openTranscript(s) },
      { label: "Resume in Claude panel", run: () => resume(s) },
      { label: "Continue in a terminal", run: () => inTerminal(s) },
      { sep: true },
      { label: "Rename…", run: () => renameSession(s) },
      { label: "Copy session ID", run: () => copy(s.sessionId) },
      { label: "Make its folder current", run: () => W.setFolder(s.cwd) },
      { sep: true },
      { label: "Delete…", danger: true, run: () => deleteSession(s) },
    ]);
  }
  const resume = (s) => (W.isRemote(s.cwd) ? toast("Claude runs on this machine only", "error") : W.claudeResume(s));
  async function inTerminal(s) {
    await W.term.create({ cwd: s.cwd });
    setTimeout(() => W.term.insert(`claude --resume ${shq(s.sessionId)}`, { run: true }), 700);
  }
  async function renameSession(s) {
    const title = await W.prompt("Rename conversation", s.title, { mono: false });
    if (title == null || !title.trim()) return;
    await guarded(() => api("PUT", `/api/claude/manage/sessions/${enc(s.sessionId)}`, { cwd: s.cwd, title }), "Renamed");
    await loadSessions();
    paint();
  }
  async function deleteSession(s) {
    const ok = await confirmDialog(`Delete the conversation "${clip(s.title, 80)}"? Its transcript file is removed and it can no longer be resumed.`, { title: "Delete conversation", ok: "Delete", danger: true });
    if (!ok) return;
    if ((await guarded(() => api("DELETE", `/api/claude/manage/sessions/${enc(s.sessionId)}?cwd=${enc(s.cwd)}`), "Conversation deleted")) == null) return;
    W.closeTab(`cmchat:${s.sessionId}`, { force: true });
    await loadSessions();
    paint();
  }
  const copy = (text) => navigator.clipboard.writeText(text).then(() => toast("Copied", "ok"), () => toast("Copy failed", "error"));

  // Transcript chỉ đọc, mở thành tab riêng; văn bản của Claude được vẽ Markdown dần dần sau khi hiện bản thô.
  function openTranscript(s) {
    W.openTab({
      id: `cmchat:${s.sessionId}`,
      title: clip(s.title, 28),
      icon: W.ICON.claude,
      tooltip: `${s.title}\n${s.cwd}`,
      create: (h) => {
        h.classList.add("cm-host");
        h.innerHTML = `<div class="cm-chat"><div class="cm-chat-head"><div><b>${esc(s.title)}</b><small class="faint">${esc(W.shortPath(s.cwd))}${s.gitBranch ? ` · ⎇ ${esc(s.gitBranch)}` : ""} · ${esc(when(s.lastModified))}</small></div>
          <div class="cm-chat-actions"><button class="btn sm primary" data-x="resume">Resume</button><button class="btn sm" data-x="term">Terminal</button><button class="btn sm" data-x="md">Copy as Markdown</button></div></div>
          <div class="cm-chat-body">${empty("Loading…")}</div></div>`;
        let msgs = [];
        let alive = true;
        h.addEventListener("click", (e) => {
          const a = e.target.closest("[data-x]")?.dataset.x;
          if (a === "resume") resume(s);
          if (a === "term") inTerminal(s);
          if (a === "md") copy(toMarkdown(s, msgs));
        });
        api("GET", `/api/claude/manage/sessions/${enc(s.sessionId)}?cwd=${enc(s.cwd)}`)
          .then(async (list) => {
            msgs = list;
            const body = $(".cm-chat-body", h);
            body.innerHTML = list.map(msgHtml).join("") || empty("This conversation has no messages.");
            for (const el of $$(".cm-md", body)) {
              if (!alive) return;
              await W.renderMarkdown(el, el.textContent, `${s.cwd}/x`).catch(() => {});
            }
          })
          .catch((e) => ($(".cm-chat-body", h).innerHTML = empty(e.message)));
        return { dispose: () => (alive = false) };
      },
    });
  }
  function msgHtml(m) {
    const blocks = m.blocks
      .map((b) => {
        if (b.kind === "text") return m.role === "assistant" ? `<div class="cm-md md-body">${esc(b.text)}</div>` : `<div class="cm-text">${esc(b.text)}</div>`;
        if (b.kind === "tool") return `<details class="cm-tool"><summary>⚙ ${esc(b.name)}${b.hint ? ` <span class="faint">${esc(b.hint)}</span>` : ""}</summary><pre>${esc(b.text)}</pre></details>`;
        return `<details class="cm-tool ${b.error ? "err" : ""}"><summary>${b.error ? "✕ Tool error" : "↳ Tool result"}</summary><pre>${esc(b.text)}</pre></details>`;
      })
      .join("");
    return `<div class="cm-msg ${m.role}"><div class="cm-msg-meta">${m.role === "user" ? "You" : "Claude"} <span class="faint">${esc(when(m.at))}</span></div>${blocks}</div>`;
  }
  function toMarkdown(s, msgs) {
    const out = [`# ${s.title}`, "", `Folder: ${s.cwd}  `, `Session: ${s.sessionId}`, ""];
    for (const m of msgs) {
      out.push(`## ${m.role === "user" ? "You" : "Claude"} (${when(m.at)})`, "");
      for (const b of m.blocks) out.push(b.kind === "text" ? b.text : `\`\`\`\n${b.kind === "tool" ? `${b.name} ${b.text}` : b.text}\n\`\`\``, "");
    }
    return out.join("\n");
  }

  // ---------- Prompt history ----------
  const promptsBar = () => `${select("promptScope", SCOPES, st.promptScope)}${search("Search prompts…")}<button class="btn sm" data-cm="refresh">Refresh</button>`;
  function promptsList() {
    if (!st.prompts) return empty("Loading…");
    const list = st.prompts.filter((p) => matches(`${p.text} ${p.project}`));
    return (
      list
        .map((p) => {
          const i = ref({ type: "prompt", ...p });
          return `<div class="cm-row"><div class="cm-row-main"><div class="cm-prompt">${esc(clip(p.text, 600))}</div>
            <small>${esc(W.shortPath(p.project))} · ${esc(when(p.at))}${p.pasted.length ? ` · +${p.pasted.length} pasted` : ""}</small></div>
            <div class="cm-row-actions"><button class="btn sm" data-row="${i}" data-cm="ask" title="Put it in the Claude input">Ask again</button><button class="icon" data-row="${i}" data-cm="copy-prompt" title="Copy">⧉</button></div></div>`;
        })
        .join("") || empty("Prompts typed in the Claude Code CLI appear here (~/.claude/history.jsonl).")
    );
  }

  // ---------- Skills, agents, lệnh /, output style, rules ----------
  function itemsBar(key) {
    const [, label] = ITEM_KINDS[key];
    return `${search(`Search ${label}s…`)}<button class="btn sm" data-cm="new-item" data-scope="user">＋ User ${esc(label)}</button>${cwd() ? `<button class="btn sm" data-cm="new-item" data-scope="project">＋ Project ${esc(label)}</button>` : ""}`;
  }
  function itemsList(key) {
    if (!st.cfg) return empty("Loading…");
    const items = (st.cfg[key] || []).filter((x) => matches(`${x.name} ${x.description} ${x.scope}`));
    const groups = new Map();
    for (const x of items) groups.set(x.scope, [...(groups.get(x.scope) || []), x]);
    const where = { skills: "skills/<name>/SKILL.md", agents: "agents/*.md", commands: "commands/*.md", outputStyles: "output-styles/*.md", rules: "rules/*.md" }[key];
    if (!groups.size) return empty(`None yet. They live in ~/.claude/${where} (user) or <project>/.claude/${where} (project).`);
    return [...groups]
      .map(
        ([scope, list]) =>
          `<h3 class="cm-group">${scopeChip(scope)} <span class="faint">${list.length}</span></h3>${list
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((x) => {
              const i = ref({ type: "file", ...x });
              const ro = scope.startsWith("plugin:");
              return `<div class="cm-row" data-row="${i}" data-open title="${esc(x.path)}"><div class="cm-row-main"><b class="mono">${key === "commands" ? "/" : ""}${esc(x.name)}</b>${x.link ? ` <span class="chip outline">link</span>` : ""}${x.model ? ` <span class="chip outline">${esc(x.model)}</span>` : ""}
                <small>${esc(clip(x.description, 240)) || '<span class="faint">No description</span>'}</small></div>
                <div class="cm-row-actions">${ro ? "" : `<button class="icon" data-cm="trash" title="${x.link ? "Remove link" : "Delete (moved to ~/.claude/backups/dash-trash)"}">✕</button>`}</div></div>`;
            })
            .join("")}`
      )
      .join("");
  }

  async function newItem(key, scope) {
    const [kind, label] = ITEM_KINDS[key];
    const name = await W.prompt(`New ${scope} ${label}`, "", { label: "Name (letters, digits, dot, dash, underscore)" });
    if (!name) return;
    const r = await guarded(() => api("POST", "/api/claude/manage/item", { cwd: cwd(), kind, scope, name: name.trim() }));
    if (!r) return;
    W.openFile(r.path);
    await loadCfg();
    paint();
  }
  async function trashItem(x) {
    const ok = await confirmDialog(x.link ? `Remove the link ${x.dir || x.path}? The folder it points to is kept.` : `Delete ${x.name}? It is moved to ~/.claude/backups/dash-trash, so you can restore it.`, { title: "Delete", ok: "Delete", danger: true, detail: x.dir || x.path });
    if (!ok) return;
    if ((await guarded(() => api("POST", "/api/claude/manage/trash", { cwd: cwd(), path: x.path }), "Deleted")) == null) return;
    await loadCfg();
    paint();
  }

  // ---------- Memory ----------
  function memoryList() {
    if (!st.cfg) return empty("Loading…");
    const list = st.cfg.memory.filter((m) => matches(`${m.label} ${m.path}`));
    return `<p class="faint cm-note">Claude reads CLAUDE.md files at the start of each conversation. Auto memory is what Claude saved itself for ${esc(W.shortPath(cwd()) || "this folder")}.</p>${list
      .map((m) => {
        const i = ref({ type: "memory", ...m });
        return `<div class="cm-row" data-row="${i}" data-open title="${esc(m.path)}"><div class="cm-row-main"><b>${esc(m.label)}</b> ${scopeChip(m.scope)}<small class="mono">${esc(W.shortPath(m.path))}</small></div>
          <div class="cm-row-actions">${m.exists ? (m.scope === "memory" ? `<button class="icon" data-cm="trash" title="Delete">✕</button>` : "") : `<button class="btn sm" data-cm="open-row">Create</button>`}</div></div>`;
      })
      .join("")}`;
  }

  // ---------- Hooks ----------
  const hooksBar = () => `${scopeSelect("hookScope")}<button class="btn sm primary" data-cm="add-hook">＋ Add hook</button><button class="btn sm" data-cm="edit-settings" data-scope="${st.hookScope}">Edit JSON</button>`;
  function hooksList() {
    if (!st.cfg) return empty("Loading…");
    const hooks = st.cfg.hooks[st.hookScope] || {};
    const events = Object.keys(hooks);
    if (!events.length) return empty("No hooks in this scope. Hooks run a command when Claude uses a tool, starts, stops…");
    return events
      .map(
        (ev) =>
          `<h3 class="cm-group">${esc(ev)}</h3>${(hooks[ev] || [])
            .map((g, gi) =>
              (g.hooks || [])
                .map((hk, hi) => {
                  const i = ref({ type: "hook", event: ev, gi, hi, matcher: g.matcher || "", hook: hk });
                  return `<div class="cm-row" data-row="${i}" data-cm-edit><div class="cm-row-main"><span><span class="chip outline mono">${esc(g.matcher || "*")}</span> <span class="chip">${esc(hk.type || "command")}</span>${hk.timeout ? ` <span class="faint">${esc(hk.timeout)}s</span>` : ""}</span>
                    <code class="cm-cmd">${esc(hk.command || hk.prompt || hk.url || JSON.stringify(hk))}</code></div>
                    <div class="cm-row-actions"><button class="icon" data-cm="edit-hook" title="Edit">✎</button><button class="icon" data-cm="del-hook" title="Delete">✕</button></div></div>`;
                })
                .join("")
            )
            .join("")}`
      )
      .join("");
  }

  function hookModal(r) {
    const hk = r?.hook || { type: "command" };
    const events = st.cfg.hookEvents.length ? st.cfg.hookEvents : ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop"];
    const m = openModal(
      r ? "Edit hook" : `Add hook (${esc(st.hookScope)})`,
      `<form id="cm-hook" class="form">
        <label class="field"><span>Event</span><select name="event">${events.map((e) => `<option ${e === (r?.event || "PreToolUse") ? "selected" : ""}>${esc(e)}</option>`).join("")}</select></label>
        <label class="field"><span>Matcher</span><input name="matcher" class="mono" value="${esc(r?.matcher || "")}" placeholder="Bash, Edit|Write… empty = all" /></label>
        <label class="field"><span>Type</span><select name="type">${["command", "prompt", "agent", "http"].map((t) => `<option ${t === (hk.type || "command") ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field"><span>Timeout (seconds)</span><input name="timeout" type="number" min="0" value="${esc(hk.timeout || "")}" /></label>
        <label class="field full"><span>Command / prompt / URL</span><textarea name="body" rows="4" class="mono" required>${esc(hk.command || hk.prompt || hk.url || "")}</textarea>
          <small>A command gets the event as JSON on stdin; exit code 2 blocks the action and shows stderr to Claude.</small></label></form>`,
      `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="cm-hook">Save</button>`
    );
    $("#cm-hook", m).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const h = { ...hk, type: f.type };
      delete h.command;
      delete h.prompt;
      delete h.url;
      h[{ command: "command", prompt: "prompt", agent: "prompt", http: "url" }[f.type]] = f.body.trim();
      if (Number(f.timeout) > 0) h.timeout = Number(f.timeout);
      else delete h.timeout;
      if (await saveHook(r, f.event, f.matcher.trim(), h)) closeModal();
    };
  }

  async function saveHook(r, event, matcher, hook) {
    const hooks = structuredClone(st.cfg.hooks[st.hookScope] || {});
    const same = r && r.event === event && r.matcher === matcher;
    if (same) hooks[event][r.gi].hooks[r.hi] = hook;
    else {
      if (r) {
        hooks[r.event][r.gi].hooks.splice(r.hi, 1);
        hooks[r.event] = hooks[r.event].filter((g) => g.hooks?.length);
        if (!hooks[r.event].length) delete hooks[r.event];
      }
      if (hook) {
        const groups = (hooks[event] ||= []);
        let g = groups.find((x) => (x.matcher || "") === matcher);
        if (!g) groups.push((g = matcher ? { matcher, hooks: [] } : { hooks: [] }));
        g.hooks.push(hook);
      }
    }
    return saveSetting(st.hookScope, "hooks", hooks);
  }

  async function saveSetting(scope, key, value) {
    const r = await guarded(() => api("PUT", "/api/claude/manage/setting", { cwd: cwd(), scope, key, value }), "Saved");
    if (r == null) return false;
    await loadCfg();
    paint();
    return true;
  }

  // ---------- Permissions ----------
  const permsBar = () => `${scopeSelect("permScope")}<button class="btn sm" data-cm="edit-settings" data-scope="${st.permScope}">Edit JSON</button>`;
  function permsList() {
    if (!st.cfg) return empty("Loading…");
    const p = st.cfg.permissions[st.permScope] || {};
    const lists = [
      ["allow", "Allow", "Run without asking, e.g. Bash(npm run test:*), Read(~/docs/**), WebFetch(domain:github.com)"],
      ["ask", "Ask", "Always ask first"],
      ["deny", "Deny", "Never allowed, e.g. Read(./.env), Bash(rm -rf:*)"],
      ["additionalDirectories", "Extra folders", "Folders Claude may use besides the current one"],
    ];
    return `<div class="setting"><div class="setting-label"><b>Default permission mode</b><small>Empty = Claude Code default.</small></div><div class="setting-input">${select("perm-mode", PERM_MODES.map((m) => [m, m || "(default)"]), p.defaultMode || "")}</div></div>
      ${lists
        .map(
          ([k, label, help]) => `<h3 class="cm-group">${label} <span class="faint">${(p[k] || []).length}</span> <button class="btn sm ghost" data-cm="perm-add" data-key="${k}">＋ Add</button></h3><small class="faint">${esc(help)}</small>
          <div class="cm-chips">${(p[k] || []).map((v, idx) => `<span class="chip outline mono">${esc(v)} <button class="icon" data-cm="perm-del" data-key="${k}" data-idx="${idx}" title="Remove">✕</button></span>`).join("")}</div>`
        )
        .join("")}`;
  }
  function savePerms(mutate) {
    const p = structuredClone(st.cfg.permissions[st.permScope] || {});
    mutate(p);
    for (const k of Object.keys(p)) if ((Array.isArray(p[k]) && !p[k].length) || p[k] === "") delete p[k];
    return saveSetting(st.permScope, "permissions", p);
  }

  // ---------- MCP ----------
  const mcpBar = () => `${search("Search servers…")}<button class="btn sm primary" data-cm="mcp-add">＋ Add server</button>`;
  function mcpList() {
    if (!st.cfg) return empty("Loading…");
    const list = st.cfg.mcp.filter((s) => matches(`${s.name} ${JSON.stringify(s.config)}`));
    return (
      list
        .map((s) => {
          const i = ref({ type: "mcp", ...s });
          const c = s.config || {};
          const target = c.url || [c.command, ...(c.args || [])].filter(Boolean).join(" ");
          return `<div class="cm-row" data-row="${i}" data-cm-edit><div class="cm-row-main"><span><b>${esc(s.name)}</b> ${scopeChip(s.scope)} <span class="chip outline">${esc(c.type || (c.url ? "http" : "stdio"))}</span>${s.approval ? ` <span class="chip ${s.approval === "approved" ? "green" : s.approval === "rejected" ? "red" : "amber"}">${esc(s.approval)}</span>` : ""}</span>
            <code class="cm-cmd">${esc(target)}</code></div>
            <div class="cm-row-actions"><button class="icon" data-cm="mcp-edit" title="Edit">✎</button><button class="icon" data-cm="mcp-del" title="Remove">✕</button></div></div>`;
        })
        .join("") || empty("No MCP servers. User servers live in ~/.claude.json, project servers in .mcp.json. claude.ai connectors are managed on claude.ai.")
    );
  }
  function mcpModal(s) {
    const scopes = cwd() ? ["user", "local", "project"] : ["user"];
    const cfg = s?.config || { type: "stdio", command: "", args: [], env: {} };
    const m = openModal(
      s ? `Edit MCP server ${esc(s.name)}` : "Add MCP server",
      `<form id="cm-mcp" class="form">
        <label class="field"><span>Name</span><input name="name" class="mono" required value="${esc(s?.name || "")}" /></label>
        <label class="field"><span>Scope</span><select name="scope">${scopes.map((x) => `<option ${x === (s?.scope || "user") ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label class="field full"><span>Config (JSON)</span><textarea name="config" rows="10" class="mono" spellcheck="false">${esc(JSON.stringify(cfg, null, 2))}</textarea>
          <small>stdio: {"type":"stdio","command":"npx","args":["-y","pkg"],"env":{}} · remote: {"type":"http","url":"https://…","headers":{}}. Values shown as •••••• are kept. user = all projects, local = only you in this folder, project = shared .mcp.json.</small></label></form>`,
      `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="cm-mcp">Save</button>`,
      true
    );
    $("#cm-mcp", m).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      let config;
      try {
        config = JSON.parse(f.config);
      } catch (x) {
        return toast(`Invalid JSON: ${x.message}`, "error");
      }
      const list = await guarded(() => api("PUT", "/api/claude/manage/mcp", { cwd: cwd(), name: f.name.trim(), scope: f.scope, config, oldName: s?.name, oldScope: s?.scope }), "MCP server saved");
      if (!list) return;
      closeModal();
      st.cfg.mcp = list;
      paint();
    };
  }

  // ---------- Plugins ----------
  const pluginsBar = () => `${search(st.available ? "Search the catalog…" : "Search plugins…")}<button class="btn sm" data-cm="browse">${st.available ? "Hide catalog" : "Browse catalog"}</button><button class="btn sm" data-cm="mkt-add">＋ Marketplace</button><button class="btn sm" data-cm="refresh">Refresh</button>`;
  const pid = (p) => p.id || p.pluginId || p.name || "";
  function pluginsList() {
    if (!st.plugins) return empty("Loading…");
    if (st.available === "loading") return empty("Loading the plugin catalog…");
    if (st.available) {
      const list = (st.available.available || []).filter((p) => matches(`${pid(p)} ${p.description || ""}`)).sort((a, b) => (b.installCount || 0) - (a.installCount || 0));
      return (
        list
          .slice(0, 150)
          .map((p) => {
            const i = ref({ type: "plugin", ...p });
            return `<div class="cm-row"><div class="cm-row-main"><b>${esc(p.name || pid(p))}</b> <span class="faint">${esc(p.marketplaceName || "")}${p.installCount ? ` · ${p.installCount.toLocaleString()} installs` : ""}</span><small>${esc(clip(p.description, 260))}</small></div>
              <div class="cm-row-actions"><button class="btn sm" data-row="${i}" data-cm="plugin-install">Install</button></div></div>`;
          })
          .join("") + (list.length > 150 ? `<div class="faint cm-note">${list.length - 150} more; narrow the search.</div>` : "") || empty("No match.")
      );
    }
    const installed = (st.plugins.installed || []).filter((p) => matches(`${pid(p)} ${p.description || ""}`));
    const mkts = Object.entries(st.plugins.marketplaces || {});
    return `${st.plugins.error ? `<div class="cm-note err">${esc(st.plugins.error)}</div>` : ""}<h3 class="cm-group">Installed <span class="faint">${installed.length}</span></h3>${
      installed
        .map((p) => {
          const i = ref({ type: "plugin", ...p });
          const on = p.enabled !== false;
          return `<div class="cm-row"><div class="cm-row-main"><span><b>${esc(pid(p))}</b>${p.version ? ` <span class="faint">${esc(p.version)}</span>` : ""}${p.scope ? ` ${scopeChip(p.scope)}` : ""} <span class="chip ${on ? "green" : "outline"}">${on ? "enabled" : "disabled"}</span></span>${p.description ? `<small>${esc(clip(p.description, 240))}</small>` : ""}</div>
            <div class="cm-row-actions"><button class="btn sm" data-row="${i}" data-cm="plugin-${on ? "disable" : "enable"}">${on ? "Disable" : "Enable"}</button><button class="btn sm" data-row="${i}" data-cm="plugin-update">Update</button><button class="icon" data-row="${i}" data-cm="plugin-uninstall" title="Uninstall">✕</button></div></div>`;
        })
        .join("") || empty("No plugins installed. Browse the catalog to add one.")
    }<h3 class="cm-group">Marketplaces <span class="faint">${mkts.length}</span></h3>${mkts
      .map(([name, m]) => {
        const i = ref({ type: "marketplace", id: name });
        const src = m.source?.repo || m.source?.url || m.source?.path || "";
        return `<div class="cm-row"><div class="cm-row-main"><b>${esc(name)}</b><small>${esc(src)}${m.lastUpdated ? ` · updated ${esc(when(Date.parse(m.lastUpdated)))}` : ""}</small></div>
          <div class="cm-row-actions"><button class="btn sm" data-row="${i}" data-cm="mkt-update">Update</button><button class="icon" data-row="${i}" data-cm="mkt-remove" title="Remove">✕</button></div></div>`;
      })
      .join("")}`;
  }
  async function pluginAction(action, id, scope, btn) {
    if (btn) btn.disabled = true;
    toast(`Running claude plugin ${action.replace("-", " ")}…`);
    const r = await guarded(() => api("POST", "/api/claude/manage/plugins", { cwd: cwd(), action, id, scope }));
    if (btn) btn.disabled = false;
    if (!r) return;
    toast(r.output.split("\n").pop() || "Done", "ok", 5000);
    if (st.available && action === "install") st.available = null;
    await Promise.all([loadPlugins(), loadCfg()]);
    paint();
  }
  const pickScope = (title) => W.quickPick([{ label: "User", detail: "All your projects", value: "user" }, ...(cwd() ? [{ label: "Project", detail: "Shared with the repo (.claude/settings.json)", value: "project" }, { label: "Local", detail: "Only you, in this folder", value: "local" }] : [])], { placeholder: title });

  // ---------- Settings files ----------
  function settingsList() {
    if (!st.cfg) return empty("Loading…");
    const label = { user: "User settings (all projects)", project: "Project settings (shared, committed)", local: "Local project settings (only you, not committed)" };
    return `<p class="faint cm-note">Claude Code config folder: <code>${esc(W.shortPath(st.cfg.home))}</code>. Later scopes override earlier ones: user → project → local.</p>${Object.entries(st.cfg.settings)
      .map(([scope, f]) => {
        const i = ref({ type: "settings", scope, ...f });
        return `<div class="cm-row" data-row="${i}" data-open title="${esc(f.path)}"><div class="cm-row-main"><span><b>${label[scope]}</b> ${scopeChip(scope)}${f.valid ? "" : ' <span class="chip red">invalid JSON</span>'}</span>
          <small class="mono">${esc(W.shortPath(f.path))}</small>${f.keys.length ? `<div class="cm-chips">${f.keys.map((k) => `<span class="chip outline mono">${esc(k)}</span>`).join("")}</div>` : ""}</div>
          <div class="cm-row-actions"><button class="btn sm" data-cm="open-row">${f.exists ? "Open" : "Create"}</button></div></div>`;
      })
      .join("")}`;
  }
  async function openConfigFile(kind, p) {
    const r = await guarded(() => api("POST", "/api/claude/manage/item", { cwd: cwd(), kind, name: p }));
    if (!r) return;
    W.openFile(r.path);
    await loadCfg();
    paint();
  }

  // ---------- vẽ ----------
  const VIEWS = {
    sessions: [sessionsBar, sessionsList],
    prompts: [promptsBar, promptsList],
    ...Object.fromEntries(Object.keys(ITEM_KINDS).map((k) => [k, [() => itemsBar(k), () => itemsList(k)]])),
    memory: [() => search("Search memory files…"), memoryList],
    hooks: [hooksBar, hooksList],
    permissions: [permsBar, permsList],
    mcp: [mcpBar, mcpList],
    plugins: [pluginsBar, pluginsList],
    settings: [() => "", settingsList],
  };
  function count(id) {
    const c = st.cfg;
    if (id === "sessions") return st.sessions ? scopedSessions().length : "";
    if (!c) return "";
    if (ITEM_KINDS[id]) return c[id].length;
    if (id === "memory") return c.memory.filter((m) => m.exists).length;
    if (id === "hooks") return Object.values(c.hooks).reduce((n, h) => n + Object.values(h).flat().reduce((k, g) => k + (g.hooks?.length || 0), 0), 0);
    if (id === "mcp") return c.mcp.length;
    if (id === "plugins") return c.plugins.length;
    return "";
  }
  function paint() {
    if (!host) return;
    const [bar] = VIEWS[st.section];
    const remote = W.isRemote(W.folder) ? `<div class="cm-note faint">The current folder is on an SSH machine; only user-level Claude settings are shown.</div>` : "";
    $(".cm-nav", host).innerHTML = `<div class="cm-cur"><small class="faint">Folder</small><button class="btn sm ghost mono" data-cm="folder" title="Change the current folder">${esc(W.shortPath(W.folder) || "~")}</button></div>${SECTIONS.map(([id, label]) => `<a href="#" class="${st.section === id ? "active" : ""}" data-sec="${id}">${esc(label)}<span class="faint">${count(id)}</span></a>`).join("")}`;
    $(".cm-body", host).innerHTML = `<h2>${esc(SECTIONS.find(([id]) => id === st.section)[1])}</h2>${remote}<div class="cm-bar">${bar()}</div><div class="cm-list"></div>`;
    paintList();
  }
  function paintList() {
    st.rows = [];
    $(".cm-list", host).innerHTML = VIEWS[st.section][1]();
  }

  // ---------- sự kiện ----------
  async function act(a, el, item, e) {
    const sec = st.section;
    switch (a) {
      case "refresh":
        if (sec === "plugins") st.available = null;
        return reload();
      case "folder":
        return W.pickFolder();
      case "pick-folder":
        st.folderPick = el.dataset.folder;
        return paintList();
      case "open-row":
        if (item.type === "session") return openTranscript(item);
        if (item.type === "memory") return item.exists ? W.openFile(item.path) : openConfigFile("memory", item.path);
        if (item.type === "settings") return item.exists ? W.openFile(item.path) : openConfigFile("settings", item.path);
        return W.openFile(item.path);
      case "resume":
        return resume(item);
      case "session-menu":
        return sessionMenu(e, item);
      case "ask":
        return W.claudeAsk(item.text);
      case "copy-prompt":
        return copy([item.text, ...item.pasted].join("\n\n"));
      case "new-item":
        return newItem(sec, el.dataset.scope);
      case "trash":
        return trashItem(item);
      case "add-hook":
        return hookModal(null);
      case "edit-hook":
        return hookModal(item);
      case "del-hook":
        if (await confirmDialog(`Delete this ${item.event} hook?`, { title: "Delete hook", ok: "Delete", danger: true, detail: item.hook.command || item.hook.prompt || item.hook.url || "" })) saveHook(item, item.event, item.matcher, null);
        return;
      case "edit-settings":
        return openConfigFile("settings", st.cfg.settings[el.dataset.scope].path);
      case "perm-add": {
        const v = await W.prompt(`Add to ${el.dataset.key}`, "", { label: el.dataset.key === "additionalDirectories" ? "Folder path" : "Rule, e.g. Bash(npm run test:*)" });
        if (v?.trim()) savePerms((p) => (p[el.dataset.key] = [...(p[el.dataset.key] || []), v.trim()]));
        return;
      }
      case "perm-del":
        return savePerms((p) => p[el.dataset.key].splice(Number(el.dataset.idx), 1));
      case "mcp-add":
        return mcpModal(null);
      case "mcp-edit":
        return mcpModal(item);
      case "mcp-del":
        if (!(await confirmDialog(`Remove the MCP server ${item.name} (${item.scope})?`, { title: "Remove MCP server", ok: "Remove", danger: true }))) return;
        st.cfg.mcp = (await guarded(() => api("POST", "/api/claude/manage/mcp/remove", { cwd: cwd(), scope: item.scope, name: item.name }), "Removed")) || st.cfg.mcp;
        return paintList();
      case "browse":
        if (st.available) {
          st.available = null;
          return paint();
        }
        st.available = "loading";
        paint();
        st.available = await api("GET", `/api/claude/manage/plugins?available=1&cwd=${enc(cwd())}`).catch((x) => (toast(x.message, "error"), null));
        return paint();
      case "plugin-install": {
        const scope = await pickScope(`Install ${pid(item)} for…`);
        if (scope) pluginAction("install", pid(item), scope, el);
        return;
      }
      case "plugin-enable":
      case "plugin-disable":
      case "plugin-update":
        return pluginAction(a.slice(7), pid(item), item.scope, el);
      case "plugin-uninstall":
        if (await confirmDialog(`Uninstall ${pid(item)}?`, { title: "Uninstall plugin", ok: "Uninstall", danger: true })) pluginAction("uninstall", pid(item), item.scope, el);
        return;
      case "mkt-add": {
        const src = await W.prompt("Add plugin marketplace", "", { label: "GitHub owner/repo, git URL or local path" });
        if (src?.trim()) pluginAction("marketplace-add", src.trim(), "", null);
        return;
      }
      case "mkt-update":
        return pluginAction("marketplace-update", item.id, "", el);
      case "mkt-remove":
        if (await confirmDialog(`Remove the marketplace ${item.id}? Plugins installed from it are uninstalled.`, { title: "Remove marketplace", ok: "Remove", danger: true })) pluginAction("marketplace-remove", item.id, "", el);
        return;
    }
  }

  function mount(h) {
    host = h;
    h.classList.add("cm-host");
    h.innerHTML = `<div class="cm"><nav class="cm-nav"></nav><div class="cm-body"></div></div>`;
    h.addEventListener("click", (e) => {
      const nav = e.target.closest("[data-sec]");
      if (nav) {
        e.preventDefault();
        st.section = nav.dataset.sec;
        st.q = "";
        paint();
        if (st.section === "prompts" && !st.prompts) loadPrompts().then(paint);
        if (st.section === "plugins" && !st.plugins) loadPlugins().then(paint);
        return;
      }
      const b = e.target.closest("[data-cm]");
      const rowEl = e.target.closest("[data-row]");
      const item = rowEl ? st.rows[Number(rowEl.dataset.row)] : null;
      if (b) return act(b.dataset.cm, b, item, e);
      if (rowEl?.hasAttribute("data-open")) return act("open-row", rowEl, item, e);
      if (rowEl?.hasAttribute("data-cm-edit")) return act(item.type === "hook" ? "edit-hook" : "mcp-edit", rowEl, item, e);
    });
    h.addEventListener("contextmenu", (e) => {
      const rowEl = e.target.closest("[data-row]");
      const item = rowEl && st.rows[Number(rowEl.dataset.row)];
      if (item?.type === "session") sessionMenu(e, item);
    });
    h.addEventListener("input", (e) => {
      if (!e.target.matches("[data-cm-q]")) return;
      st.q = e.target.value;
      paintList();
    });
    h.addEventListener("change", (e) => {
      const k = e.target.dataset.cmSet;
      if (!k) return;
      if (k === "perm-mode") return savePerms((p) => (p.defaultMode = e.target.value));
      st[k] = e.target.value;
      if (k === "promptScope") {
        st.prompts = null;
        loadPrompts().then(paint);
      }
      paint();
    });
    paint();
    reload();
    return { dispose: () => (host = null) };
  }

  function open(section) {
    if (section) st.section = section;
    W.openTab({ id: "claude-manager", title: "Claude Manager", icon: W.ICON.claude, persist: { kind: "claude-manager", data: {} }, create: (h) => mount(h) });
    if (host) reload();
  }

  W.on("folder", () => {
    if (!host) return;
    st.folderPick = "";
    st.prompts = null;
    st.plugins = null;
    if (!cwd()) st.hookScope = st.permScope = "user";
    reload();
  });
  W.registerRestorer("claude-manager", () => open());
  W.command("claude.manager", "Claude: Claude Manager (conversations, skills, hooks, MCP, plugins…)", () => open());
  W.command("claude.conversations", "Claude: browse all conversations…", () => open("sessions"));
  W.command("claude.skills", "Claude: manage skills…", () => open("skills"));
  W.command("claude.hooks", "Claude: manage hooks…", () => open("hooks"));
  W.command("claude.mcp", "Claude: manage MCP servers…", () => open("mcp"));
})();
