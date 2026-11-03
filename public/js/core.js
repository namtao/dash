"use strict";
// Khung workbench kiểu VS Code: activity bar, side bar, tab editor, panel dưới, Claude bên phải, status bar,
// command palette, phím tắt có thể đổi, WebSocket dùng chung, nạp Monaco. Các module khác (terminal, git,
// database…) đăng ký view/tab/lệnh vào đối tượng W. Dùng lại helper của app.js: $, $$, esc, api, toast, store.

// Mỗi dự án mở trong một cửa sổ riêng (?w=<id dự án>), cửa sổ chính là "main". Trạng thái của cửa sổ
// (bố cục, tab, terminal, phiên Claude, thư mục…) lưu riêng theo cửa sổ để không đè lên nhau.
const WS_ID = new URLSearchParams(location.search).get("w") || "main";
(() => {
  const SCOPED = new Set(["layout", "folder", "tabs", "termGroups", "termActive", "claudeCurrent", "claudeDraft", "explorerOpen"]);
  const get = store.get;
  const set = store.set;
  const key = (k) => (WS_ID !== "main" && SCOPED.has(k) ? `${k}@${WS_ID}` : k);
  store.get = (k, d) => {
    const v = get(key(k), undefined);
    // cửa sổ dự án mới mở lần đầu: lấy bố cục của cửa sổ chính làm mặc định
    return v === undefined ? (k === "layout" ? get(k, d) : d) : v;
  };
  store.set = (k, v) => set(key(k), v);
})();

