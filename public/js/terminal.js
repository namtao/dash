"use strict";
// Terminal: xterm.js nối với PTY trên server qua WebSocket. Mỗi "nhóm" là một tab trong danh sách terminal
// bên phải panel, chứa một hoặc nhiều pane chia ngang/dọc (giống WezTerm). PTY vẫn chạy khi tải lại trang.
(() => {
  const panes = new Map(); // termId -> pane
  let groups = store.get("termGroups", []); // [{ id, dir: "row"|"column", panes: [termId] }]
  let activeGroup = store.get("termActive", null);
  let focused = null; // termId đang focus
  let root = null;
  let gseq = Date.now();
  const saveGroups = () => {
    store.set("termGroups", groups);
    store.set("termActive", activeGroup);
  };

  // Bảng màu One Dark Pro (giống theme phổ biến của WezTerm / VS Code)
  const THEME_DARK = {
    background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", cursorAccent: "#282c34", selectionBackground: "#3e4451",
    black: "#3f4451", red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
    brightBlack: "#4f5666", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
  };
  const THEME_LIGHT = {
    background: "#fafafa", foreground: "#383a42", cursor: "#526fff", cursorAccent: "#fafafa", selectionBackground: "#d7dae0",
    black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401", blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#a0a1a7",
    brightBlack: "#696c77", brightRed: "#e45649", brightGreen: "#50a14f", brightYellow: "#c18401", brightBlue: "#4078f2", brightMagenta: "#a626a4", brightCyan: "#0184bc", brightWhite: "#ffffff",
  };
  const termTheme = () => (W.isDark() ? THEME_DARK : THEME_LIGHT);

  // Mẫu lệnh nguy hiểm khi dán (học từ smart paste của WezTerm)
  const DANGER = [/rm\s+-rf/i, /sudo\s+rm/i, /\bmkfs/i, /\bdd\s+if=/i, /\bshutdown\b/i, /\breboot\b/i, /docker\s+compose\s+down\s+-v/i, /docker\s+system\s+prune/i, /git\s+reset\s+--hard/i, /git\s+push\s+[^\n]*--force/i, /:\(\)\s*\{\s*:\|:&\s*\};:/];

  function options() {
    const ws = W.ws();
    return {
      fontFamily: ws.fontFamily,
      fontSize: ws.fontSize,
      lineHeight: ws.lineHeight,
      cursorStyle: ws.cursorStyle,
      cursorBlink: ws.cursorBlink,
      scrollback: ws.scrollback,
      theme: termTheme(),
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
    };
  }

  class Pane {
    constructor(info) {
      this.id = info.id;
      this.info = info;
      this.el = document.createElement("div");
      this.el.className = "term-pane";
      this.el.dataset.term = info.id;
      this.el.innerHTML = `<div class="term-search hidden"><input placeholder="Find in terminal" /><button class="icon" data-dir="-1" title="Previous (Shift+Enter)">↑</button><button class="icon" data-dir="1" title="Next (Enter)">↓</button><button class="icon" data-close title="Close (Esc)">✕</button></div><div class="term-host"></div>`;
      this.term = new Terminal(options());
      this.fit = new FitAddon.FitAddon();
      this.search = new SearchAddon.SearchAddon();
      this.term.loadAddon(this.fit);
      this.term.loadAddon(this.search);
      this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, "_blank", "noopener")));
      try {
        this.term.loadAddon(new Unicode11Addon.Unicode11Addon());
        this.term.unicode.activeVersion = "11";
      } catch {}
      this.opened = false;
      this.term.onData((d) => W.send({ t: "term.input", id: this.id, data: d }));
      this.term.onSelectionChange(() => {
        if (W.ws().copyOnSelect && this.term.hasSelection()) navigator.clipboard?.writeText(this.term.getSelection()).catch(() => {});
      });
      this.term.attachCustomKeyEventHandler((e) => this.keys(e));
      this.term.textarea?.addEventListener("focus", () => setFocus(this.id));
      this.el.addEventListener("mousedown", () => setFocus(this.id));
      this.el.addEventListener("contextmenu", (e) => this.contextMenu(e));
      this.bindSearch();
      this.ro = new ResizeObserver(() => this.resize());
    }

    open(container) {
      container.append(this.el);
      if (!this.opened) {
        this.term.open($(".term-host", this.el));
        try {
          const gl = new WebglAddon.WebglAddon();
          gl.onContextLoss(() => gl.dispose());
          this.term.loadAddon(gl);
        } catch {}
        this.opened = true;
        this.ro.observe(this.el);
        W.send({ t: "term.attach", id: this.id });
      }
      this.resize();
    }

    resize() {
      if (!this.opened || !this.el.offsetWidth || !this.el.offsetHeight) return;
      try {
        this.fit.fit();
      } catch {}
      const { cols, rows } = this.term;
      if (cols !== this.cols || rows !== this.rows) {
        this.cols = cols;
        this.rows = rows;
        W.send({ t: "term.resize", id: this.id, cols, rows });
      }
    }

    // Phím đặc biệt kiểu WezTerm: Ctrl+Backspace xoá từ, Ctrl+Shift+C copy, Ctrl+Shift+V dán
    keys(e) {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
        if (this.term.hasSelection()) navigator.clipboard?.writeText(this.term.getSelection());
        e.preventDefault();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
        e.preventDefault();
        this.pasteClipboard();
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "Backspace") {
        W.send({ t: "term.input", id: this.id, data: "\x17" });
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "Backspace") {
        W.send({ t: "term.input", id: this.id, data: "\x15" });
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "Delete") {
        W.send({ t: "term.input", id: this.id, data: "\x1bd" });
        return false;
      }
      return true;
    }

    async pasteClipboard() {
      let text = "";
      try {
        text = await navigator.clipboard.readText();
      } catch {
        return toast("Clipboard access was blocked by the browser", "error");
      }
      this.paste(text);
    }

    async paste(text) {
      if (!text) return;
      if (W.ws().confirmDangerousPaste && DANGER.some((re) => re.test(text)) && !(await confirmDialog("This paste looks dangerous. Paste it anyway?", { title: "Dangerous paste", ok: "Paste", danger: true, detail: text.slice(0, 500) }))) return;
      this.term.paste(text);
      this.term.focus();
    }

    contextMenu(e) {
      if (W.ws().rightClickPaste && !e.shiftKey) {
        e.preventDefault();
        if (this.term.hasSelection()) {
          navigator.clipboard?.writeText(this.term.getSelection());
          this.term.clearSelection();
          toast("Copied", "ok", 1200);
        } else this.pasteClipboard();
        return;
      }
      W.menu(e, [
        { label: "Copy", run: () => navigator.clipboard?.writeText(this.term.getSelection()), disabled: !this.term.hasSelection() },
        { label: "Paste", run: () => this.pasteClipboard() },
        { sep: true },
        { label: "Find…", run: () => this.showSearch(), key: W.keyFor("terminal.search") },
        { label: "Clear", run: () => this.term.clear() },
        { label: "Split right", run: () => split("row") },
        { label: "Split down", run: () => split("column") },
        ...sshItems(this.info),
        { sep: true },
        { label: "Kill terminal", danger: true, run: () => killTerm(this.id) },
      ]);
    }

    bindSearch() {
      const box = $(".term-search", this.el);
      const input = $("input", box);
      const opts = { decorations: { matchOverviewRuler: "#e5c07b", activeMatchColorOverviewRuler: "#61afef", matchBackground: "#e5c07b55", activeMatchBackground: "#61afef88" } };
      const go = (dir) => (dir < 0 ? this.search.findPrevious(input.value, opts) : this.search.findNext(input.value, opts));
      input.addEventListener("input", () => go(1));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") go(e.shiftKey ? -1 : 1);
        if (e.key === "Escape") this.hideSearch();
        e.stopPropagation();
      });
      box.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.close != null) this.hideSearch();
        else go(Number(b.dataset.dir));
      });
    }
    showSearch() {
      const box = $(".term-search", this.el);
      box.classList.remove("hidden");
      const input = $("input", box);
      if (this.term.hasSelection()) input.value = this.term.getSelection();
      input.focus();
      input.select();
    }
    hideSearch() {
      $(".term-search", this.el).classList.add("hidden");
      this.search.clearDecorations();
      this.term.focus();
    }

    applyOptions() {
      const o = options();
      for (const k of ["fontFamily", "fontSize", "lineHeight", "cursorStyle", "cursorBlink", "scrollback", "theme"]) this.term.options[k] = o[k];
      this.resize();
    }

    dispose() {
      this.ro.disconnect();
      W.send({ t: "term.detach", id: this.id });
      this.term.dispose();
      this.el.remove();
    }
  }

  // Terminal SSH: mở thư mục trên máy đó trong Explorer, chuyển tiếp cổng qua máy đó
  const sshItems = (info) =>
    info.sshId && W.ssh
      ? [
          { sep: true },
          { label: "Open remote folder in Explorer…", run: () => W.ssh.openFolder(info.sshId) },
          { label: "Port forwarding…", run: () => W.ssh.forward(info.sshId) },
        ]
      : [];

  // ---------- nhóm / pane ----------
  const groupOf = (termId) => groups.find((g) => g.panes.includes(termId));
  const titleOf = (p) => p?.info.title || "terminal";

  function setFocus(id) {
    if (focused === id) return;
    focused = id;
    const g = groupOf(id);
    if (g && activeGroup !== g.id) {
      activeGroup = g.id;
      paint();
    }
    $$(".term-pane", root).forEach((el) => el.classList.toggle("focused", el.dataset.term === id));
    paintList();
    saveGroups();
  }

  function ensurePane(info) {
    let p = panes.get(info.id);
    if (!p) {
      p = new Pane(info);
      panes.set(info.id, p);
    } else p.info = { ...p.info, ...info };
    return p;
  }

  async function create(opts = {}, { splitDir, inGroup } = {}) {
    let info;
    try {
      info = await api("POST", "/api/terminals", { cwd: opts.cwd || W.folder, ssh: opts.ssh, cols: 120, rows: 30, ws: W.wsId });
    } catch (e) {
      return toast(e.message, "error");
    }
    ensurePane(info);
    if (inGroup) {
      inGroup.panes.push(info.id);
      inGroup.dir = splitDir || inGroup.dir || "row";
    } else {
      const g = { id: `g${++gseq}`, dir: "row", panes: [info.id] };
      groups.push(g);
      activeGroup = g.id;
    }
    focused = info.id;
    saveGroups();
    updateStatus();
    W.showPanel("terminal");
    paint();
    setTimeout(() => panes.get(info.id)?.term.focus(), 30);
    return info;
  }

  function split(dir) {
    const g = groups.find((x) => x.id === activeGroup);
    if (!g) return create();
    const cur = panes.get(focused);
    return create({ cwd: cur?.info.cwd || W.folder }, { splitDir: dir, inGroup: g });
  }

  async function killTerm(id) {
    await api("DELETE", `/api/terminals/${id}`).catch(() => {});
    removePane(id);
  }

  function removePane(id) {
    const p = panes.get(id);
    if (p) {
      p.dispose();
      panes.delete(id);
    }
    for (const g of groups) g.panes = g.panes.filter((x) => x !== id);
    const idx = groups.findIndex((g) => !g.panes.length);
    if (idx >= 0) {
      groups.splice(idx, 1);
      if (!groups.some((g) => g.id === activeGroup)) activeGroup = groups[Math.min(idx, groups.length - 1)]?.id || null;
    }
    if (focused === id) focused = groups.find((g) => g.id === activeGroup)?.panes[0] || null;
    saveGroups();
    paint();
    updateStatus();
    if (focused) panes.get(focused)?.term.focus();
  }

  function paint() {
    if (!root) return;
    const area = $(".term-area", root);
    const g = groups.find((x) => x.id === activeGroup) || groups[0];
    if (g) activeGroup = g.id;
    // Giữ nguyên phần tử pane (không tạo lại xterm), chỉ sắp xếp lại
    for (const p of panes.values()) if (!g?.panes.includes(p.id)) p.el.remove();
    area.innerHTML = "";
    if (!g) {
      area.innerHTML = `<div class="term-empty"><p>No terminal open.</p><button class="btn primary" data-cmd="terminal.new">New terminal</button> <button class="btn" data-cmd="terminal.ssh">Connect SSH…</button><p class="faint">${esc(W.keyFor("terminal.new"))} new · ${esc(W.keyFor("terminal.splitRight"))} split · ${esc(W.keyFor("terminal.ssh"))} SSH</p></div>`;
    } else {
      const wrap = document.createElement("div");
      wrap.className = `term-group ${g.dir}`;
      area.append(wrap);
      g.panes.forEach((id, i) => {
        if (i) {
          const s = document.createElement("div");
          s.className = `term-sash ${g.dir}`;
          wrap.append(s);
        }
        const p = panes.get(id);
        if (p) {
          p.open(wrap);
          p.el.style.flex = "1 1 0";
          p.el.classList.toggle("focused", id === focused);
        }
      });
    }
    paintList();
    requestAnimationFrame(() => g?.panes.forEach((id) => panes.get(id)?.resize()));
  }

  function paintList() {
    if (!root) return;
    const list = $(".term-list", root);
    list.innerHTML = groups
      .map((g, i) => {
        const items = g.panes.map((id) => panes.get(id)).filter(Boolean);
        return `<div class="tl-group ${g.id === activeGroup ? "active" : ""}" data-group="${g.id}">
          ${items
            .map(
              (p, j) => `<div class="tl-item ${p.id === focused ? "focused" : ""} ${p.info.exited ? "exited" : ""}" data-tl="${p.id}" title="${esc(p.info.cwd || "")}">
              <span class="tl-icon">${j ? "├" : p.info.kind === "ssh" ? "⇄" : "›"}</span><span class="tl-title">${esc(titleOf(p))}</span>${i < 8 && !j ? `<span class="tl-key">${i + 1}</span>` : ""}
              <button class="icon tl-kill" data-kill="${p.id}" title="Kill">✕</button></div>`
            )
            .join("")}</div>`;
      })
      .join("");
  }

  function mount(el) {
    root = el;
    el.innerHTML = `<div class="term-wrap"><div class="term-area"></div><div class="term-list"></div></div>`;
    $(".term-list", el).addEventListener("click", (e) => {
      const kill = e.target.closest("[data-kill]");
      if (kill) return killTerm(kill.dataset.kill);
      const it = e.target.closest("[data-tl]");
      if (it) {
        const g = groupOf(it.dataset.tl);
        activeGroup = g?.id;
        focused = it.dataset.tl;
        saveGroups();
        paint();
        panes.get(focused)?.term.focus();
      }
    });
    $(".term-list", el).addEventListener("dblclick", (e) => {
      const it = e.target.closest("[data-tl]");
      if (it) rename(it.dataset.tl);
    });
    $(".term-list", el).addEventListener("contextmenu", (e) => {
      const it = e.target.closest("[data-tl]");
      if (!it) return;
      const id = it.dataset.tl;
      W.menu(e, [
        { label: "Rename…", run: () => rename(id) },
        { label: "Split right", run: () => { focused = id; split("row"); } },
        { label: "Split down", run: () => { focused = id; split("column"); } },
        { label: "Move to its own tab", run: () => unsplit(id) },
        ...sshItems(panes.get(id)?.info || {}),
        { sep: true },
        { label: "Kill terminal", danger: true, run: () => killTerm(id) },
      ]);
    });
    reconcile();
  }

  function unsplit(id) {
    const g = groupOf(id);
    if (!g || g.panes.length < 2) return;
    g.panes = g.panes.filter((x) => x !== id);
    const ng = { id: `g${++gseq}`, dir: "row", panes: [id] };
    groups.splice(groups.indexOf(g) + 1, 0, ng);
    activeGroup = ng.id;
    saveGroups();
    paint();
  }

  async function rename(id) {
    const p = panes.get(id);
    const title = await W.prompt("Rename terminal", titleOf(p), { mono: false });
    if (title == null) return;
    await api("PUT", `/api/terminals/${id}`, { title }).catch((e) => toast(e.message, "error"));
  }

  // Khớp danh sách nhóm đã lưu với terminal đang sống trên server
  async function reconcile() {
    let list = [];
    try {
      list = await api("GET", `/api/terminals?ws=${encodeURIComponent(W.wsId)}`);
    } catch {}
    const alive = new Set(list.map((t) => t.id));
    for (const t of list) ensurePane(t);
    for (const g of groups) g.panes = g.panes.filter((id) => alive.has(id));
    groups = groups.filter((g) => g.panes.length);
    for (const t of list) if (!groupOf(t.id)) groups.push({ id: `g${++gseq}`, dir: "row", panes: [t.id] });
    for (const [id, p] of panes) if (!alive.has(id)) (p.dispose(), panes.delete(id));
    if (!groups.some((g) => g.id === activeGroup)) activeGroup = groups[0]?.id || null;
    saveGroups();
    paint();
    updateStatus();
  }

  function focusDir(delta) {
    const g = groups.find((x) => x.id === activeGroup);
    if (!g) return;
    const i = g.panes.indexOf(focused);
    const next = g.panes[(i + delta + g.panes.length) % g.panes.length];
    panes.get(next)?.term.focus();
  }

  function cycleGroup(delta) {
    if (!groups.length) return;
    const i = groups.findIndex((g) => g.id === activeGroup);
    const g = groups[(i + delta + groups.length) % groups.length];
    activeGroup = g.id;
    focused = g.panes[0];
    saveGroups();
    paint();
    panes.get(focused)?.term.focus();
  }

  function gotoGroup(n) {
    const g = groups[n];
    if (!g) return;
    W.showPanel("terminal");
    activeGroup = g.id;
    focused = g.panes[0];
    saveGroups();
    paint();
    panes.get(focused)?.term.focus();
  }

  async function setFontSize(size) {
    size = Math.min(32, Math.max(8, size));
    S.config.workspace.fontSize = size;
    for (const p of panes.values()) p.applyOptions();
    clearTimeout(setFontSize.t);
    setFontSize.t = setTimeout(() => api("PUT", "/api/workspace", { fontSize: size }).catch(() => {}), 600);
  }

  async function pickSsh() {
    const list = S.config?.ssh || [];
    if (!list.length) {
      toast("No SSH profiles yet. Add them in the SSH view.", "info", 5000);
      return W.showView("ssh");
    }
    const id = await W.quickPick(
      list.map((p) => ({ label: `[${sshTag(p)}]  ${p.label}`, detail: `${p.user ? `${p.user}@` : ""}${p.host}${p.port !== 22 ? `:${p.port}` : ""}`, value: p.id })),
      { placeholder: "SSH connections" }
    );
    if (id) create({ ssh: id });
  }

  const sshTag = (p) => (p.user === "root" ? "ROOT" : /^(192\.168\.|10\.)/.test(p.host) ? "LAN" : /^100\./.test(p.host) ? "VPN" : /^172\./.test(p.host) ? "CLOUD" : "WAN");

  function updateStatus() {
    const n = panes.size;
    W.status("terminals", { side: "right", order: 20, html: `${W.ICON.terminal}<span>${n}</span>`, title: `${n} terminal(s) · ${W.keyFor("terminal.toggle")}`, cmd: "terminal.toggle" });
  }

  // API cho module khác (lịch sử, explorer, SSH)
  W.term = {
    create,
    focusedPane: () => panes.get(focused) || [...panes.values()][0],
    // Gõ lệnh vào terminal đang focus (tạo mới nếu chưa có); run = nhấn Enter luôn
    async insert(text, { run = false, cwd } = {}) {
      let p = panes.get(focused);
      if (!p || p.info.exited) {
        await create({ cwd });
        p = panes.get(focused);
        await new Promise((r) => setTimeout(r, 600));
      }
      if (!p) return;
      W.showPanel("terminal");
      W.send({ t: "term.input", id: p.id, data: text.replace(/\n/g, run ? "\r" : " ") + (run ? "\r" : "") });
      p.term.focus();
    },
    sshTag,
  };

  // ---------- sự kiện server ----------
  W.onMsg("term.replay", (m) => {
    const p = panes.get(m.id);
    if (!p) return;
    p.term.reset();
    p.term.write(m.data);
  });
  W.onMsg("term.data", (m) => panes.get(m.id)?.term.write(m.data));
  W.onMsg("term.created", (m) => {
    if (panes.has(m.id) || m.ws !== W.wsId) return;
    setTimeout(() => {
      if (!panes.has(m.id)) reconcile();
    }, 300);
  });
  W.onMsg("term.cwd", (m) => {
    const p = panes.get(m.id);
    if (!p) return;
    p.info.cwd = m.cwd;
    if (p.info.kind === "shell" && !p.renamed) p.info.title = W.base(m.cwd) || "/";
    paintList();
  });
  W.onMsg("term.renamed", (m) => {
    const p = panes.get(m.id);
    if (!p) return;
    p.info.title = m.title;
    p.renamed = true;
    paintList();
  });
  W.onMsg("term.exit", (m) => {
    const p = panes.get(m.id);
    if (!p) return;
    p.info.exited = true;
    if (m.exitCode === 0) killTerm(m.id);
    else {
      p.term.write(`\r\n\x1b[2m[process exited with code ${m.exitCode} — press any key or Alt+W to close]\x1b[0m\r\n`);
      const sub = p.term.onKey(() => {
        sub.dispose();
        killTerm(m.id);
      });
      paintList();
    }
  });
  W.onMsg("term.closed", (m) => {
    if (panes.has(m.id)) removePane(m.id);
    updateStatus();
  });
  W.on("ws:open", () => {
    // Server khởi động lại: gắn lại các terminal còn sống
    if (root) reconcile();
    for (const p of panes.values()) if (p.opened) W.send({ t: "term.attach", id: p.id });
  });
  W.on("theme", () => panes.forEach((p) => (p.term.options.theme = termTheme())));
  W.on("config", () => panes.forEach((p) => p.applyOptions()));
  W.on("layout", () => groups.find((g) => g.id === activeGroup)?.panes.forEach((id) => panes.get(id)?.resize()));

  // ---------- đăng ký ----------
  const inTerm = () => Boolean(document.activeElement?.closest?.(".xterm"));
  W.registerPanel("terminal", {
    title: "Terminal",
    order: 1,
    mount,
    show(actions) {
      actions.innerHTML = `<button class="icon" data-cmd="terminal.new" title="New terminal (${esc(W.keyFor("terminal.new"))})">＋</button>
        <button class="icon" data-cmd="terminal.ssh" title="SSH (${esc(W.keyFor("terminal.ssh"))})">⇄</button>
        <button class="icon" data-cmd="terminal.splitRight" title="Split right (${esc(W.keyFor("terminal.splitRight"))})">◫</button>
        <button class="icon" data-cmd="terminal.kill" title="Kill terminal (${esc(W.keyFor("terminal.kill"))})">🗑</button>`;
      requestAnimationFrame(() => {
        groups.find((g) => g.id === activeGroup)?.panes.forEach((id) => panes.get(id)?.resize());
        panes.get(focused)?.term.focus();
      });
    },
  });

  W.command("terminal.new", "Terminal: new terminal in current folder", () => create(), "Alt+T, Ctrl+Shift+`");
  W.command("terminal.newHere", "Terminal: new terminal in folder…", async () => {
    const dir = await W.prompt("Open terminal in folder", W.folder);
    if (dir) create({ cwd: dir.replace(/^~/, W.home) });
  });
  W.command("terminal.toggle", "Terminal: toggle / focus", () => {
    if (W.layout.showPanel && W.layout.panelTab === "terminal" && inTerm()) return W.run("layout.togglePanel");
    W.showPanel("terminal");
    if (!panes.size) create();
    else panes.get(focused)?.term.focus();
  }, "Ctrl+`");
  W.command("terminal.ssh", "Terminal: connect SSH…", () => pickSsh(), "Alt+S");
  W.command("terminal.splitRight", "Terminal: split right", () => split("row"), "Alt+Enter, Ctrl+Shift+S");
  W.command("terminal.splitDown", "Terminal: split down", () => split("column"), "Alt+Shift+Enter, Ctrl+Shift+D");
  W.command("terminal.kill", "Terminal: kill focused pane", () => focused && killTerm(focused), "Alt+W");
  W.command("terminal.next", "Terminal: next tab", () => cycleGroup(1), "Alt+Right, Ctrl+Tab");
  W.command("terminal.prev", "Terminal: previous tab", () => cycleGroup(-1), "Alt+Left, Ctrl+Shift+Tab");
  W.command("terminal.paneNext", "Terminal: focus next pane", () => focusDir(1), "Ctrl+Alt+Right, Ctrl+Alt+Down");
  W.command("terminal.panePrev", "Terminal: focus previous pane", () => focusDir(-1), "Ctrl+Alt+Left, Ctrl+Alt+Up");
  for (let i = 1; i <= 8; i++) W.command(`terminal.goto${i}`, `Terminal: go to tab ${i}`, () => gotoGroup(i - 1), `Alt+${i}`, { hidden: i > 1 });
  W.command("terminal.search", "Terminal: find", () => (panes.get(focused) || W.term.focusedPane())?.showSearch(), "Ctrl+Shift+F", { when: inTerm });
  W.command("terminal.clear", "Terminal: clear", () => panes.get(focused)?.term.clear(), "Ctrl+Shift+K", { when: inTerm });
  W.command("terminal.rename", "Terminal: rename", () => focused && rename(focused), "F2", { when: inTerm });
  W.command("terminal.fontBigger", "Terminal: bigger font", () => setFontSize(W.ws().fontSize + 1), "Ctrl+=, Ctrl+Shift+=");
  W.command("terminal.fontSmaller", "Terminal: smaller font", () => setFontSize(W.ws().fontSize - 1), "Ctrl+-");
  W.command("terminal.fontReset", "Terminal: reset font size", () => setFontSize(13), "Ctrl+0");
  W.command("terminal.scrollTop", "Terminal: scroll to top", () => panes.get(focused)?.term.scrollToTop(), "Ctrl+Home", { when: inTerm });
  W.command("terminal.scrollBottom", "Terminal: scroll to bottom", () => panes.get(focused)?.term.scrollToBottom(), "Ctrl+End", { when: inTerm });
  W.command("terminal.pageUp", "Terminal: scroll page up", () => panes.get(focused)?.term.scrollPages(-1), "Alt+PageUp, Shift+PageUp", { when: inTerm });
  W.command("terminal.pageDown", "Terminal: scroll page down", () => panes.get(focused)?.term.scrollPages(1), "Alt+PageDown, Shift+PageDown", { when: inTerm });
  W.on("ready", updateStatus);
})();
