"use strict";
// Giao diện điện thoại (dọc và ngang). Mỗi lúc chỉ hiện một vùng chiếm hết màn hình: Terminal, Claude hoặc vùng editor
// (các tab file đang mở). Terminal và Claude chuyển bằng thanh điều hướng (dưới đáy khi dọc, cột bên trái khi ngang);
// vùng editor tự hiện khi mở file từ view Browse Files / Explorer. Mọi chức năng khác (dự án, thư mục, Explorer, Git, Database, SSH, History, Settings…) nằm trong ngăn Menu.
// Title bar, activity bar và status bar bị ẩn.
// Vùng đang hiện suy ra từ W.layout (showAux → Claude, showPanel → Terminal, còn lại → editor), không lưu trạng thái riêng.
(() => {
  const nav = $("#mnav");
  const drawer = $("#mdrawer");
  const L = W.layout;
  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const IC = {
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    split: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
    splitDown: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>'),
    resume: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    grid: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
    moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    back: svg('<path d="m15 5-7 7 7 7"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    panel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/>'),
    cmd: svg('<path d="m7 8 4 4-4 4M13 16h4"/><rect x="3" y="3" width="18" height="18" rx="3"/>'),
    edit: svg('<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  };
  let claudeBadge = false;
  let ready = false;

  const mode = () => (L.showAux ? "claude" : L.showPanel ? "terminal" : "editor");

  // ---------- chuyển vùng ----------
  function go(m, { create = true } = {}) {
    L.showSidebar = false;
    if (m === "claude") {
      if (!L.showAux) W.run("claude.toggle");
      else W.applyLayout();
    } else if (m === "terminal") {
      L.showAux = false;
      W.showPanel("terminal");
      if (create && !W.term.focusedPane()) W.term.create();
    } else {
      L.showAux = false;
      L.showPanel = false;
      W.applyLayout();
    }
    store.set("mobileMode", m);
    W.paintActivity();
  }

  // Mục ghim trên thanh điều hướng (Terminal, Claude, view bất kỳ), theo thứ tự dùng chung với activity bar của PC
  const MAX_PINS = 5;
  const pinnedIds = () => String(W.ws().mobileNav ?? "terminal,claude").split(",").filter(Boolean);
  const pinned = () => W.navItems().filter((x) => pinnedIds().includes(x.id));

  function paintNav() {
    const items = pinned();
    // view ghim đang mở (side bar phủ lên) thì sáng mục đó; còn lại sáng vùng đang hiện bên dưới
    const cur = L.showSidebar && items.some((x) => x.id === L.view) ? L.view : mode();
    const item = (id, icon, label, extra = "") =>
      `<button class="mnav-item ${cur === id && id !== "menu" ? "active" : ""}" data-mnav="${id}" title="${esc(label)}">${icon}<span>${esc(label)}</span>${extra}</button>`;
    nav.innerHTML =
      item("menu", IC.menu, "Menu") +
      items.map((x) => item(x.id, x.icon, x.title, x.id === "claude" && claudeBadge ? `<i class="mnav-dot"></i>` : x.badge ? `<i class="mnav-dot"></i>` : "")).join("");
  }

  // Theo dõi bố cục: tô thanh điều hướng, gắn nút quay lại vào đầu mỗi view của side bar
  function sync() {
    if (!W.narrow()) return;
    if (L.showAux) claudeBadge = false;
    document.documentElement.dataset.mpanel = L.showPanel ? L.panelTab : "";
    for (const head of $$("#sidebar .view-head")) {
      if (!$(".m-back", head)) head.insertAdjacentHTML("afterbegin", `<button class="icon m-back" data-m="side-close" title="Back">${IC.back}</button>`);
    }
    paintNav();
  }

  nav.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mnav]");
    if (!b) return;
    const id = b.dataset.mnav;
    if (id === "menu") return openDrawer();
    if (id === "terminal" || id === "claude") return go(id);
    W.showView(id, { toggle: true });
    paintNav();
  });

  // ---------- ngăn Menu ----------
  const row = (attr, icon, label, { hint = "", active = false, extra = "" } = {}) =>
    `<div class="md-row ${active ? "active" : ""}"><button class="md-main" ${attr}><span class="md-ic">${icon}</span><span class="md-label">${esc(label)}</span>${hint ? `<span class="md-hint">${esc(hint)}</span>` : ""}</button>${extra}</div>`;
  // action: nút nhỏ bên phải tiêu đề mục (vd. sửa thanh điều hướng cạnh "Views")
  const section = (title, body, action = "") =>
    body ? `<div class="md-sec"><div class="md-sec-title">${esc(title)}${action}</div>${body}</div>` : "";
  const has = (id) => W.commands.has(id);
  const cmdRow = (id, icon, label, opts) => (has(id) ? row(`data-m="cmd" data-id="${id}"`, icon, label, opts) : "");

  function drawerHtml() {
    const projects = S.config?.projects || [];
    const me = projects.find((p) => p.id === W.wsId);
    const st = W.shell?.state();
    const tabs = st
      ? st.tabs
          .map((id) => {
            const p = projects.find((x) => x.id === id);
            const icon = id === "main" ? W.ICON.home : `<span class="dot ${p && runningCount(p) ? "on" : ""}"></span>`;
            const close = id === "main" ? "" : `<button class="icon md-x" data-m="ws-close" data-id="${esc(id)}" title="Close project tab">${IC.close}</button>`;
            return row(`data-m="ws" data-id="${esc(id)}"`, icon, id === "main" ? "Overview" : p?.name || id, { active: id === st.active, extra: close });
          })
          .join("") + cmdRow("project.switch", IC.plus, "Open project…")
      : "";
    const views = W.navItems().filter((x) => W.views.has(x.id));
    const bottom = [...W.views.values()].filter((v) => v.bottom).sort((a, b) => a.order - b.order);
    const panels = [...W.panels.values()].filter((p) => p.id !== "terminal").sort((a, b) => a.order - b.order);
    // giá coin không hiện trên điện thoại
    const status = $$("#sb-left .sb-item, #sb-right .sb-item")
      .filter((x) => x.dataset.sb !== "crypto")
      .map((x) => x.outerHTML)
      .join("");
    return `<div class="md-head">
        <span class="brand-mark">›_</span>
        <div class="md-title"><b>${esc(me?.name || "Dash")}</b><span>${esc(W.shortPath(W.folder) || "")}</span></div>
        <button class="icon" data-m="close" title="Close">${IC.close}</button>
      </div>
      <div class="md-body">
        <div class="md-search">
          <button data-m="cmd" data-id="file.quickOpen">${W.ICON.search}<span>Go to file…</span></button>
          <button data-m="cmd" data-id="palette.show" title="All commands">${IC.cmd}<span>Commands</span></button>
        </div>
        ${section("Project tabs", tabs)}
        ${section("Folder", row(`data-m="folder"`, W.ICON.files, W.shortPath(W.folder) || "Open folder…", { hint: "Change" }))}
        ${section("Views", views.map((v) => row(`data-m="view" data-id="${esc(v.id)}"`, v.icon, v.title, { hint: v.badge || "" })).join(""), `<button class="icon md-sec-act" data-m="nav-edit" title="Edit nav bar: pin and reorder">${IC.edit}</button>`)}
        ${section("Panels", panels.map((p) => row(`data-m="panel" data-id="${esc(p.id)}"`, IC.panel, p.title, { hint: p.badge || "", active: L.showPanel && L.panelTab === p.id && !L.showAux })).join(""))}
        ${section(
          "Terminal",
          cmdRow("terminal.new", IC.plus, "New terminal") +
            cmdRow("terminal.ssh", W.ICON.ssh, "Connect SSH…") +
            cmdRow("terminal.splitRight", IC.split, "Split right") +
            cmdRow("terminal.splitDown", IC.splitDown, "Split down") +
            cmdRow("terminal.toggleKeys", W.ICON.keys, "Extra keys", { hint: store.get("termKeys", W.touch()) ? "On" : "Off" })
        )}
        ${section("Claude", cmdRow("claude.new", IC.plus, "New conversation") + cmdRow("claude.resume", IC.resume, "Resume conversation…") + cmdRow("claude.manager", IC.grid, "Claude Manager") + cmdRow("claude.insights", IC.chart, "Claude Insights"))}
        ${status.trim() ? `<div class="md-sec"><div class="md-sec-title">Status</div><div class="md-status">${status}</div></div>` : ""}
      </div>
      <div class="md-foot">
        <button data-m="theme" title="${W.isDark() ? "Switch to light theme" : "Switch to dark theme"}">${W.isDark() ? IC.sun : IC.moon}<span>Theme</span></button>
        ${bottom.map((v) => `<button data-m="view" data-id="${esc(v.id)}" title="${esc(v.title)}">${v.icon}<span>${esc(v.title)}</span></button>`).join("")}
      </div>`;
  }

  // Sửa thanh điều hướng: ghim / bỏ ghim từng mục, đưa lên / xuống (thứ tự này cũng là thứ tự activity bar trên PC)
  function editHtml() {
    const items = W.navItems();
    const pins = pinnedIds();
    const full = pins.length >= MAX_PINS;
    const body = items
      .map((x, i) => {
        const on = pins.includes(x.id);
        const pin = `<button class="icon md-pin ${on ? "on" : ""}" data-m="nav-pin" data-id="${esc(x.id)}" ${!on && full ? "disabled" : ""} title="${on ? "Unpin from nav bar" : "Pin to nav bar"}">${on ? "★" : "☆"}</button>`;
        const up = `<button class="icon md-mv" data-m="nav-up" data-id="${esc(x.id)}" ${i ? "" : "disabled"} title="Move up">↑</button>`;
        const down = `<button class="icon md-mv" data-m="nav-down" data-id="${esc(x.id)}" ${i < items.length - 1 ? "" : "disabled"} title="Move down">↓</button>`;
        return `<div class="md-row ${on ? "pinned" : ""}"><div class="md-main"><span class="md-ic">${x.icon}</span><span class="md-label">${esc(x.title)}</span></div>${pin}${up}${down}</div>`;
      })
      .join("");
    return `<div class="md-head">
        <button class="icon" data-m="nav-done" title="Back">${IC.back}</button>
        <div class="md-title"><b>Edit nav bar</b><span>★ = on the nav bar (max ${MAX_PINS})</span></div>
        <button class="icon" data-m="close" title="Close">${IC.close}</button>
      </div>
      <div class="md-body md-edit">
        <div class="md-edit-note">The order is shared with the activity bar on desktop.</div>
        ${body}
        ${row(`data-m="nav-reset"`, IC.resume, "Reset to default")}
      </div>`;
  }

  let editing = false;
  function openDrawer({ edit = false } = {}) {
    editing = edit;
    $(".md-panel", drawer).innerHTML = edit ? editHtml() : drawerHtml();
    drawer.classList.add("open");
  }
  W.on("nav", () => {
    if (!W.narrow()) return;
    paintNav();
    if (editing && drawer.classList.contains("open")) $(".md-panel", drawer).innerHTML = editHtml();
  });
  function navEdit(m, id) {
    if (m === "nav-done") return openDrawer();
    if (m === "nav-reset") return W.saveNav({ navOrder: "", mobileNav: "terminal,claude" });
    if (m === "nav-pin") {
      const pins = pinnedIds();
      const next = pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id].slice(0, MAX_PINS);
      return W.saveNav({ mobileNav: next.join(",") });
    }
    const ids = W.navItems().map((x) => x.id);
    const i = ids.indexOf(id);
    if (m === "nav-up" && i > 0) W.moveNav(id, ids[i - 1]);
    if (m === "nav-down" && i >= 0 && i < ids.length - 1) W.moveNav(id, ids[i + 1], true);
  }
  const closeDrawer = () => drawer.classList.remove("open");
  W.mobileMenu = openDrawer;

  drawer.addEventListener("click", (e) => {
    // nút trong mục Status mang data-cmd, core.js tự chạy; chỉ cần đóng ngăn
    if (e.target.closest(".md-status [data-cmd]")) return closeDrawer();
    const b = e.target.closest("[data-m]");
    if (!b) return;
    const { m, id } = b.dataset;
    if (m === "ws-close") return W.shell?.close(id).then(() => drawer.classList.contains("open") && openDrawer());
    if (m === "nav-edit") return openDrawer({ edit: true });
    if (m.startsWith("nav-")) return navEdit(m, id);
    closeDrawer();
    if (m === "cmd") {
      // lệnh của terminal / Claude cần vùng tương ứng đang hiện
      if (id.startsWith("terminal.") && id !== "terminal.toggleKeys") go("terminal", { create: false });
      W.run(id);
    } else if (m === "ws") W.shell?.activate(id);
    else if (m === "folder") W.pickFolder();
    else if (m === "view") W.showView(id);
    else if (m === "panel") {
      L.showAux = false;
      W.showPanel(id);
    } else if (m === "theme") W.run("theme.toggle");
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && drawer.classList.contains("open") && closeDrawer());

  // Chọn file để mở: view Browse Files (duyệt mọi thư mục) nếu có, không thì Explorer; mở file xong tự chuyển sang vùng editor
  // (xem W.on("tab") bên dưới)
  const pickFile = () => W.showView(W.views.has("files") ? "files" : "explorer");
  $("#m-open").addEventListener("click", pickFile);

  // Nút quay lại ở đầu view của side bar
  $("#sidebar").addEventListener("click", (e) => {
    if (!e.target.closest('[data-m="side-close"]')) return;
    L.showSidebar = false;
    W.applyLayout();
    W.paintActivity();
  });

  // Mở file / diff / bảng (từ Explorer, Git, Search, Claude…) thì chuyển sang vùng editor để thấy ngay
  W.on("tab", (t) => {
    if (!ready || !t || !W.narrow()) return;
    if (L.showSidebar || L.showAux || L.showPanel) go("editor");
    else paintNav();
  });
  W.on("layout", sync);
  W.on("badge", ({ id, text }) => {
    if (id !== "claude") return;
    claudeBadge = Boolean(text) && !L.showAux;
    if (W.narrow()) paintNav();
  });
  // Quay ngang / dọc, hoặc cửa sổ đổi cỡ qua ngưỡng: đặt lại class, vẽ lại; rời giao diện điện thoại thì đóng ngăn Menu
  const recheck = () => {
    if (!window.dashMobileMode()) return;
    if (!W.narrow()) closeDrawer();
    W.applyLayout();
  };
  window.addEventListener("resize", recheck);
  // Bàn phím ảo đang mở (khung cao dưới 80% mức cao nhất từng thấy ở cùng bề ngang): ẩn thanh điều hướng và dòng
  // hạn mức Claude để chỗ cho terminal / khung chat; đóng bàn phím là hiện lại
  const tallest = {};
  const kbCheck = () => {
    tallest[innerWidth] = Math.max(tallest[innerWidth] || 0, innerHeight);
    document.documentElement.classList.toggle("m-kb", W.narrow() && W.touch() && innerHeight < tallest[innerWidth] * 0.8);
  };
  window.addEventListener("resize", kbCheck);
  kbCheck();
  screen.orientation?.addEventListener("change", recheck);
  window.addEventListener("orientationchange", recheck);

  // Trang mở trực tiếp (không qua shell.html) trên iOS: bàn phím ảo không thu nhỏ trang, tự co theo vùng còn thấy
  if (window.parent === window && W.touch() && window.visualViewport) {
    const vv = window.visualViewport;
    const fit = () => document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    vv.addEventListener("resize", fit);
    fit();
  }

  W.on("ready", () => {
    ready = true;
    if (!W.narrow()) return;
    // mở lại đúng vùng lần trước dùng trên điện thoại (không tự tạo terminal mới)
    const m = store.get("mobileMode", "terminal");
    if (m !== mode()) go(m, { create: false });
    sync();
  });
})();
