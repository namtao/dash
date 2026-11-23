"use strict";
// Lịch sử lệnh terminal theo thư mục. Mặc định lọc theo thư mục hiện tại (kèm thư mục con);
// có thể xem đúng thư mục hoặc toàn bộ. Bấm một lệnh để gõ vào terminal, ▶ để chạy ngay.
(() => {
  const st = { scope: store.get("histScope", "tree"), q: "", rows: [], dir: "", unique: store.get("histUnique", true) };
  let root = null;
  let timer = 0;

  const scopeLabel = { dir: "This folder", tree: "Folder + subfolders", all: "Everywhere" };

  async function load() {
    st.dir = W.folder;
    try {
      st.rows = await api("GET", `/api/history?cwd=${encodeURIComponent(st.dir)}&scope=${st.scope}&q=${encodeURIComponent(st.q)}&unique=${st.unique ? 1 : 0}&limit=500`);
    } catch (e) {
      st.rows = [];
      toast(e.message, "error");
    }
    paint();
  }

  const when = (t) => {
    const d = new Date(t);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
  };

  function paint() {
    if (!root) return;
    $(".hist-scope", root).innerHTML = Object.entries(scopeLabel)
      .map(([k, v]) => `<button class="seg ${st.scope === k ? "on" : ""}" data-scope="${k}">${v}</button>`)
      .join("");
    $(".hist-where", root).textContent = st.scope === "all" ? `${st.rows.length} commands` : `${W.shortPath(st.dir)} · ${st.rows.length} commands`;
    $(".hist-list", root).innerHTML =
      st.rows
        .map(
          (r, i) => `<div class="hist-row" data-i="${i}" title="${esc(r.cmd)}\n${esc(W.shortPath(r.cwd))} · ${new Date(r.at).toLocaleString("en-GB")}${r.count > 1 ? ` · run ${r.count}×` : ""}">
          <span class="hist-exit ${r.exit ? "bad" : ""}">${r.exit ? "✕" : "✓"}</span>
          <code class="hist-cmd">${highlight(r.cmd)}</code>
          ${st.scope !== "dir" && r.cwd !== st.dir ? `<span class="hist-cwd">${esc(st.scope === "all" ? W.shortPath(r.cwd) : r.cwd.slice(st.dir.length + 1))}</span>` : ""}
          ${r.count > 1 ? `<span class="hist-count">${r.count}×</span>` : ""}
          <span class="hist-time">${when(r.at)}</span>
          <button class="icon" data-run="${i}" title="Run now">▶</button></div>`
        )
        .join("") || `<div class="empty">No commands yet. Commands typed in Dash terminals are recorded per folder.</div>`;
  }

  // Tô màu dòng lệnh kiểu zsh-syntax-highlighting: lệnh, cờ, chuỗi, toán tử
  function highlight(cmd) {
    let first = true;
    return cmd
      .split(/(\s+|'[^']*'|"[^"]*"|&&|\|\||[|;])/)
      .map((tok) => {
        if (!tok) return "";
        if (/^\s+$/.test(tok)) return tok;
        if (/^(&&|\|\||[|;])$/.test(tok)) {
          first = true;
          return `<span class="sh-op">${esc(tok)}</span>`;
        }
        if (/^['"]/.test(tok)) return `<span class="sh-str">${esc(tok)}</span>`;
        if (first && !/^\w+=/.test(tok)) {
          first = false;
          return `<span class="sh-cmd">${esc(tok)}</span>`;
        }
        if (/^-/.test(tok)) return `<span class="sh-flag">${esc(tok)}</span>`;
        if (/^\$/.test(tok)) return `<span class="sh-var">${esc(tok)}</span>`;
        return esc(tok);
      })
      .join("");
  }
  W.highlightShell = highlight;

  function mount(el) {
    root = el;
    el.innerHTML = `<div class="hist">
      <div class="hist-bar"><div class="hist-scope segs"></div>
        <input class="hist-q" type="search" placeholder="Search commands…" />
        <label class="check"><input type="checkbox" class="hist-unique" ${st.unique ? "checked" : ""}/> Unique</label>
        <span class="hist-where faint"></span></div>
      <div class="hist-list"></div></div>`;
    el.addEventListener("click", (e) => {
      const sc = e.target.closest("[data-scope]");
      if (sc) {
        st.scope = sc.dataset.scope;
        store.set("histScope", st.scope);
        return load();
      }
      const run = e.target.closest("[data-run]");
      const row = e.target.closest(".hist-row");
      if (run) return W.term.insert(st.rows[Number(run.dataset.run)].cmd, { run: true });
      if (row) W.term.insert(st.rows[Number(row.dataset.i)].cmd);
    });
    el.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".hist-row");
      if (!row) return;
      const r = st.rows[Number(row.dataset.i)];
      W.menu(e, [
        { label: "Insert into terminal", run: () => W.term.insert(r.cmd) },
        { label: "Run in terminal", run: () => W.term.insert(r.cmd, { run: true }) },
        { label: "Run in a new terminal at its folder", run: async () => { await W.term.create({ cwd: r.cwd }); setTimeout(() => W.term.insert(r.cmd, { run: true }), 700); } },
        { label: "Copy", run: () => navigator.clipboard?.writeText(r.cmd) },
        { label: "Open its folder", run: () => W.setFolder(r.cwd) },
        { sep: true },
        { label: "Delete from history", danger: true, run: async () => { await api("DELETE", "/api/history", { cmd: r.cmd, cwd: st.scope === "all" ? "" : r.cwd }); load(); } },
      ]);
    });
    $(".hist-q", el).addEventListener("input", (e) => {
      st.q = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(load, 200);
    });
    $(".hist-unique", el).addEventListener("change", (e) => {
      st.unique = e.target.checked;
      store.set("histUnique", st.unique);
      load();
    });
    load();
  }

  // Chọn nhanh một lệnh trong lịch sử (giống bấm mũi tên lên nhưng xem được toàn bộ)
  async function pick(all) {
    const rows = await api("GET", `/api/history?cwd=${encodeURIComponent(W.folder)}&scope=${all ? "all" : "tree"}&limit=1000`).catch(() => []);
    const cmd = await W.quickPick(
      rows.map((r) => ({ label: r.cmd, detail: `${W.shortPath(r.cwd)}${r.count > 1 ? ` · ${r.count}×` : ""}`, value: r.cmd })),
      { placeholder: all ? "History from every folder" : `History of ${W.shortPath(W.folder)} (Enter inserts into terminal)` }
    );
    if (cmd) W.term.insert(cmd);
  }

  W.registerPanel("history", { title: "History", order: 2, mount, show: () => W.folder !== st.dir && load() });
  W.command("history.pick", "History: pick a command from this folder", () => pick(false), "Alt+R");
  W.command("history.pickAll", "History: pick a command from all folders", () => pick(true), "Alt+Shift+R");
  W.command("history.show", "History: show panel", () => W.showPanel("history"), "Alt+H");
  W.on("folder", () => root && !$(".panel-view[data-panel-view=history]")?.classList.contains("hidden") && load());
  W.onMsg("term.history", () => {
    if (!root) return;
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  });
})();
