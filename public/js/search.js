"use strict";
// Search (như VS Code): tìm nội dung trong thư mục hiện tại, tuỳ chọn Match case / Whole word / Regex, lọc file
// include / exclude, xem trước và thay thế (một kết quả, một file, tất cả). Server dùng rg → git grep → grep.
(() => {
  const DEF = { query: "", replace: "", include: "", exclude: "", caseSensitive: false, wholeWord: false, regex: false, useIgnore: true, showReplace: false, showDetails: false };
  const st = { ...DEF, ...store.get("searchState", {}) };
  const save = () => store.set("searchState", st);
  const join = (a, b) => `${a.replace(/\/+$/, "")}/${b}`;
  let body = null;
  let res = null; // { root, files: [{ path, matches, collapsed }], total, truncated }
  let selKey = ""; // "f:<file>" hoặc "m:<file>:<match>"
  let seq = 0;
  let timer = 0;
  let ctrl = null;

  const OPTS = [
    ["caseSensitive", "Aa", "Match case (Alt+C)"],
    ["wholeWord", "<u>ab</u>", "Match whole word (Alt+W)"],
    ["regex", ".*", "Use regular expression (Alt+R)"],
  ];

  function mount(el, actions) {
    body = el;
    actions.innerHTML = `<button class="icon" data-s="refresh" title="Refresh">↻</button><button class="icon" data-s="clear" title="Clear search results">✕</button><button class="icon" data-s="collapse" title="Collapse / expand all">⊟</button>`;
    el.innerHTML = `<div class="srch">
        <div class="srch-form">
          <button class="srch-twisty" data-s="toggle-replace" title="Toggle replace"></button>
          <div class="srch-fields">
            <div class="srch-box"><input class="srch-q" placeholder="Search" spellcheck="false" autocomplete="off" />
              <span class="srch-opts">${OPTS.map(([k, label, title]) => `<button class="srch-opt" data-opt="${k}" title="${title}">${label}</button>`).join("")}</span></div>
            <div class="srch-box srch-rep"><input class="srch-r" placeholder="Replace" spellcheck="false" autocomplete="off" />
              <span class="srch-opts"><button class="srch-opt" data-s="replace-all" title="Replace all (Ctrl+Alt+Enter)">⇄</button></span></div>
          </div>
        </div>
        <div class="srch-more"><button class="icon" data-s="toggle-details" title="Toggle search details">⋯</button></div>
        <div class="srch-details">
          <label>files to include<div class="srch-box"><input class="srch-inc" placeholder="e.g. *.ts, src/**/include" spellcheck="false" autocomplete="off" /></div></label>
          <label>files to exclude<div class="srch-box"><input class="srch-exc" placeholder="e.g. *.min.js, dist" spellcheck="false" autocomplete="off" />
            <span class="srch-opts"><button class="srch-opt" data-opt="useIgnore" title="Use ignore files (.gitignore) and skip node_modules">⚙</button></span></div></label>
        </div>
        <div class="srch-msg"></div>
        <div class="srch-results" tabindex="0"></div>
      </div>`;
    const q = $(".srch-q", el);
    const r = $(".srch-r", el);
    const inc = $(".srch-inc", el);
    const exc = $(".srch-exc", el);
    q.value = st.query;
    r.value = st.replace;
    inc.value = st.include;
    exc.value = st.exclude;
    const bind = (input, key) =>
      input.addEventListener("input", () => {
        st[key] = input.value;
        save();
        schedule();
      });
    bind(q, "query");
    bind(r, "replace");
    bind(inc, "include");
    bind(exc, "exclude");
    el.addEventListener("keydown", (e) => {
      const k = e.altKey && !e.ctrlKey && { KeyC: "caseSensitive", KeyW: "wholeWord", KeyR: "regex" }[e.code];
      if (k) {
        e.preventDefault();
        return toggleOpt(k);
      }
      if (e.target.matches?.(".srch-r") && e.key === "Enter" && e.ctrlKey && e.altKey) {
        e.preventDefault();
        return replaceAll();
      }
      if (e.target.matches?.(".srch-form input, .srch-details input")) {
        if (e.key === "Enter") {
          e.preventDefault();
          run();
        } else if (e.key === "ArrowDown" && e.target === q && res?.files.length) {
          e.preventDefault();
          $(".srch-results", el).focus();
          if (!selKey) select(rows()[0]?.dataset.k);
        }
      }
    });
    el.addEventListener("click", onClick);
    el.addEventListener("contextmenu", onMenu);
    $(".srch-results", el).addEventListener("keydown", onResultKey);
    paintForm();
    paint();
  }

  function paintForm() {
    if (!body) return;
    for (const b of $$("[data-opt]", body)) b.classList.toggle("on", Boolean(st[b.dataset.opt]));
    $(".srch", body).classList.toggle("with-replace", st.showReplace);
    $(".srch", body).classList.toggle("with-details", st.showDetails);
    $(".srch-twisty", body).textContent = st.showReplace ? "▾" : "▸";
  }

  function toggleOpt(k) {
    st[k] = !st[k];
    save();
    paintForm();
    run();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  }

  async function run() {
    clearTimeout(timer);
    const my = ++seq;
    ctrl?.abort();
    ctrl = null;
    if (!st.query) {
      res = null;
      return paint();
    }
    if (!W.folder) return paint("Open a folder to search in it.");
    paint(`<span class="spinner"></span> Searching…`, true);
    ctrl = new AbortController();
    try {
      const r = await fetch("/api/files/search", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "X-Dash": "1" },
        body: JSON.stringify({ root: W.folder, query: st.query, regex: st.regex, caseSensitive: st.caseSensitive, wholeWord: st.wholeWord, include: st.include, exclude: st.exclude, noIgnore: !st.useIgnore, ...(st.showReplace ? { replace: st.replace } : {}) }),
      });
      const data = await r.json().catch(() => ({}));
      if (my !== seq) return;
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const keep = new Set((res?.root === data.root ? res.files : []).filter((f) => f.collapsed).map((f) => f.path));
      res = { ...data, files: data.files.map((f) => ({ ...f, collapsed: keep.has(f.path) })) };
      paint();
    } catch (e) {
      if (my !== seq || e.name === "AbortError") return;
      res = null;
      paint(`<span class="srch-err">${esc(e.message)}</span>`);
    }
  }

  const count = () => (res ? res.files.reduce((n, f) => n + f.matches.length, 0) : 0);

  function summary() {
    if (!res) return "";
    const n = count();
    if (!n) return "No results found. Review your include / exclude patterns and .gitignore files.";
    const files = res.files.length;
    return `${n.toLocaleString()} result${n === 1 ? "" : "s"} in ${files.toLocaleString()} file${files === 1 ? "" : "s"}${res.truncated ? " (search stopped early: too many results, narrow it down)" : ""}`;
  }

  // msg: thông báo thay cho dòng tổng kết; busy: giữ kết quả cũ trong lúc tìm lại
  function paint(msg, busy) {
    if (!body) return;
    $(".srch-msg", body).innerHTML = msg || esc(summary());
    W.setBadge("search", res && count() ? String(Math.min(count(), 9999)) : "");
    if (busy) return;
    const box = $(".srch-results", body);
    if (!res || msg) {
      box.innerHTML = "";
      return;
    }
    const showRep = st.showReplace;
    let html = "";
    res.files.forEach((f, fi) => {
      const slash = f.path.lastIndexOf("/");
      const fk = `f:${fi}`;
      html += `<div class="srch-row srch-file ${selKey === fk ? "sel" : ""}" data-k="${fk}" title="${esc(f.path)}">
        <span class="twisty">${f.collapsed ? "▸" : "▾"}</span>${W.fileIcon(f.path)}<span class="fname">${esc(f.path.slice(slash + 1))}</span><span class="fdir">${esc(slash > 0 ? f.path.slice(0, slash) : "")}</span>
        <span class="srch-actions">${showRep ? `<button class="icon" data-s="replace-file" title="Replace all in this file">⇄</button>` : ""}<button class="icon" data-s="dismiss" title="Dismiss">✕</button></span>
        <span class="srch-count">${f.matches.length}</span></div>`;
      if (f.collapsed) return;
      f.matches.forEach((m, mi) => {
        const k = `m:${fi}:${mi}`;
        const hit = !m.len ? "" : showRep ? `<del>${esc(m.match)}</del><ins>${esc((m.sub ?? st.replace).replace(/\n/g, "⏎"))}</ins>` : `<mark>${esc(m.match)}</mark>`;
        html += `<div class="srch-row srch-match ${selKey === k ? "sel" : ""}" data-k="${k}" title="Line ${m.line}">
          <span class="srch-line">${esc(m.pre)}${hit}${esc(m.post)}</span>
          <span class="srch-actions">${showRep && m.len ? `<button class="icon" data-s="replace-one" title="Replace">⇄</button>` : ""}<button class="icon" data-s="dismiss" title="Dismiss">✕</button></span></div>`;
      });
    });
    box.innerHTML = html;
  }

  const parse = (k) => {
    const [t, fi, mi] = String(k || "").split(":");
    const f = res?.files[Number(fi)];
    return { type: t, f, fi: Number(fi), m: t === "m" ? f?.matches[Number(mi)] : null, mi: Number(mi) };
  };
  const rows = () => (body ? $$(".srch-results .srch-row", body) : []);

  function select(k) {
    selKey = k || "";
    for (const r of rows()) r.classList.toggle("sel", r.dataset.k === selKey);
    $(`.srch-row[data-k="${selKey}"]`, body)?.scrollIntoView({ block: "nearest" });
  }

  function openMatch(k, { focus = true } = {}) {
    const { f, m } = parse(k);
    if (!f || !m || !res) return;
    select(k);
    const t = W.openFile(join(res.root, f.path), { line: m.line, column: m.col, endColumn: m.len ? m.col + m.len : 0 });
    if (!focus) setTimeout(() => $(".srch-results", body)?.focus(), 0);
    return t;
  }

  function toggleFile(fi, collapsed) {
    const f = res?.files[fi];
    if (!f) return;
    f.collapsed = collapsed ?? !f.collapsed;
    paint();
  }

  function dismiss(k) {
    const { type, f, fi, mi } = parse(k);
    if (!f) return;
    if (type === "m") f.matches.splice(mi, 1);
    if (type === "f" || !f.matches.length) res.files.splice(fi, 1);
    selKey = "";
    paint();
  }

  // Bước sang kết quả kế tiếp / trước đó (F4 / Shift+F4, mũi tên trong danh sách)
  function step(dir, { matchesOnly = false } = {}) {
    let list = rows().map((r) => r.dataset.k);
    if (matchesOnly) list = list.filter((k) => k.startsWith("m:"));
    if (!list.length) return null;
    const i = list.indexOf(selKey);
    return list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
  }

  function onResultKey(e) {
    const k = selKey;
    const { type, fi } = parse(k);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      select(step(e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (type === "f") toggleFile(fi);
      else if (type === "m") openMatch(k, { focus: e.key === "Enter" });
    } else if (e.key === "ArrowLeft" && type) {
      e.preventDefault();
      toggleFile(fi, true);
      select(`f:${fi}`);
    } else if (e.key === "ArrowRight" && type === "f") {
      e.preventDefault();
      toggleFile(fi, false);
    } else if (e.key === "Delete" && type) {
      e.preventDefault();
      dismiss(k);
    }
  }

  function onClick(e) {
    const b = e.target.closest("[data-s]");
    const row = e.target.closest(".srch-row");
    const a = b?.dataset.s;
    const opt = e.target.closest("[data-opt]");
    if (opt) return toggleOpt(opt.dataset.opt);
    if (a === "toggle-replace") {
      st.showReplace = !st.showReplace;
      save();
      paintForm();
      if (st.showReplace) $(".srch-r", body).focus();
      return run();
    }
    if (a === "toggle-details") {
      st.showDetails = !st.showDetails;
      save();
      return paintForm();
    }
    if (a === "refresh") return run();
    if (a === "clear") return clear();
    if (a === "collapse") {
      if (!res) return;
      const all = res.files.every((f) => f.collapsed);
      res.files.forEach((f) => (f.collapsed = !all));
      return paint();
    }
    if (a === "replace-all") return replaceAll();
    if (row) {
      const k = row.dataset.k;
      const { type, f, fi, m } = parse(k);
      if (a === "dismiss") return dismiss(k);
      if (a === "replace-file") return replaceIn({ [f.path]: f.matches });
      if (a === "replace-one") return replaceIn({ [f.path]: [m] });
      if (type === "f") {
        select(k);
        return toggleFile(fi);
      }
      return openMatch(k, { focus: false });
    }
  }

  function onMenu(e) {
    const row = e.target.closest(".srch-row");
    if (!row || !res) return;
    e.preventDefault();
    const k = row.dataset.k;
    const { type, f, m } = parse(k);
    const full = join(res.root, f.path);
    W.menu(e, [
      ...(type === "m" ? [{ label: "Open", run: () => openMatch(k) }] : [{ label: "Open file", run: () => W.openFile(full) }]),
      ...(st.showReplace ? [{ label: type === "m" ? "Replace" : "Replace all in file", run: () => replaceIn({ [f.path]: type === "m" ? [m] : f.matches }) }] : []),
      { label: "Dismiss", run: () => dismiss(k) },
      { sep: true },
      { label: "Copy path", run: () => navigator.clipboard?.writeText(full) },
      { label: "Copy relative path", run: () => navigator.clipboard?.writeText(f.path) },
      ...(type === "m" ? [{ label: "Copy line", run: () => navigator.clipboard?.writeText(`${m.pre}${m.match}${m.post}`.replace(/^…/, "")) }] : []),
    ]);
  }

  // targets: { đường dẫn tương đối: [kết quả] }. File đang mở có thay đổi chưa lưu thì bỏ qua để không ghi đè.
  async function replaceIn(targets) {
    if (!res) return;
    const root = res.root;
    const send = {};
    const skipped = [];
    for (const [rel, list] of Object.entries(targets)) {
      if (W.findTab(`file:${join(root, rel)}`)?.inst?.isDirty?.()) skipped.push(rel);
      else send[rel] = list.filter((m) => m.len).map((m) => [m.line, m.col]);
    }
    if (skipped.length) toast(`Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} with unsaved changes: ${skipped.map(W.base).join(", ")}. Save them, then replace again.`, "error", 6000);
    if (!Object.keys(send).length) return;
    let r;
    try {
      r = await api("POST", "/api/files/replace", { root, query: st.query, regex: st.regex, caseSensitive: st.caseSensitive, wholeWord: st.wholeWord, replace: st.replace, targets: send });
    } catch (e) {
      return toast(e.message, "error");
    }
    await Promise.all(r.changed.map((rel) => W.findTab(`file:${join(root, rel)}`)?.inst?.reload?.().catch(() => {})));
    if (r.errors.length) toast(r.errors.slice(0, 3).join("\n"), "error", 6000);
    if (r.count) toast(`Replaced ${r.count} occurrence${r.count === 1 ? "" : "s"} in ${r.changed.length} file${r.changed.length === 1 ? "" : "s"}`, "ok", 2000);
    else if (!r.errors.length) toast("Nothing replaced: the files changed since the search. Refresh and try again.", "error");
    if (r.changed.length) W.emit("git:changed");
    run();
  }

  async function replaceAll() {
    if (!res || !count()) return;
    if (!st.showReplace) {
      st.showReplace = true;
      save();
      paintForm();
      return run();
    }
    const n = count();
    const files = res.files.length;
    const ok = await confirmDialog(`Replace ${n} occurrence${n === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"} with "${st.replace}"?`, { title: "Replace all", ok: "Replace" });
    if (ok) replaceIn(Object.fromEntries(res.files.map((f) => [f.path, f.matches])));
  }

  function clear() {
    seq++;
    ctrl?.abort();
    st.query = "";
    st.replace = "";
    save();
    res = null;
    selKey = "";
    if (body) {
      $(".srch-q", body).value = "";
      $(".srch-r", body).value = "";
    }
    paint();
  }

  // Mở view Search; điền chữ đang chọn trong editor (một dòng) vào ô tìm
  function open({ replace = false, include } = {}) {
    const ed = W.active?.inst?.editor?.();
    const sel = ed?.getSelection();
    const seed = sel && !sel.isEmpty() ? ed.getModel().getValueInRange(sel) : "";
    if (replace) st.showReplace = true;
    if (include != null) {
      st.include = include;
      st.showDetails = true;
    }
    if (seed && !seed.includes("\n")) st.query = seed;
    save();
    W.showView("search");
    if (!body) return;
    $(".srch-q", body).value = st.query;
    $(".srch-inc", body).value = st.include;
    paintForm();
    const input = $(replace ? ".srch-r" : ".srch-q", body);
    input.focus();
    input.select();
    if (st.query && (seed || include != null || !res)) run();
  }

  // Explorer: "Find in folder…" — giới hạn tìm trong thư mục con của thư mục hiện tại
  W.searchIn = (dir) => {
    if (dir !== W.folder && !dir.startsWith(W.folder + "/")) return toast("That folder is outside the current folder", "error");
    open({ include: dir === W.folder ? "" : `${dir.slice(W.folder.length + 1)}/**` });
  };

  W.registerView("search", { title: "Search", icon: W.ICON.search, order: 2.5, key: "view.search", mount, show: () => $(".srch-q", body)?.focus() });
  W.command("view.search", "Search: find in folder", () => open(), "Ctrl+Shift+F", { when: () => !document.activeElement?.closest?.(".xterm") });
  W.command("search.replace", "Search: replace in folder", () => open({ replace: true }), "");
  W.command("search.next", "Search: go to next result", () => openMatch(step(1, { matchesOnly: true })), "F4", { when: () => W.notTerm() && Boolean(res && count()) });
  W.command("search.prev", "Search: go to previous result", () => openMatch(step(-1, { matchesOnly: true })), "Shift+F4", { when: () => W.notTerm() && Boolean(res && count()) });
  W.command("search.clear", "Search: clear results", clear, "");
  W.on("folder", () => {
    res = null;
    selKey = "";
    if (st.query && body) run();
    else paint();
  });
})();
