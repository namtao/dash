"use strict";
// Source Control: thay đổi đã stage / chưa stage, commit, pull/push, lịch sử commit và diff hai bên
// bằng Monaco diff editor. Ở chế độ thư mục làm việc, bên phải sửa được và Ctrl+S ghi vào file.
(() => {
  let root = null;
  let st = null; // trạng thái git gần nhất
  let busy = false;
  let showLog = store.get("scmLog", false);
  let log = null;
  const commitOpen = new Map(); // hash -> files

  const join = (a, b) => `${a.replace(/\/+$/, "")}/${b}`;
  const STATUS_CLS = { M: "mod", A: "add", D: "del", R: "ren", U: "unt", C: "add", T: "mod" };

  async function refresh() {
    try {
      st = await api("GET", `/api/git/status?dir=${encodeURIComponent(W.folder)}`);
    } catch (e) {
      st = { error: e.message };
    }
    paintStatus();
    if (root) paint();
    W.setBadge("scm", st && !st.error ? String(st.staged.length + st.changes.length + st.conflicts.length || "") : "");
  }
  W.scmRefresh = refresh;

  function paintStatus() {
    if (!st || st.error) return W.status("git", null);
    const n = st.staged.length + st.changes.length + st.conflicts.length;
    W.status("git", {
      order: 10,
      html: `${W.ICON.git}<span>${esc(st.branch)}${n ? "*" : ""}</span>${st.ahead || st.behind ? `<span class="faint">↓${st.behind} ↑${st.ahead}</span>` : ""}`,
      title: `${st.root}\n${n} change(s)${st.upstream ? `\nupstream ${st.upstream}` : ""}`,
      cmd: "view.scm",
    });
  }

  function fileRow(c, kind) {
    const name = W.base(c.path);
    const dir = c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : "";
    const actions =
      kind === "staged"
        ? `<button class="icon" data-scm="unstage" title="Unstage">−</button>`
        : kind === "changes"
          ? `<button class="icon" data-scm="discard" title="Discard changes">↶</button><button class="icon" data-scm="stage" title="Stage">＋</button>`
          : `<button class="icon" data-scm="stage" title="Mark resolved (stage)">＋</button>`;
    return `<div class="scm-row" data-path="${esc(c.path)}" data-kind="${kind}" title="${esc(c.path)} · ${esc(c.label)}">
      ${W.fileIcon(c.path)}<span class="fname">${esc(name)}</span><span class="fdir">${esc(dir)}</span>
      <span class="scm-actions"><button class="icon" data-scm="open" title="Open file">⎘</button>${actions}</span>
      <span class="scm-st st-${STATUS_CLS[c.status] || "mod"}">${esc(c.status)}</span></div>`;
  }

  function section(title, kind, list, extra = "") {
    if (!list.length) return "";
    return `<div class="scm-sec"><div class="scm-sec-head"><span>${title}</span><span class="count">${list.length}</span><span class="scm-actions">${extra}</span></div>${list.map((c) => fileRow(c, kind)).join("")}</div>`;
  }

  function paint() {
    if (!root) return;
    const body = $(".scm-body", root);
    if (!st) return (body.innerHTML = `<div class="empty"><span class="spinner"></span></div>`);
    if (st.error) {
      body.innerHTML = `<div class="empty">${esc(st.error)}<br><span class="faint">${esc(W.shortPath(W.folder))}</span><br><br><button class="btn sm" data-scm-init>Initialize repository</button></div>`;
      $(".scm-commit", root).classList.add("hidden");
      return;
    }
    $(".scm-commit", root).classList.remove("hidden");
    $(".scm-branch", root).innerHTML = `${W.ICON.git} <b>${esc(st.branch)}</b>${st.upstream ? ` <span class="faint">→ ${esc(st.upstream)}</span>` : ""} ${st.ahead || st.behind ? `<span class="chip outline">↓${st.behind} ↑${st.ahead}</span>` : ""}`;
    const nothing = !st.staged.length && !st.changes.length && !st.conflicts.length;
    body.innerHTML =
      section("Merge conflicts", "conflicts", st.conflicts) +
      section("Staged changes", "staged", st.staged, `<button class="icon" data-scm="unstage-all" title="Unstage all">−</button>`) +
      section("Changes", "changes", st.changes, `<button class="icon" data-scm="discard-all" title="Discard all changes">↶</button><button class="icon" data-scm="stage-all" title="Stage all">＋</button>`) +
      (nothing ? `<div class="empty faint">No changes</div>` : "") +
      `<div class="scm-sec"><div class="scm-sec-head clickable" data-scm="toggle-log"><span>${showLog ? "▾" : "▸"} Commits</span></div>${showLog ? logHtml() : ""}</div>`;
    const btn = $(".scm-commit-btn", root);
    btn.disabled = busy;
    btn.textContent = st.staged.length ? `✓ Commit (${st.staged.length})` : "✓ Commit all";
  }

  function logHtml() {
    if (!log) {
      api("GET", `/api/git/log?dir=${encodeURIComponent(W.folder)}&limit=100`)
        .then((l) => {
          log = l;
          paint();
        })
        .catch(() => {});
      return `<div class="empty"><span class="spinner"></span></div>`;
    }
    return log
      .map((c) => {
        const files = commitOpen.get(c.hash);
        return `<div class="log-row" data-hash="${c.hash}" title="${esc(c.subject)}\n${esc(c.author)} · ${new Date(c.date).toLocaleString("en-GB")}">
          <span class="twisty">${files ? "▾" : "▸"}</span><span class="log-subj">${esc(c.subject)}</span>${c.refs ? `<span class="log-refs">${esc(c.refs.replace("HEAD -> ", ""))}</span>` : ""}<span class="log-meta">${esc(c.short)}</span></div>
          ${files ? files.map((f) => `<div class="scm-row sub" data-commit="${c.hash}" data-path="${esc(f.path)}">${W.fileIcon(f.path)}<span class="fname">${esc(W.base(f.path))}</span><span class="fdir">${esc(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "")}</span><span class="scm-st st-${STATUS_CLS[f.status] || "mod"}">${esc(f.status)}</span></div>`).join("") : ""}`;
      })
      .join("");
  }

  async function act(action, paths) {
    if (busy) return;
    if ((action === "discard" || action === "discard-all") && !(await confirmDialog(`Discard changes in ${paths.length === 1 ? paths[0] : `${paths.length} files`}?\nUntracked files are deleted. This cannot be undone.`, { title: "Discard changes", ok: "Discard", danger: true }))) return;
    busy = true;
    try {
      await api("POST", `/api/git/${action.replace("-all", "")}`, { dir: W.folder, paths });
    } catch (e) {
      toast(e.message, "error");
    }
    busy = false;
    await refresh();
    W.emit("git:changed");
    refreshDiffTabs();
  }

  async function commit(opts = {}) {
    const box = $(".scm-msg", root);
    const message = box.value.trim();
    if (!message && !opts.amend) {
      box.focus();
      return toast("Type a commit message first", "error");
    }
    busy = true;
    paint();
    try {
      await api("POST", "/api/git/commit", { dir: W.folder, message, amend: opts.amend, all: !st.staged.length || opts.all });
      box.value = "";
      store.set(`commitMsg:${st.root}`, "");
      toast("Committed", "ok");
      log = null;
    } catch (e) {
      toast(e.message, "error");
    }
    busy = false;
    await refresh();
    W.emit("git:changed");
  }

  // Commit message do AI chạy local viết từ diff (đã stage, hoặc toàn bộ nếu chưa stage gì)
  let generating = false;
  async function aiMessage() {
    if (generating) return;
    const box = $(".scm-msg", root);
    const btn = $("[data-scm=ai-msg]", root);
    generating = true;
    btn.classList.add("busy");
    btn.disabled = true;
    try {
      const r = await api("POST", "/api/ai/commit", { dir: W.folder });
      box.value = r.message;
      if (st?.root) store.set(`commitMsg:${st.root}`, box.value);
      box.dispatchEvent(new Event("input"));
      toast(r.staged ? "Message written from staged changes" : "Nothing staged: message written from all changes", "ok", 2500);
    } catch (e) {
      toast(e.message, "error");
    }
    generating = false;
    btn.classList.remove("busy");
    btn.disabled = false;
  }

  async function sync(action) {
    toast(`git ${action}…`);
    try {
      const r = await api("POST", `/api/git/${action}`, { dir: W.folder });
      toast(r.output?.split("\n").slice(-2).join(" ") || `${action} done`, "ok", 5000);
      log = null;
    } catch (e) {
      toast(e.message, "error");
    }
    refresh();
    W.emit("git:changed");
  }

  async function checkout() {
    const list = await api("GET", `/api/git/branches?dir=${encodeURIComponent(W.folder)}`).catch(() => []);
    const name = await W.quickPick(
      list.map((b) => ({ label: b.name, detail: b.current ? "current" : "", value: b.name })),
      { placeholder: "Switch branch (type a new name to create it)", allowCustom: true }
    );
    if (!name) return;
    const exists = list.some((b) => b.name === name);
    if (await guarded(() => api("POST", "/api/git/checkout", { dir: W.folder, branch: name, create: !exists }), `On ${name}`)) {
      log = null;
      refresh();
      W.emit("git:changed");
    }
  }

  function mount(body, actions) {
    root = body;
    actions.innerHTML = `<button class="icon" data-scm="pull" title="Pull">↓</button><button class="icon" data-scm="push" title="Push">↑</button><button class="icon" data-scm="fetch" title="Fetch">⟳</button><button class="icon" data-scm="refresh" title="Refresh">↻</button>`;
    body.innerHTML = `<div class="scm-commit">
        <button class="scm-branch" data-scm="checkout" title="Switch branch"></button>
        <div class="scm-msg-wrap"><textarea class="scm-msg" rows="3" placeholder="Message (Ctrl+Enter to commit)"></textarea><button class="icon scm-ai" data-scm="ai-msg" title="Write the message with local AI (${esc(W.keyFor("scm.aiMessage") || "")})">${W.ICON.sparkle}</button></div>
        <div class="scm-commit-row"><button class="btn primary sm scm-commit-btn" data-scm="commit">✓ Commit</button><button class="btn sm" data-scm="commit-menu" title="More commit actions">▾</button></div>
      </div><div class="scm-body"></div>`;
    const msg = $(".scm-msg", body);
    msg.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
    msg.addEventListener("input", () => st?.root && store.set(`commitMsg:${st.root}`, msg.value));
    const onClick = async (e) => {
      if (e.target.closest("[data-scm-init]")) {
        await W.term.insert("git init", { run: true, cwd: W.folder });
        return setTimeout(refresh, 1200);
      }
      const b = e.target.closest("[data-scm]");
      const row = e.target.closest(".scm-row");
      const logRow = e.target.closest(".log-row");
      if (b) {
        const a = b.dataset.scm;
        const path = row?.dataset.path;
        if (a === "open") return W.openFile(join(st.root, path));
        if (a === "stage" || a === "unstage" || a === "discard") return act(a, [path]);
        if (a === "stage-all") return act("stage", st.changes.map((c) => c.path));
        if (a === "unstage-all") return act("unstage", st.staged.map((c) => c.path));
        if (a === "discard-all") return act("discard", st.changes.map((c) => c.path));
        if (a === "commit") return commit();
        if (a === "ai-msg") return aiMessage();
        if (a === "commit-menu")
          return W.menu(e, [
            { label: "Commit staged", run: () => commit() },
            { label: "Commit all (stage everything)", run: () => commit({ all: true }) },
            { label: "Amend last commit", run: () => commit({ amend: true }) },
            { sep: true },
            { label: "Pull", run: () => sync("pull") },
            { label: "Push", run: () => sync("push") },
            { label: "Ask Claude to write the message", run: () => W.claudeAsk?.("Look at the staged git changes (or all changes if nothing is staged) and write a concise conventional commit message. Reply with only the message.") },
          ]);
        if (["pull", "push", "fetch"].includes(a)) return sync(a);
        if (a === "refresh") return refresh();
        if (a === "checkout") return checkout();
        if (a === "toggle-log") {
          showLog = !showLog;
          store.set("scmLog", showLog);
          return paint();
        }
      }
      if (logRow) {
        const h = logRow.dataset.hash;
        if (commitOpen.has(h)) commitOpen.delete(h);
        else {
          const r = await api("GET", `/api/git/commit?dir=${encodeURIComponent(W.folder)}&hash=${h}`).catch((err) => toast(err.message, "error"));
          if (r) commitOpen.set(h, r.files);
        }
        return paint();
      }
      if (row) {
        if (row.dataset.commit) return openDiff(row.dataset.path, "commit", row.dataset.commit);
        openDiff(row.dataset.path, row.dataset.kind === "staged" ? "staged" : "working");
      }
    };
    actions.addEventListener("click", onClick);
    body.addEventListener("click", onClick);
    body.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".scm-row:not(.sub)");
      if (!row) return;
      const p = row.dataset.path;
      const kind = row.dataset.kind;
      W.menu(e, [
        { label: "Open changes", run: () => openDiff(p, kind === "staged" ? "staged" : "working") },
        { label: "Open file", run: () => W.openFile(join(st.root, p)) },
        kind === "staged" ? { label: "Unstage", run: () => act("unstage", [p]) } : { label: "Stage", run: () => act("stage", [p]) },
        ...(kind === "changes" ? [{ sep: true }, { label: "Discard changes", danger: true, run: () => act("discard", [p]) }] : []),
      ]);
    });
    refresh().then(() => {
      if (st?.root) msg.value = store.get(`commitMsg:${st.root}`, "");
    });
  }

  // ---------- diff editor ----------
  const diffTabs = new Set();
  function refreshDiffTabs() {
    for (const t of diffTabs) t.inst?.reload?.();
  }

  function openDiff(rel, mode, commit = "") {
    const repo = st?.root || W.folder;
    const id = `diff:${mode}:${commit}:${repo}/${rel}`;
    const label = mode === "staged" ? "Index" : mode === "commit" ? commit.slice(0, 7) : "Working Tree";
    return W.openTab({
      id,
      title: `${W.base(rel)} (${label})`,
      icon: W.fileIcon(rel) || W.ICON.diff,
      tooltip: `${rel} · ${mode === "working" ? "index ↔ working tree" : mode === "staged" ? "HEAD ↔ index" : `${commit.slice(0, 7)}^ ↔ ${commit.slice(0, 7)}`}`,
      persist: { kind: "diff", data: { repo, rel, mode, commit } },
      create: (host, tab) => {
        diffTabs.add(tab);
        return createDiff(host, tab, repo, rel, mode, commit);
      },
    });
  }
  W.openDiff = openDiff;
  W.registerRestorer("diff", (d) => openDiff(d.rel, d.mode, d.commit));

  function createDiff(host, tab, repo, rel, mode, commit) {
    const inline = store.get("diffInline", false);
    host.classList.add("code-host");
    host.innerHTML = `<div class="crumbs diff-bar"><span>${esc(rel)}</span><span class="faint">${mode === "working" ? "Index ↔ Working tree (right side is editable, Ctrl+S saves)" : mode === "staged" ? "HEAD ↔ Index" : `${commit.slice(0, 7)}^ ↔ ${commit.slice(0, 7)}`}</span>
      <span class="diff-actions"><button class="icon" data-d="prev" title="Previous change (Alt+F5)">↑</button><button class="icon" data-d="next" title="Next change (F7)">↓</button>
      <button class="icon" data-d="inline" title="Toggle inline / side by side">${inline ? "◫" : "▤"}</button>
      ${mode === "working" ? `<button class="btn sm" data-d="stage">Stage file</button>` : mode === "staged" ? `<button class="btn sm" data-d="unstage">Unstage file</button>` : ""}
      <button class="btn sm ghost" data-d="open">Open file</button></span></div><div class="code-editor"><div class="loading"><span class="spinner"></span></div></div>`;
    const s = { editor: null, orig: null, mod: null, saved: "", disposed: false };
    async function load() {
      let d;
      try {
        d = await api("GET", `/api/git/diff?dir=${encodeURIComponent(repo)}&path=${encodeURIComponent(rel)}&mode=${mode}&commit=${commit}`);
      } catch (e) {
        $(".code-editor", host).innerHTML = `<div class="empty">${esc(e.message)}</div>`;
        return;
      }
      if (d.binary) {
        $(".code-editor", host).innerHTML = `<div class="empty">Binary file</div>`;
        return;
      }
      const monaco = await W.monaco();
      if (s.disposed) return;
      const lang = W.langOf(rel);
      if (!s.editor) {
        $(".code-editor", host).innerHTML = "";
        s.orig = monaco.editor.createModel(d.original, lang);
        s.mod = monaco.editor.createModel(d.modified ?? "", lang);
        s.editor = monaco.editor.createDiffEditor($(".code-editor", host), {
          theme: W.monacoTheme(),
          automaticLayout: true,
          renderSideBySide: !store.get("diffInline", false),
          originalEditable: false,
          readOnly: mode !== "working",
          fontFamily: W.ws().fontFamily,
          fontSize: W.ws().editorFontSize,
          ignoreTrimWhitespace: false,
          renderOverviewRuler: true,
          hideUnchangedRegions: { enabled: store.get("diffCollapse", false) },
        });
        s.editor.setModel({ original: s.orig, modified: s.mod });
        s.mod.onDidChangeContent(() => W.markDirty());
        s.editor.onDidUpdateDiff?.(() => {
          const n = s.editor.getLineChanges()?.length || 0;
          tab.badge = n ? String(n) : "";
          W.paintTabs();
        });
      } else {
        s.orig.setValue(d.original);
        if (!inst.isDirty()) s.mod.setValue(d.modified ?? "");
      }
      s.saved = d.modified ?? "";
    }
    host.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-d]");
      if (!b) return;
      const a = b.dataset.d;
      if (a === "next" || a === "prev") s.editor?.goToDiff?.(a === "next" ? "next" : "previous");
      if (a === "inline") {
        const v = !store.get("diffInline", false);
        store.set("diffInline", v);
        s.editor?.updateOptions({ renderSideBySide: !v });
        b.textContent = v ? "◫" : "▤";
      }
      if (a === "stage" || a === "unstage") {
        if (inst.isDirty() && !(await inst.save())) return;
        await act(a, [rel]);
        W.closeTab(tab.id, { force: true });
      }
      if (a === "open") W.openFile(join(repo, rel));
    });
    const inst = {
      isDirty: () => mode === "working" && Boolean(s.mod && s.mod.getValue() !== s.saved),
      layout: () => s.editor?.layout(),
      focus: () => s.editor?.getModifiedEditor().focus(),
      reload: load,
      async save() {
        if (mode !== "working" || !s.mod) return true;
        try {
          await api("PUT", "/api/files/write", { path: join(repo, rel), content: s.mod.getValue() });
          s.saved = s.mod.getValue();
          W.markDirty();
          refresh();
          return true;
        } catch (e) {
          toast(e.message, "error");
          return false;
        }
      },
      dispose() {
        s.disposed = true;
        diffTabs.delete(tab);
        s.editor?.dispose();
        s.orig?.dispose();
        s.mod?.dispose();
      },
    };
    load();
    return inst;
  }

  W.registerView("scm", { title: "Source Control", icon: W.ICON.git, order: 3, key: "view.scm", mount, show: refresh });
  W.command("view.scm", "Show Source Control", () => W.showView("scm"), "Ctrl+Shift+G");
  W.command("git.refresh", "Git: refresh", refresh);
  W.command("scm.aiMessage", "Git: write commit message with local AI", () => {
    W.showView("scm");
    setTimeout(aiMessage, 50);
  }, "Ctrl+Alt+M");
  W.command("git.pull", "Git: pull", () => sync("pull"));
  W.command("git.push", "Git: push", () => sync("push"));
  W.command("git.checkout", "Git: switch branch…", checkout);
  W.command("git.commit", "Git: commit", () => {
    W.showView("scm");
    setTimeout(() => $(".scm-msg")?.focus(), 50);
  }, "Ctrl+Shift+Enter");
  W.on("folder", () => {
    log = null;
    commitOpen.clear();
    refresh();
  });
  W.on("file:saved", refresh);
  W.onMsg("term.history", (m) => /^\s*(git|gh)\b/.test(m.entry?.cmd || "") && (refresh(), refreshDiffTabs(), (log = null)));
  W.on("ready", refresh);
  W.on("icons", () => root && paint());
  window.addEventListener("focus", () => refresh());
  setInterval(() => document.visibilityState === "visible" && refresh(), 15000);
})();