const W = (() => {
  const L = store.get("layout", {}); // trạng thái bố cục lưu trong trình duyệt
  const layout = {
    sidebar: L.sidebar ?? 280,
    panel: L.panel ?? 300,
    aux: L.aux ?? 420,
    showSidebar: L.showSidebar ?? true,
    showPanel: false, // panel (terminal) luôn ẩn khi mở trang, hiện khi mở terminal
    showAux: L.showAux ?? false,
    view: L.view || "projects",
    panelTab: L.panelTab || "terminal",
  };
  const saveLayout = () => store.set("layout", layout);
  // Màn hình hẹp (điện thoại): side bar và Claude là lớp phủ, mỗi lúc chỉ mở một cái
  const narrow = () => matchMedia("(max-width: 768px)").matches;
  if (narrow()) layout.showSidebar = layout.showAux = false;

  const W = {
    wsId: WS_ID,
    layout,
    folder: store.get("folder", "") || "",
    home: "",
    views: new Map(),
    panels: new Map(),
    tabs: [],
    active: null,
    commands: new Map(),
    handlers: new Map(),
    config: () => S.config,
    ws: () => S.config?.workspace || {},
  };

  // ---------- sự kiện ----------
  const bus = new EventTarget();
  W.on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));
  W.emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

  // ---------- WebSocket ----------
  let sock = null;
  let queue = [];
  function connect() {
    sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    sock.onopen = () => {
      queue.forEach((m) => sock.send(m));
      queue = [];
      W.emit("ws:open");
    };
    sock.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      (W.handlers.get(m.t) || []).forEach((fn) => fn(m));
    };
    sock.onclose = () => {
      W.emit("ws:close");
      setTimeout(connect, 1500);
    };
  }
  W.send = (msg) => {
    const s = JSON.stringify(msg);
    if (sock?.readyState === 1) sock.send(s);
    else queue.push(s);
  };
  W.onMsg = (t, fn) => {
    if (!W.handlers.has(t)) W.handlers.set(t, []);
    W.handlers.get(t).push(fn);
  };

  // ---------- thư mục hiện tại ----------
  W.setFolder = (dir, { silent } = {}) => {
    if (!dir || dir === W.folder) return;
    W.folder = dir;
    store.set("folder", dir);
    paintFolder();
    if (!silent) W.emit("folder", dir);
  };
  // ssh://<id>/dir hiện thành "Nhãn:/dir"
  const shortPath = (p) => {
    const m = String(p || "").match(/^ssh:\/\/([^/]+)(\/.*)$/);
    if (m) return `${S.config?.ssh?.find((x) => x.id === m[1])?.label || m[1]}:${m[2]}`;
    return W.home && p?.startsWith(W.home) ? `~${p.slice(W.home.length)}` : p || "";
  };
  W.isRemote = (p) => String(p || "").startsWith("ssh://");
  W.shortPath = shortPath;
  W.base = (p) => (p || "").replace(/\/+$/, "").split("/").pop() || "/";
  function paintFolder() {
    const b = $("#folder-pick");
    b.innerHTML = `<span class="fp-icon">${W.isRemote(W.folder) ? "⇄" : "▸"}</span><span>${esc(W.base(W.folder) || "Open folder")}</span><span class="fp-path">${esc(shortPath(W.folder))}</span>`;
  }

  // Hộp chọn thư mục: dự án, thư mục gần đây hoặc gõ đường dẫn
  W.pickFolder = async () => {
    const recent = store.get("recentFolders", []);
    const projects = (S.config?.projects || []).map((p) => ({ label: p.name, detail: shortPath(p.path), value: p.path }));
    const items = [...projects, ...recent.filter((r) => !projects.some((p) => p.value === r)).map((r) => ({ label: W.base(r), detail: shortPath(r), value: r }))];
    const picked = await W.quickPick(items, { placeholder: "Pick a project or type an absolute path (e.g. ~/Projects/foo)", allowCustom: true });
    if (!picked) return;
    const dir = picked.startsWith("~") ? W.home + picked.slice(1) : picked;
    W.setFolder(dir);
    store.set("recentFolders", [dir, ...recent.filter((r) => r !== dir)].slice(0, 15));
  };

  // ---------- tab dự án ----------
  // Trang "/" (shell.html) giữ thanh tab dự án; mỗi dự án chạy trong một khung riêng (index.html?w=<id>)
  // nên tab editor, terminal, phiên Claude và thư mục của từng dự án tách biệt. Workbench này vẽ thanh tab
  // trên title bar và gọi shell để mở / chuyển / đóng tab.
  const shell = (() => {
    try {
      return window.parent !== window ? window.parent.DashShell || null : null;
    } catch {
      return null;
    }
  })();
  W.shell = shell;

  W.openWorkspace = (id) => {
    if (id === WS_ID) {
      location.hash = `#/p/${encodeURIComponent(id)}/commands`;
      return;
    }
    if (shell) return shell.open(id);
    location.href = `/#open=${encodeURIComponent(id)}`;
  };

  function paintWorkspaceTabs(state) {
    const el = $("#ws-tabs");
    if (!el) return;
    if (!shell) return el.classList.add("hidden");
    const projects = S.config?.projects || [];
    el.innerHTML = state.tabs
      .map((id) => {
        const p = projects.find((x) => x.id === id);
        const running = p && runningCount(p);
        const label = id === "main" ? "Overview" : p?.name || id;
        return `<div class="ws-tab ${id === state.active ? "active" : ""}" data-ws="${esc(id)}" title="${esc(p?.path || "All projects")}">
          ${id === "main" ? ICON.home : `<span class="dot ${running ? "on" : ""}"></span>`}<span>${esc(label)}</span>
          ${id === "main" ? "" : `<button class="ws-close" data-ws-close="${esc(id)}" title="Close project tab">✕</button>`}</div>`;
      })
      .join("");
  }
  W.paintWorkspaceTabs = () => shell && paintWorkspaceTabs(shell.state());

  // ---------- activity bar + side bar ----------  // ---------- activity bar + side bar ----------
  W.registerView = (id, def) => {
    W.views.set(id, { id, order: 50, ...def });
  };

  function paintActivity() {
    const top = [...W.views.values()].filter((v) => !v.bottom).sort((a, b) => a.order - b.order);
    const bottom = [...W.views.values()].filter((v) => v.bottom).sort((a, b) => a.order - b.order);
    const after = top.filter((v) => v.afterClaude);
    top.splice(0, top.length, ...top.filter((v) => !v.afterClaude));
    const btn = (v) => `<button class="ab-item ${layout.showSidebar && layout.view === v.id ? "active" : ""}" data-view-btn="${v.id}" title="${esc(v.title)}${v.key ? ` (${esc(W.keyFor(v.key) || "")})` : ""}">${v.icon}${v.badge ? `<span class="ab-badge">${esc(v.badge)}</span>` : ""}</button>`;
    $("#activitybar").innerHTML = `<div class="ab-top">${top.map(btn).join("")}<button class="ab-item ${layout.showAux ? "active" : ""}" data-cmd="claude.toggle" title="Claude (${esc(W.keyFor("claude.toggle") || "")})">${ICON.claude}</button>${after.map(btn).join("")}</div><div class="ab-bottom">${bottom.map(btn).join("")}</div>`;
  }
  W.paintActivity = paintActivity;
  W.setBadge = (id, text) => {
    const v = W.views.get(id);
    if (!v || v.badge === text) return;
    v.badge = text;
    paintActivity();
  };

  W.showView = (id, { toggle = false } = {}) => {
    const v = W.views.get(id);
    if (!v) return;
    if (v.action) return v.action();
    if (toggle && layout.showSidebar && layout.view === id) {
      layout.showSidebar = false;
    } else {
      layout.view = id;
      layout.showSidebar = true;
      if (narrow()) layout.showAux = false;
    }
    saveLayout();
    applyLayout();
    const sb = $("#sidebar");
    let el = $(`.view[data-view="${id}"]`, sb);
    if (!el) {
      el = document.createElement("div");
      el.className = "view";
      el.dataset.view = id;
      el.innerHTML = `<div class="view-head"><span>${esc(v.title)}</span><div class="view-actions"></div></div><div class="view-body"></div>`;
      sb.append(el);
      v.mount?.($(".view-body", el), $(".view-actions", el));
    }
    $$(".view", sb).forEach((x) => x.classList.toggle("hidden", x !== el));
    if (layout.showSidebar) v.show?.();
    paintActivity();
  };

  // ---------- panel dưới (Terminal, History…) ----------
  W.registerPanel = (id, def) => W.panels.set(id, { id, order: 50, ...def });
  function paintPanelTabs() {
    const list = [...W.panels.values()].sort((a, b) => a.order - b.order);
    $("#panel-tabs").innerHTML =
      list.map((p) => `<button class="ptab ${layout.panelTab === p.id ? "active" : ""}" data-panel="${p.id}">${ptabLabel(p)}</button>`).join("") +
      `<div class="ptab-actions" id="ptab-actions"></div><button class="icon" data-cmd="layout.maximizePanel" title="Maximize panel">⤢</button><button class="icon" data-cmd="layout.togglePanel" title="Hide panel">✕</button>`;
  }
  const ptabLabel = (p) => `${esc(p.title)}${p.badge ? `<span class="ptab-badge">${esc(p.badge)}</span>` : ""}`;
  // Số đếm cạnh tên tab panel (vd. Problems); chỉ sửa nút đó để không xoá các nút hành động của panel
  W.setPanelBadge = (id, text) => {
    const p = W.panels.get(id);
    if (!p || p.badge === text) return;
    p.badge = text;
    const b = $(`.ptab[data-panel="${id}"]`);
    if (b) b.innerHTML = ptabLabel(p);
  };
  W.showPanel = (id) => {
    const p = W.panels.get(id || layout.panelTab);
    if (!p) return;
    layout.panelTab = p.id;
    layout.showPanel = true;
    saveLayout();
    applyLayout();
    paintPanelTabs();
    const body = $("#panel-body");
    let el = $(`.panel-view[data-panel-view="${p.id}"]`, body);
    if (!el) {
      el = document.createElement("div");
      el.className = "panel-view";
      el.dataset.panelView = p.id;
      body.append(el);
      p.mount?.(el);
    }
    $$(".panel-view", body).forEach((x) => x.classList.toggle("hidden", x !== el));
    $("#ptab-actions").innerHTML = "";
    p.show?.($("#ptab-actions"));
  };

  // ---------- tab editor ----------
  // def: { id, title, icon, tooltip, create(host) -> { dispose, focus, layout, isDirty, save } }
  W.openTab = (def) => {
    let t = W.tabs.find((x) => x.id === def.id);
    if (!t) {
      t = { ...def, host: null, inst: null };
      if (def.id === "dashboard") t.host = $("#main");
      else {
        t.host = document.createElement("div");
        t.host.className = "editor-host";
        $("#editors").append(t.host);
        t.inst = def.create?.(t.host, t) || null;
      }
      const at = W.active ? W.tabs.indexOf(W.active) + 1 : W.tabs.length;
      W.tabs.splice(at, 0, t);
    } else if (def.reveal) def.reveal(t);
    activate(t);
    persistTabs();
    return t;
  };
  W.findTab = (id) => W.tabs.find((x) => x.id === id);
  W.tabState = () => W.active;

  function activate(t) {
    W.active = t;
    for (const x of W.tabs) x.host.classList.toggle("hidden", x !== t);
    if (!W.tabs.includes(W.findTab("dashboard"))) $("#main").classList.add("hidden");
    paintTabs();
    requestAnimationFrame(() => {
      t.inst?.layout?.();
      t.inst?.focus?.();
    });
    W.emit("tab", t);
  }
  W.activate = (id) => {
    const t = W.findTab(id);
    if (t) activate(t);
  };

  W.closeTab = async (id, { force } = {}) => {
    const t = W.findTab(id);
    if (!t) return true;
    if (!force && t.inst?.isDirty?.()) {
      activate(t);
      const choice = await W.confirm3(`"${t.title}" has unsaved changes.`, "Save", "Don't save");
      if (choice === "cancel") return false;
      if (choice === "yes" && (await t.inst.save?.()) === false) return false;
    }
    const i = W.tabs.indexOf(t);
    W.tabs.splice(i, 1);
    t.inst?.dispose?.();
    if (t.id === "dashboard") t.host.classList.add("hidden");
    else t.host.remove();
    if (W.active === t) {
      const next = W.tabs[i] || W.tabs[i - 1];
      if (next) activate(next);
      else {
        W.active = null;
        paintTabs();
        showWelcome();
      }
    } else paintTabs();
    persistTabs();
    return true;
  };

  W.markDirty = () => paintTabs();
  function paintTabs() {
    $("#tabbar").innerHTML = W.tabs
      .map((t) => {
        const dirty = t.inst?.isDirty?.();
        return `<div class="tab ${t === W.active ? "active" : ""} ${dirty ? "dirty" : ""}" data-tab-id="${esc(t.id)}" title="${esc(t.tooltip || t.title)}" draggable="true">
          <span class="tab-icon">${t.icon || ""}</span><span class="tab-title">${esc(t.title)}</span>${t.badge ? `<span class="tab-badge">${esc(t.badge)}</span>` : ""}
          <button class="tab-close" data-close-tab="${esc(t.id)}" title="Close (${esc(W.keyFor("tab.close") || "")})">${dirty ? "●" : "✕"}</button></div>`;
      })
      .join("");
  }
  W.paintTabs = paintTabs;

  // Tab được khôi phục khi tải lại trang (file, diff, SQL); module đăng ký cách mở lại theo kind
  const restorers = new Map();
  W.registerRestorer = (kind, fn) => restorers.set(kind, fn);
  function persistTabs() {
    store.set(
      "tabs",
      W.tabs.filter((t) => t.persist).map((t) => ({ kind: t.persist.kind, data: t.persist.data, active: t === W.active }))
    );
  }
  W.persistTabs = persistTabs;

  function showWelcome() {
    W.openTab({ id: "dashboard", title: "Overview", icon: ICON.home });
  }

  // ---------- bố cục và kéo giãn ----------
  function applyLayout() {
    const sb = $("#sidebar");
    sb.style.width = `${layout.sidebar}px`;
    sb.classList.toggle("hidden", !layout.showSidebar);
    $('[data-sash="sidebar"]').classList.toggle("hidden", !layout.showSidebar);
    const panel = $("#panel");
    panel.style.height = layout.maxPanel ? "auto" : `${layout.panel}px`;
    panel.classList.toggle("hidden", !layout.showPanel);
    $(".editor-group").classList.toggle("hidden", Boolean(layout.maxPanel && layout.showPanel));
    panel.classList.toggle("max", Boolean(layout.maxPanel));
    $('[data-sash="panel"]').classList.toggle("hidden", !layout.showPanel || layout.maxPanel);
    const aux = $("#aux");
    aux.style.width = `${layout.aux}px`;
    aux.classList.toggle("hidden", !layout.showAux);
    $('[data-sash="aux"]').classList.toggle("hidden", !layout.showAux);
    relayout();
  }
  W.applyLayout = applyLayout;
  W.narrow = narrow;
  let relayoutRaf = 0;
  function relayout() {
    cancelAnimationFrame(relayoutRaf);
    relayoutRaf = requestAnimationFrame(() => {
      W.active?.inst?.layout?.();
      W.emit("layout");
    });
  }
  window.addEventListener("resize", relayout);

  function initSashes() {
    for (const sash of $$(".sash")) {
      sash.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const kind = sash.dataset.sash;
        const start = { x: e.clientX, y: e.clientY, sidebar: layout.sidebar, panel: layout.panel, aux: layout.aux };
        sash.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing", kind === "panel" ? "resizing-h" : "resizing-v");
        const move = (ev) => {
          if (kind === "sidebar") layout.sidebar = Math.min(700, Math.max(170, start.sidebar + ev.clientX - start.x));
          if (kind === "aux") layout.aux = Math.min(1100, Math.max(300, start.aux - (ev.clientX - start.x)));
          if (kind === "panel") layout.panel = Math.min(window.innerHeight - 160, Math.max(100, start.panel - (ev.clientY - start.y)));
          applyLayout();
        };
        const up = () => {
          sash.removeEventListener("pointermove", move);
          sash.removeEventListener("pointerup", up);
          document.body.classList.remove("resizing", "resizing-h", "resizing-v");
          saveLayout();
        };
        sash.addEventListener("pointermove", move);
        sash.addEventListener("pointerup", up);
      });
    }
  }

  // ---------- lệnh + phím tắt ----------
  // def: { id, title, key (mặc định), run(), when?() }
  W.command = (id, title, run, key, opts = {}) => W.commands.set(id, { id, title, run, key, ...opts });
  W.run = (id, ...args) => {
    const c = W.commands.get(id);
    if (!c) return toast(`Unknown command ${id}`, "error");
    return c.run(...args);
  };
  W.keyFor = (id) => {
    const user = W.ws().keybindings || {};
    if (id in user) return user[id];
    return W.commands.get(id)?.key || "";
  };

  const isMac = /Mac/.test(navigator.platform);
  // Chuẩn hoá sự kiện phím thành dạng "Ctrl+Shift+T"
  W.comboOf = (e) => {
    const k = e.key;
    if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(k)) return "";
    let key = k.length === 1 ? k.toUpperCase() : k;
    if (e.code?.startsWith("Digit")) key = e.code.slice(5);
    else if (e.code?.startsWith("Key")) key = e.code.slice(3);
    else if (e.code === "Backquote") key = "`";
    else if (e.code === "Equal") key = "=";
    else if (e.code === "Minus") key = "-";
    else if (e.code === "Comma") key = ",";
    else if (e.code === "Period") key = ".";
    else if (e.code === "Slash") key = "/";
    else if (e.code === "Backslash") key = "\\";
    else if (e.code === "BracketLeft") key = "[";
    else if (e.code === "BracketRight") key = "]";
    else if (key === " ") key = "Space";
    const parts = [];
    if (e.ctrlKey || (isMac && e.metaKey)) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey && !isMac) parts.push("Meta");
    parts.push(key);
    return parts.join("+");
  };
  const normCombo = (s) =>
    String(s || "")
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
      .join("+");

  let keyMap = new Map();
  W.rebuildKeys = () => {
    keyMap = new Map();
    for (const c of W.commands.values()) {
      for (const combo of W.keyFor(c.id).split(/\s*,\s*/).filter(Boolean)) keyMap.set(normCombo(combo), c.id);
    }
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (document.querySelector("dialog[open]") && e.key !== "Escape") return;
      const combo = W.comboOf(e);
      if (!combo) return;
      const id = keyMap.get(combo);
      if (!id) return;
      const c = W.commands.get(id);
      if (c.when && !c.when(e)) return;
      e.preventDefault();
      e.stopPropagation();
      c.run();
    },
    true
  );

  // ---------- quick pick / palette ----------
  // items: [{ label, detail, value, hint }]; trả về value hoặc chuỗi đã gõ (allowCustom)
  W.quickPick = (items, { placeholder = "", allowCustom = false, initial = "" } = {}) =>
    new Promise((resolve) => {
      const box = $("#palette");
      const input = $("#palette-input");
      const list = $("#palette-list");
      let sel = 0;
      let shown = [];
      const prev = document.activeElement;
      box.classList.remove("hidden");
      input.placeholder = placeholder;
      input.value = initial;
      const score = (text, q) => {
        if (!q) return 1;
        text = text.toLowerCase();
        let i = 0;
        let s = 0;
        for (const ch of q) {
          const j = text.indexOf(ch, i);
          if (j < 0) return 0;
          s += j === i ? 2 : 1;
          i = j + 1;
        }
        return s + (text.includes(q) ? 10 : 0);
      };
      const paint = () => {
        const q = input.value.toLowerCase().trim();
        shown = items
          .map((it) => ({ it, s: score(`${it.label} ${it.detail || ""}`, q) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 200)
          .map((x) => x.it);
        sel = Math.min(sel, Math.max(0, shown.length - 1));
        list.innerHTML =
          shown.map((it, i) => `<li class="${i === sel ? "sel" : ""}" data-i="${i}"><span class="pl">${esc(it.label)}</span><span class="pd">${esc(it.detail || "")}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}</li>`).join("") ||
          `<li class="empty">${allowCustom && q ? "Press Enter to use what you typed" : "No matches"}</li>`;
        list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
      };
      const done = (v) => {
        box.classList.add("hidden");
        input.oninput = input.onkeydown = list.onmousedown = null;
        document.removeEventListener("mousedown", outside, true);
        prev?.focus?.();
        resolve(v);
      };
      const outside = (e) => !box.contains(e.target) && done(null);
      input.oninput = () => {
        sel = 0;
        paint();
      };
      input.onkeydown = (e) => {
        if (e.key === "ArrowDown") sel = Math.min(sel + 1, shown.length - 1);
        else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
        else if (e.key === "Escape") return done(null);
        else if (e.key === "Enter") return done(shown[sel] ? shown[sel].value : allowCustom && input.value.trim() ? input.value.trim() : null);
        else return;
        e.preventDefault();
        paint();
      };
      list.onmousedown = (e) => {
        const li = e.target.closest("li[data-i]");
        if (li) {
          e.preventDefault();
          done(shown[Number(li.dataset.i)].value);
        }
      };
      document.addEventListener("mousedown", outside, true);
      paint();
      input.focus();
      input.select();
    });

  W.palette = async () => {
    const items = [...W.commands.values()].filter((c) => !c.hidden).map((c) => ({ label: c.title, detail: c.id, value: c.id, hint: W.keyFor(c.id) }));
    const id = await W.quickPick(items, { placeholder: "Type a command" });
    if (id) W.run(id);
  };

  // ---------- hộp thoại ----------
  W.prompt = (title, value = "", { label = "", mono = true } = {}) =>
    new Promise((resolve) => {
      const m = openModal(
        esc(title),
        `<form id="w-prompt"><label class="field full">${label ? `<span>${esc(label)}</span>` : ""}<input name="v" class="${mono ? "mono" : ""}" value="${esc(value)}" autocomplete="off" /></label></form>`,
        `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="w-prompt">OK</button>`
      );
      const input = $("input", m);
      input.focus();
      input.select();
      let result = null;
      $("#w-prompt", m).onsubmit = (e) => {
        e.preventDefault();
        result = input.value;
        closeModal();
      };
      m.addEventListener("close", () => resolve(result), { once: true });
    });

  // trả về "yes" | "no" | "cancel"
  W.confirm3 = (message, yes = "Save", no = "Don't save") =>
    askDialog({ title: "Unsaved changes", message, buttons: [{ id: "cancel", label: "Cancel" }, { id: "no", label: no }, { id: "yes", label: yes, cls: "primary" }] });
  W.confirm = confirmDialog;

  // ---------- menu chuột phải ----------
  // items: [{ label, run, danger, key, sep }]
  W.menu = (e, items) => {
    e.preventDefault();
    const el = $("#ctxmenu");
    el.innerHTML = items.map((it, i) => (it.sep ? `<div class="sep"></div>` : `<button data-i="${i}" class="${it.danger ? "danger" : ""}" ${it.disabled ? "disabled" : ""}><span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ""}</button>`)).join("");
    el.classList.remove("hidden");
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 4)}px`;
    el.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 4)}px`;
    const close = () => {
      el.classList.add("hidden");
      document.removeEventListener("mousedown", outside, true);
    };
    const outside = (ev) => {
      if (!el.contains(ev.target)) close();
    };
    el.onclick = (ev) => {
      const b = ev.target.closest("button[data-i]");
      if (!b) return;
      close();
      items[Number(b.dataset.i)].run?.();
    };
    setTimeout(() => document.addEventListener("mousedown", outside, true));
  };

  // ---------- status bar ----------
  const sbItems = new Map(); // id -> { side, order, html, title, cmd }
  W.status = (id, item) => {
    if (item == null) sbItems.delete(id);
    else sbItems.set(id, { order: 50, side: "left", ...sbItems.get(id), ...item });
    paintStatus();
  };
  function paintStatus() {
    for (const side of ["left", "right"]) {
      $(`#sb-${side}`).innerHTML = [...sbItems.entries()]
        .filter(([, v]) => v.side === side && v.html)
        .sort((a, b) => a[1].order - b[1].order)
        .map(([id, v]) => `<button class="sb-item ${v.cls || ""}" data-sb="${id}" ${v.cmd ? `data-cmd="${v.cmd}"` : ""} title="${esc(v.title || "")}">${v.html}</button>`)
        .join("");
    }
  }

  // ---------- Monaco ----------
  let monacoP = null;
  W.monaco = () =>
    (monacoP ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/vendor/monaco/vs/loader.js";
      s.onload = () => {
        window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
        window.require(["vs/editor/editor.main"], () => {
          defineThemes(window.monaco);
          resolve(window.monaco);
        }, reject);
      };
      s.onerror = reject;
      document.head.append(s);
    }));

  // One Dark Pro cho Monaco (cùng bảng màu với WezTerm/VS Code đang dùng)
  function defineThemes(monaco) {
    const c = { fg: "abb2bf", red: "e06c75", green: "98c379", yellow: "e5c07b", blue: "61afef", purple: "c678dd", cyan: "56b6c2", orange: "d19a66", comment: "7f848e", gray: "5c6370" };
    monaco.editor.defineTheme("one-dark-pro", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "", foreground: c.fg },
        { token: "comment", foreground: c.comment, fontStyle: "italic" },
        { token: "keyword", foreground: c.purple },
        { token: "keyword.sql", foreground: c.purple, fontStyle: "bold" },
        { token: "operator", foreground: c.cyan },
        { token: "operator.sql", foreground: c.purple },
        { token: "string", foreground: c.green },
        { token: "string.sql", foreground: c.green },
        { token: "number", foreground: c.orange },
        { token: "regexp", foreground: c.cyan },
        { token: "type", foreground: c.yellow },
        { token: "type.identifier", foreground: c.yellow },
        { token: "identifier", foreground: c.fg },
        { token: "identifier.quote", foreground: c.red },
        { token: "predefined", foreground: c.blue },
        { token: "predefined.sql", foreground: c.blue },
        { token: "variable", foreground: c.red },
        { token: "variable.predefined", foreground: c.yellow },
        { token: "constant", foreground: c.orange },
        { token: "tag", foreground: c.red },
        { token: "attribute.name", foreground: c.orange },
        { token: "attribute.value", foreground: c.green },
        { token: "delimiter", foreground: c.fg },
        { token: "delimiter.bracket", foreground: c.fg },
        { token: "key", foreground: c.red },
        { token: "string.key.json", foreground: c.red },
        { token: "string.value.json", foreground: c.green },
        { token: "function", foreground: c.blue },
      ],
      colors: {
        "editor.background": "#23272e",
        "editor.foreground": "#abb2bf",
        "editorLineNumber.foreground": "#495162",
        "editorLineNumber.activeForeground": "#abb2bf",
        "editorCursor.foreground": "#528bff",
        "editor.inactiveSelectionBackground": "#3a3f4b",
        "editor.lineHighlightBackground": "#2c313c",
        "editorIndentGuide.background1": "#3b4048",
        "editorWhitespace.foreground": "#3b4048",
        "editorGutter.background": "#23272e",
        "editorWidget.background": "#1e2227",
        "editorSuggestWidget.background": "#1e2227",
        "editorSuggestWidget.selectedBackground": "#2c313a",
        "editorHoverWidget.background": "#1e2227",
        "diffEditor.insertedTextBackground": "#98c37926",
        "diffEditor.removedTextBackground": "#e06c7526",
        "diffEditor.insertedLineBackground": "#98c3791a",
        "diffEditor.removedLineBackground": "#e06c751a",
        "scrollbarSlider.background": "#4e566680",
        "minimap.background": "#23272e",
        "editor.selectionBackground": "#67769660",
        // menu chuột phải, gợi ý, hover: nền sáng hơn editor + viền + bóng để nổi lên trên
        "menu.background": "#2c313a",
        "menu.foreground": "#d7dae0",
        "menu.border": "#4b5263",
        "menu.selectionBackground": "#528bff",
        "menu.selectionForeground": "#ffffff",
        "menu.separatorBackground": "#3e4451",
        "widget.shadow": "#000000aa",
        "editorWidget.border": "#3e4451",
        "editorSuggestWidget.border": "#3e4451",
        "editorSuggestWidget.foreground": "#d7dae0",
        "editorSuggestWidget.highlightForeground": "#61afef",
        "editorHoverWidget.border": "#3e4451",
      },
    });
    monaco.editor.defineTheme("one-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "a0a1a7", fontStyle: "italic" },
        { token: "keyword", foreground: "a626a4" },
        { token: "keyword.sql", foreground: "a626a4", fontStyle: "bold" },
        { token: "string", foreground: "50a14f" },
        { token: "number", foreground: "986801" },
        { token: "type", foreground: "c18401" },
        { token: "predefined", foreground: "4078f2" },
        { token: "identifier.quote", foreground: "e45649" },
      ],
      colors: {
        "editor.background": "#fafafa",
        "menu.background": "#ffffff",
        "menu.border": "#d1d5db",
        "menu.selectionBackground": "#2563eb",
        "menu.selectionForeground": "#ffffff",
        "widget.shadow": "#0000004d",
        "editorWidget.border": "#d1d5db",
        "editorSuggestWidget.border": "#d1d5db",
      },
    });
  }
  W.isDark = () => document.documentElement.dataset.theme === "dark";
  W.monacoTheme = () => (W.isDark() ? "one-dark-pro" : "one-light");
  document.addEventListener("dash:theme", () => {
    window.monaco?.editor.setTheme(W.monacoTheme());
    W.emit("theme");
  });

  W.langOf = (file) => {
    const ext = (file.match(/\.([^./]+)$/)?.[1] || "").toLowerCase();
    const name = W.base(file).toLowerCase();
    if (name === "dockerfile") return "dockerfile";
    if (name === "makefile") return "makefile";
    return (
      {
        js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", json: "json", md: "markdown", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
        sh: "shell", bash: "shell", zsh: "shell", yml: "yaml", yaml: "yaml", sql: "sql", go: "go", rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", rb: "ruby", lua: "lua",
        xml: "xml", svg: "xml", toml: "ini", ini: "ini", conf: "ini", env: "ini", vue: "html", svelte: "html", dart: "dart", swift: "swift", r: "r", ps1: "powershell", bat: "bat", graphql: "graphql", proto: "protobuf",
      }[ext] || "plaintext"
    );
  };

  // ---------- icon file / thư mục (Atom Material Icons, như VS Code) ----------
  // Giống cách VS Code tra icon theme: tên file → đuôi (dài nhất trước, vd. "d.ts" rồi "ts") → ngôn ngữ → mặc định.
  let icons = null;
  fetch("/icons/atom/theme.json")
    .then((r) => r.json())
    .then((t) => {
      icons = t;
      W.emit("icons");
    })
    .catch(() => {});
  W.fileIcon = (name) => {
    if (!icons) return "";
    const n = W.base(name).toLowerCase();
    const light = !W.isDark() ? icons.light : null;
    let hit = light?.fileNames[n] || icons.fileNames[n];
    const parts = n.split(".");
    for (let i = 1; !hit && i < parts.length; i++) {
      const ext = parts.slice(i).join(".");
      hit = light?.fileExtensions[ext] || icons.fileExtensions[ext];
    }
    hit ||= icons.languageIds[W.langOf(n)] || icons.file;
    return `<img class="ficon" src="/icons/atom/${hit}" alt="" draggable="false" />`;
  };
  W.folderIcon = (name, open, root) => {
    if (!icons) return "";
    const n = W.base(name).toLowerCase();
    const hit = (open ? icons.folderNamesExpanded[n] : icons.folderNames[n]) || (root ? (open ? icons.rootFolderExpanded : icons.rootFolder) : open ? icons.folderExpanded : icons.folder);
    return `<img class="ficon" src="/icons/atom/${hit}" alt="" draggable="false" />`;
  };

  // ---------- biểu tượng ----------
  const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ICON = {
    projects: svg('<path d="M12 2.8 21 7.4l-9 4.6-9-4.6z"/><path d="m3 12 9 4.6 9-4.6"/><path d="m3 16.6 9 4.6 9-4.6"/>'),
    files: svg('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M3 10.5h18"/>'),
    snippets: svg('<path d="M6.5 3h11A1.5 1.5 0 0 1 19 4.5V21l-7-3.8L5 21V4.5A1.5 1.5 0 0 1 6.5 3z"/><path d="m9 8 2.2 2.2L9 12.4M13 12.4h2.5"/>'),
    ai: svg('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4.5V8M8.5 3.5h7M2 13v3M22 13v3"/><circle cx="9" cy="14" r="1.2"/><circle cx="15" cy="14" r="1.2"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>'),
    sparkle: svg('<path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.5l-1.8-5L5 9.7l5.2-1.8z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z"/>'),
    git: svg('<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6M18 10.2c0 4-6 3-11 6"/>'),
    terminal: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>'),
    ssh: svg('<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
    db: svg('<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    claude: svg('<path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5M5.3 5.3l3.5 3.5M15.2 15.2l3.5 3.5M5.3 18.7l3.5-3.5M15.2 8.8l3.5-3.5"/>'),
    home: svg('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    diff: svg('<path d="M6 3v12M18 9v12M3 6h6M15 18h6M3 15l3 3 3-3M15 6l3-3 3 3"/>'),
    sql: svg('<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/>'),
    keys: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  };
  W.ICON = ICON;

  // ---------- lệnh khung ----------
  // Phím trùng với phím của shell (Ctrl+P lịch sử, Ctrl+B/J/K/S…) không áp dụng khi đang gõ trong terminal
  const notTerm = () => !document.activeElement?.closest?.(".xterm");
  W.notTerm = notTerm;
  function registerCoreCommands() {
    W.command("palette.show", "Show all commands", () => W.palette(), "Ctrl+Shift+P");
    W.command("file.quickOpen", "Go to file…", () => W.run("explorer.quickOpen"), "Ctrl+P", { when: notTerm });
    W.command("folder.open", "Open folder…", () => W.pickFolder(), "Ctrl+Alt+O");
    W.command("layout.toggleSidebar", "Toggle side bar", () => {
      layout.showSidebar = !layout.showSidebar;
      saveLayout();
      applyLayout();
      paintActivity();
    }, "Ctrl+B", { when: notTerm });
    W.command("layout.togglePanel", "Toggle panel", () => {
      layout.showPanel = !layout.showPanel;
      layout.maxPanel = false;
      saveLayout();
      applyLayout();
      if (layout.showPanel) W.showPanel();
    }, "Ctrl+J", { when: notTerm });
    W.command("layout.maximizePanel", "Maximize / restore panel", () => {
      layout.maxPanel = !layout.maxPanel;
      layout.showPanel = true;
      applyLayout();
      W.showPanel();
    }, "Ctrl+Alt+Enter");
    W.command("tab.close", "Close editor tab", () => W.active && W.closeTab(W.active.id), "Alt+Shift+W", { when: () => !document.activeElement?.closest?.(".xterm") });
    W.command("tab.next", "Next editor tab", () => cycleTab(1), "Ctrl+PageDown");
    W.command("tab.prev", "Previous editor tab", () => cycleTab(-1), "Ctrl+PageUp");
    W.command("tab.save", "Save", () => W.active?.inst?.save?.(), "Ctrl+S", { when: notTerm });
    W.command("view.projects", "Show Projects", () => W.showView("projects"), "Ctrl+Shift+J");
    W.command("view.overview", "Open projects overview", () => showWelcome(), "");
    W.command("theme.toggle", "Toggle light / dark theme", () => actions.theme(), "");
    W.command("project.next", "Next project tab", () => shell?.cycle(1), "Ctrl+Shift+PageDown");
    W.command("project.prev", "Previous project tab", () => shell?.cycle(-1), "Ctrl+Shift+PageUp");
    W.command("project.close", "Close project tab", () => WS_ID !== "main" && shell?.close(WS_ID), "");
    W.command("project.switch", "Switch to project…", async () => {
      const id = await W.quickPick([{ label: "Overview", detail: "all projects", value: "main" }, ...(S.config?.projects || []).map((p) => ({ label: p.name, detail: W.shortPath(p.path), value: p.id }))], { placeholder: "Open a project tab" });
      if (id) (id === "main" ? shell?.activate("main") : W.openWorkspace(id));
    }, "Ctrl+Alt+P");
    W.command("window.reload", "Reload window", () => location.reload(), "");
  }
  function cycleTab(dir) {
    if (!W.tabs.length) return;
    const i = W.tabs.indexOf(W.active);
    activate(W.tabs[(i + dir + W.tabs.length) % W.tabs.length]);
  }

  // ---------- sự kiện DOM chung ----------
  function bindDom() {
    document.addEventListener("click", (e) => {
      const c = e.target.closest("[data-cmd]");
      if (c) return W.run(c.dataset.cmd);
      const vb = e.target.closest("[data-view-btn]");
      if (vb) return W.showView(vb.dataset.viewBtn, { toggle: true });
      const close = e.target.closest("[data-close-tab]");
      if (close) {
        e.stopPropagation();
        return W.closeTab(close.dataset.closeTab);
      }
      const tab = e.target.closest("[data-tab-id]");
      if (tab) return W.activate(tab.dataset.tabId);
      const pt = e.target.closest("[data-panel]");
      if (pt) return W.showPanel(pt.dataset.panel);
    });
    $("#tabbar").addEventListener("auxclick", (e) => {
      const tab = e.target.closest("[data-tab-id]");
      if (tab && e.button === 1) W.closeTab(tab.dataset.tabId);
    });
    $("#tabbar").addEventListener("contextmenu", (e) => {
      const tab = e.target.closest("[data-tab-id]");
      if (!tab) return;
      const id = tab.dataset.tabId;
      W.menu(e, [
        { label: "Close", run: () => W.closeTab(id) },
        { label: "Close others", run: async () => { for (const t of W.tabs.filter((x) => x.id !== id)) if (!(await W.closeTab(t.id))) break; } },
        { label: "Close all", run: async () => { for (const t of [...W.tabs]) if (!(await W.closeTab(t.id))) break; } },
      ]);
    });
    // kéo thả để sắp xếp tab
    let dragId = null;
    $("#tabbar").addEventListener("dragstart", (e) => (dragId = e.target.closest("[data-tab-id]")?.dataset.tabId));
    $("#tabbar").addEventListener("dragover", (e) => e.preventDefault());
    $("#tabbar").addEventListener("drop", (e) => {
      const over = e.target.closest("[data-tab-id]")?.dataset.tabId;
      if (!dragId || !over || dragId === over) return;
      const from = W.tabs.findIndex((t) => t.id === dragId);
      const [t] = W.tabs.splice(from, 1);
      W.tabs.splice(W.tabs.findIndex((x) => x.id === over), 0, t);
      paintTabs();
      persistTabs();
    });
    $("#folder-pick").addEventListener("click", () => W.pickFolder());
    // điện thoại: chạm vào vùng editor / panel thì đóng side bar hoặc Claude đang che
    $("#center").addEventListener("pointerdown", () => {
      if (!narrow() || (!layout.showSidebar && !layout.showAux)) return;
      layout.showSidebar = layout.showAux = false;
      applyLayout();
      paintActivity();
    });
    $("#quick-open").addEventListener("click", () => W.run("file.quickOpen"));
    // Mở dự án trong dashboard thì đặt thư mục hiện tại theo dự án đó
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("beforeunload", (e) => {
      if (W.tabs.some((t) => t.inst?.isDirty?.())) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
    // Nút home của app.js mở lại tab Overview
    document.addEventListener("click", (e) => {
      const el = e.target.closest('[data-action="home"], [data-action="open-project"]');
      if (el && (el.dataset.action === "home" || el.dataset.id === WS_ID)) W.openTab({ id: "dashboard", title: "Overview", icon: ICON.home });
    }, true);
  }

  function syncFromHash() {
    const m = location.hash.match(/^#\/p\/([^/]+)/);
    const p = m && S.config?.projects.find((x) => x.id === decodeURIComponent(m[1]));
    if (p) W.setFolder(p.path);
    const dash = W.findTab("dashboard");
    if (dash) {
      dash.title = p ? p.name : "Overview";
      paintTabs();
    }
  }

  W.reloadConfig = async () => {
    await loadConfig();
    W.rebuildKeys();
    W.emit("config");
  };

  // ---------- khởi động ----------
  W.start = async () => {
    registerCoreCommands();
    W.registerView("projects", { title: "Projects", icon: ICON.projects, order: 1, key: "view.projects" });
    bindDom();
    initSashes();
    connect();
    try {
      const h = await api("GET", "/api/files/home");
      W.home = h.home;
      if (!W.folder && WS_ID === "main") W.folder = h.projectsRoot || h.home;
    } catch {}
    for (let i = 0; i < 50 && !S.config; i++) await new Promise((r) => setTimeout(r, 100));
    const wsProject = WS_ID !== "main" && S.config?.projects.find((p) => p.id === WS_ID);
    if (wsProject) {
      if (!W.folder) W.folder = wsProject.path;
      document.title = `${wsProject.name} — Dash`;
      shell?.setTitle(window, document.title);
      if (!location.hash.startsWith("#/p/")) location.hash = `#/p/${encodeURIComponent(WS_ID)}/commands`;
    } else if (!W.folder) W.folder = W.home;
    if (shell) {
      shell.subscribe(window, paintWorkspaceTabs);
      $("#ws-tabs").addEventListener("click", (e) => {
        const x = e.target.closest("[data-ws-close]");
        if (x) return shell.close(x.dataset.wsClose);
        const t = e.target.closest("[data-ws]");
        if (t) shell.activate(t.dataset.ws);
      });
      $("#ws-tabs").addEventListener("auxclick", (e) => {
        const t = e.target.closest("[data-ws]");
        if (t && e.button === 1 && t.dataset.ws !== "main") shell.close(t.dataset.ws);
      });
    }
    W.rebuildKeys();
    paintFolder();
    applyLayout();
    const sidebarWanted = layout.showSidebar;
    W.showView(layout.view);
    if (!sidebarWanted) {
      layout.showSidebar = false;
      applyLayout();
    }
    if (!layout.showSidebar) $$("#sidebar .view").forEach((x) => x.classList.toggle("hidden", x.dataset.view !== layout.view));
    paintActivity();
    // dựng sẵn nội dung panel nhưng giữ nó ẩn (terminal mặc định ẩn)
    W.showPanel(layout.panelTab);
    layout.showPanel = false;
    saveLayout();
    applyLayout();
    W.openTab({ id: "dashboard", title: "Overview", icon: ICON.home });
    syncFromHash();
    // Mở lại các tab của phiên trước
    const saved = store.get("tabs", []);
    let activeTab = null;
    for (const t of saved) {
      const fn = restorers.get(t.kind);
      if (!fn) continue;
      try {
        const tab = await fn(t.data);
        if (t.active) activeTab = tab;
      } catch {}
    }
    if (activeTab) activate(activeTab);
    W.emit("ready");
  };

  return W;
})();
window.W = W; // app.js (nạp trước) truy cập qua window.W

// Chuyển màu ANSI (SGR 16/256/truecolor, đậm, nghiêng, gạch chân) sang HTML; bỏ các mã điều khiển khác.
// Xử lý "\r" như terminal: chỉ giữ phần sau lần về đầu dòng cuối cùng.
function ansiToHtml(text, { lineClass } = {}) {
  const pal256 = (n) => {
    if (n < 16) return `var(--ansi-${n})`;
    if (n >= 232) {
      const v = 8 + (n - 232) * 10;
      return `rgb(${v},${v},${v})`;
    }
    n -= 16;
    const c = (x) => (x ? x * 40 + 55 : 0);
    return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
  };
  const st = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
  const reset = () => Object.assign(st, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
  const sgr = (codes) => {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) reset();
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 22) st.bold = st.dim = false;
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false;
      else if (c >= 30 && c <= 37) st.fg = `var(--ansi-${c - 30})`;
      else if (c >= 90 && c <= 97) st.fg = `var(--ansi-${c - 82})`;
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = `var(--ansi-${c - 40})`;
      else if (c >= 100 && c <= 107) st.bg = `var(--ansi-${c - 92})`;
      else if (c === 49) st.bg = null;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        st[c === 38 ? "fg" : "bg"] = pal256(codes[i + 2] || 0);
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        st[c === 38 ? "fg" : "bg"] = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`;
        i += 4;
      }
    }
  };
  const style = () => {
    const fg = st.inverse ? st.bg || "var(--log-bg)" : st.fg;
    const bg = st.inverse ? st.fg || "var(--text)" : st.bg;
    const s = [fg && `color:${fg}`, bg && `background:${bg}`, st.bold && "font-weight:700", st.dim && "opacity:.65", st.italic && "font-style:italic", st.underline && "text-decoration:underline"].filter(Boolean).join(";");
    return s;
  };
  const re = /\x1b\[([0-9;?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]|[\x00-\x08\x0b-\x1f]/g;
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((raw) => {
      const cut = raw.replace(/\r+$/, "");
      const line = cut.includes("\r") ? cut.slice(cut.lastIndexOf("\r") + 1) : cut;
      let out = "";
      let last = 0;
      let m;
      const flush = (s) => {
        if (!s) return;
        const css = style();
        out += css ? `<span style="${css}">${esc(s)}</span>` : esc(s);
      };
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        flush(line.slice(last, m.index));
        last = re.lastIndex;
        if (m[2] === "m") sgr((m[1] || "0").split(";").map((x) => Number(x) || 0));
      }
      flush(line.slice(last));
      const cls = lineClass?.(line.replace(re, ""));
      return cls ? `<span class="${cls}">${out}</span>` : out;
    })
    .join("\n");
}
