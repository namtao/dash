"use strict";
// Database: kết nối PostgreSQL / MySQL / SQL Server / SQLite, cây bảng-cột, tab SQL (Monaco: tô màu, gợi ý
// bảng/cột, format), lưới kết quả sửa được — thay đổi chỉ ghi khi Ctrl+S / Save (trong một transaction),
// có cảnh báo khi còn thay đổi chưa lưu. Backup và restore là hai thao tác riêng, chạy nền có log.
(() => {
  const TYPES = { postgres: "PostgreSQL", mysql: "MySQL / MariaDB", mssql: "SQL Server", sqlite: "SQLite" };
  const LANG = { postgres: "pgsql", mysql: "mysql", mssql: "sql", sqlite: "sql" };
  const FORMAT_LANG = { postgres: "postgresql", mysql: "mysql", mssql: "transactsql", sqlite: "sqlite" };
  const conns = () => S.config?.databases || [];
  const conn = (id) => conns().find((c) => c.id === id);
  // Kết nối chỉ mở khi người dùng bấm vào (không tự kết nối khi tải trang). Mức con (database, bảng)
  // vẫn nhớ trạng thái mở rộng để lần kết nối sau hiện lại như cũ.
  const expanded = new Set(store.get("dbExpanded", []).filter((k) => !k.startsWith("c:")));
  const connected = new Set(); // id kết nối đang mở trong phiên này
  const markConnected = (id) => {
    if (connected.has(id)) return;
    connected.add(id);
    paintTree();
  };
  const treeData = new Map(); // key -> data đã tải (databases / schema rows)
  let root = null;
  let qseq = Date.now();

  const saveExpanded = () => store.set("dbExpanded", [...expanded].slice(-200));
  const q = (type, id) => (type === "mysql" ? `\`${id}\`` : type === "mssql" ? `[${id}]` : /^[a-z_][a-z0-9_]*$/.test(id) ? id : `"${id}"`);
  const tableRef = (type, schema, table) => (schema && !(type === "postgres" && schema === "public") && type !== "sqlite" && type !== "mysql" ? `${q(type, schema)}.${q(type, table)}` : q(type, table));

  // ---------- cây ----------
  async function loadDatabases(c) {
    const key = `dbs:${c.id}`;
    if (!treeData.has(key)) treeData.set(key, c.type === "sqlite" ? ["main"] : await api("GET", `/api/databases/${c.id}/databases`));
    return treeData.get(key);
  }
  async function loadSchema(id, db, force) {
    const key = `schema:${id}:${db}`;
    if (force || !treeData.has(key)) treeData.set(key, await api("GET", `/api/databases/${id}/schema?db=${encodeURIComponent(db)}${force ? "&force=1" : ""}`));
    return treeData.get(key);
  }
  W.dbSchema = loadSchema;

  function groupTables(rows) {
    const out = new Map(); // schema -> Map(table -> {view, cols})
    for (const r of rows) {
      if (!out.has(r.schema)) out.set(r.schema, new Map());
      const t = out.get(r.schema);
      if (!t.has(r.table)) t.set(r.table, { view: r.view, cols: [] });
      t.get(r.table).cols.push(r);
    }
    return out;
  }

  const row = (key, depth, icon, label, extra = "", attrs = "") =>
    `<div class="tree-row db-row" data-key="${esc(key)}" ${attrs} style="padding-left:${6 + depth * 12}px"><span class="twisty">${expanded.has(key) ? "▾" : "▸"}</span><span class="dbi">${icon}</span><span class="fname">${esc(label)}</span>${extra}</div>`;

  async function paintTree() {
    if (!root) return;
    const list = conns();
    let html = "";
    for (const c of list) {
      const ck = `c:${c.id}`;
      const on = connected.has(c.id);
      html += row(ck, 0, `<span class="db-dot ${on ? "on" : ""}" style="--c:${esc(c.color || "var(--accent)")}" title="${on ? "Connected" : "Not connected"}"></span>`, c.name, `<span class="faint db-type">${on ? "" : "○ "}${esc(TYPES[c.type])}</span>`, `data-conn="${c.id}"`);
      if (!expanded.has(ck) || !on) continue;
      let dbs;
      try {
        dbs = await loadDatabases(c);
      } catch (e) {
        html += `<div class="tree-row faint err" style="padding-left:30px" title="${esc(e.message)}">⚠ ${esc(e.message)}</div>`;
        continue;
      }
      const shown = c.database && c.type !== "sqlite" ? [c.database, ...dbs.filter((d) => d !== c.database)] : dbs;
      for (const db of shown) {
        const dk = `d:${c.id}:${db}`;
        html += row(dk, 1, "🗄", db, "", `data-conn="${c.id}" data-db="${esc(db)}"`);
        if (!expanded.has(dk)) continue;
        let rows;
        try {
          rows = await loadSchema(c.id, db);
        } catch (e) {
          html += `<div class="tree-row faint err" style="padding-left:42px" title="${esc(e.message)}">⚠ ${esc(e.message)}</div>`;
          continue;
        }
        const groups = groupTables(rows);
        const single = groups.size <= 1;
        for (const [schema, tables] of groups) {
          const sk = `s:${c.id}:${db}:${schema}`;
          if (!single) html += row(sk, 2, "▦", schema, `<span class="faint">${tables.size}</span>`);
          if (!single && !expanded.has(sk)) continue;
          for (const [table, t] of tables) {
            const tk = `t:${c.id}:${db}:${schema}:${table}`;
            html += row(tk, single ? 2 : 3, t.view ? "👁" : "▤", table, "", `data-conn="${c.id}" data-db="${esc(db)}" data-schema="${esc(schema)}" data-table="${esc(table)}"`);
            if (!expanded.has(tk)) continue;
            for (const col of t.cols) html += `<div class="tree-row db-col" style="padding-left:${(single ? 2 : 3) * 12 + 32}px" title="${esc(col.type)}${col.nullable ? "" : " NOT NULL"}">${col.pk ? "🔑" : "·"} <span class="fname">${esc(col.column)}</span> <span class="faint">${esc(col.type)}</span></div>`;
          }
        }
        if (!groups.size) html += `<div class="tree-row faint" style="padding-left:42px">No tables</div>`;
      }
    }
    $(".db-tree", root).innerHTML = html || `<div class="empty">No connections yet.<br><br><button class="btn sm primary" data-dbv="add">＋ Add connection</button></div>`;
  }

  function mount(body, actions) {
    root = body;
    body.innerHTML = `<div class="db-tree tree"></div>`;
    actions.innerHTML = `<button class="icon" data-dbv="add" title="Add connection">＋</button><button class="icon" data-dbv="query" title="New query">⌨</button><button class="icon" data-dbv="backup" title="Backup…">⤓</button><button class="icon" data-dbv="restore" title="Restore…">⤒</button><button class="icon" data-dbv="refresh" title="Refresh">↻</button>`;
    const onClick = async (e) => {
      const b = e.target.closest("[data-dbv]");
      if (b) {
        const a = b.dataset.dbv;
        if (a === "add") return connModal();
        if (a === "query") return newQuery();
        if (a === "backup") return backupModal();
        if (a === "restore") return restoreModal();
        if (a === "refresh") {
          treeData.clear();
          return paintTree();
        }
      }
      const r = e.target.closest(".db-row");
      if (!r) return;
      const k = r.dataset.key;
      if (k.startsWith("c:") && !connected.has(r.dataset.conn)) {
        expanded.add(k);
        connected.add(r.dataset.conn);
      } else if (expanded.has(k)) expanded.delete(k);
      else expanded.add(k);
      saveExpanded();
      paintTree();
    };
    actions.addEventListener("click", onClick);
    body.addEventListener("click", onClick);
    body.addEventListener("dblclick", (e) => {
      const r = e.target.closest(".db-row[data-table]");
      if (r) openTable(r.dataset.conn, r.dataset.db, r.dataset.schema, r.dataset.table);
    });
    body.addEventListener("contextmenu", (e) => {
      const r = e.target.closest(".db-row");
      if (!r) return;
      const { conn: id, db, schema, table } = r.dataset;
      const c = conn(id);
      if (!c) return;
      const items = [];
      if (table) {
        items.push({ label: "Open table (editable)", run: () => openTable(id, db, schema, table) });
        items.push({ label: "New query on table", run: () => newQuery({ conn: id, db, sql: `SELECT *\nFROM ${tableRef(c.type, schema, table)}\nWHERE ` }) });
        items.push({ label: "Copy name", run: () => navigator.clipboard?.writeText(table) });
        items.push({ label: "Count rows", run: () => newQuery({ conn: id, db, sql: `SELECT COUNT(*) FROM ${tableRef(c.type, schema, table)}`, run: true }) });
      } else if (db) {
        items.push({ label: "New query", run: () => newQuery({ conn: id, db }) });
        items.push({ label: "Backup this database…", run: () => backupModal({ conn: id, db }) });
        items.push({ label: "Restore into this database…", run: () => restoreModal({ conn: id, db }) });
        items.push({ label: "Refresh", run: () => (treeData.delete(`schema:${id}:${db}`), loadSchema(id, db, true).then(paintTree)) });
        if (c.type !== "sqlite") items.push({ sep: true }, { label: "Drop database…", danger: true, run: () => dropModal(id, db) });
      } else {
        items.push(connected.has(id) ? { label: "Disconnect", run: () => disconnect(id) } : { label: "Connect", run: () => (expanded.add(`c:${id}`), markConnected(id)) });
        items.push({ label: "New query", run: () => newQuery({ conn: id }) });
        items.push({ label: "Edit connection…", run: () => connModal(c) });
        items.push({ label: "Backup…", run: () => backupModal({ conn: id }) });
        items.push({ label: "Restore…", run: () => restoreModal({ conn: id }) });
        items.push({ label: "Refresh", run: () => ([...treeData.keys()].filter((k) => k.includes(`:${id}`)).forEach((k) => treeData.delete(k)), paintTree()) });
        items.push({ sep: true });
        items.push({ label: "Delete connection", danger: true, run: () => deleteConn(c) });
      }
      W.menu(e, items);
    });
    paintTree();
  }

  // ---------- kết nối ----------
  async function saveConns(list) {
    const r = await api("PUT", "/api/databases", { connections: list });
    await W.reloadConfig();
    treeData.clear();
    paintTree();
    return r;
  }

  function connModal(c = {}) {
    const isNew = !c.id;
    const type = c.type || "postgres";
    const m = openModal(
      isNew ? "Add database connection" : `Edit ${esc(c.name)}`,
      `<form id="conn-form" class="form">
        <label class="field"><span>Name</span><input name="name" value="${esc(c.name || "")}" required placeholder="e.g. app local" /></label>
        <label class="field"><span>Type</span><select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${type === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="field net"><span>Host</span><input name="host" class="mono" value="${esc(c.host || "localhost")}" /></label>
        <label class="field net"><span>Port</span><input name="port" type="number" value="${esc(c.port || "")}" placeholder="default" /></label>
        <label class="field net"><span>User</span><input name="user" class="mono" value="${esc(c.user || "")}" autocomplete="off" /></label>
        <label class="field net"><span>Password</span><input name="password" type="password" autocomplete="new-password" placeholder="${c.hasPassword ? "•••••• (unchanged)" : ""}" /></label>
        <label class="field net"><span>Default database</span><input name="database" class="mono" value="${esc(c.database || "")}" /></label>
        <label class="field net check-field"><span>&nbsp;</span><label class="check"><input type="checkbox" name="ssl" ${c.ssl ? "checked" : ""}/> Use SSL/TLS</label></label>
        <label class="field full file"><span>SQLite file</span><input name="file" class="mono" value="${esc(c.file || "")}" placeholder="/home/me/app/data.db" /></label>
        <label class="field"><span>Color</span><input name="color" type="color" value="${esc(c.color || "#61afef")}" /></label>
        <div class="field full"><div class="notice">Passwords are stored in <code>projects.json</code> on this machine (file mode 600, never sent back to the browser).</div></div>
      </form>`,
      `<button class="btn" id="conn-test" style="margin-right:auto">Test connection</button><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="conn-form">Save</button>`
    );
    const form = $("#conn-form", m);
    const sync = () => {
      const t = form.type.value;
      $$(".net", form).forEach((el) => el.classList.toggle("hidden", t === "sqlite"));
      $$(".file", form).forEach((el) => el.classList.toggle("hidden", t !== "sqlite"));
      form.port.placeholder = { postgres: "5432", mysql: "3306", mssql: "1433", sqlite: "" }[t];
    };
    form.type.onchange = sync;
    sync();
    const read = () => {
      const f = Object.fromEntries(new FormData(form));
      return { ...c, ...f, id: c.id, ssl: Boolean(f.ssl), port: Number(f.port) || undefined };
    };
    $("#conn-test", m).onclick = async () => {
      const r = await guarded(() => api("POST", "/api/databases/test", read()));
      if (r) toast(`Connected · ${r.databases} database(s)`, "ok");
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = read();
      const list = isNew ? [...conns(), data] : conns().map((x) => (x.id === c.id ? data : x));
      if (await guarded(() => saveConns(list), "Connection saved")) {
        closeModal();
        if (!W.layout.showSidebar || W.layout.view !== "database") W.showView("database");
      }
    };
  }

  async function disconnect(id) {
    await api("POST", `/api/databases/${id}/disconnect`).catch((e) => toast(e.message, "error"));
    connected.delete(id);
    expanded.delete(`c:${id}`);
    for (const k of [...treeData.keys()]) if (k.startsWith(`dbs:${id}`) || k.startsWith(`schema:${id}:`)) treeData.delete(k);
    paintTree();
    toast(`Disconnected ${conn(id)?.name || id}`, "ok", 1500);
  }

  async function deleteConn(c) {
    if (!(await confirmDialog(`Delete connection "${c.name}"?\nThe database itself is not touched.`, { title: "Delete connection", ok: "Delete", danger: true }))) return;
    await guarded(() => saveConns(conns().filter((x) => x.id !== c.id)), "Connection deleted");
  }

  // ---------- tab SQL ----------
  function openTable(id, db, schema, table) {
    const c = conn(id);
    return newQuery({ conn: id, db, sql: `SELECT *\nFROM ${tableRef(c.type, schema, table)}`, run: true, title: table, tabId: `table:${id}:${db}:${schema}.${table}` });
  }

  function newQuery(opts = {}) {
    const first = conns()[0];
    const id = opts.conn || store.get("dbLastConn", first?.id);
    if (!conn(id)) {
      toast("Add a database connection first", "error");
      return connModal();
    }
    const tabId = opts.tabId || `sql:${++qseq}`;
    const c = conn(id);
    return W.openTab({
      id: tabId,
      title: opts.title || `Query ${String(qseq).slice(-3)}`,
      icon: W.ICON.sql,
      tooltip: `${c.name}${opts.db ? ` / ${opts.db}` : ""}`,
      persist: { kind: "sql", data: { conn: id, db: opts.db || c.database || "", sql: opts.sql || "", title: opts.title || "", tabId } },
      create: (host, tab) => createSqlTab(host, tab, { conn: id, db: opts.db || c.database || "", sql: opts.sql || "", run: opts.run }),
    });
  }
  W.registerRestorer("sql", (d) => (conn(d.conn) ? newQuery({ ...d, run: false }) : null));

  // File .sql mở thẳng trong tab Query: nội dung đọc/ghi vào file, nhớ connection + database theo từng file.
  // Trả null khi chưa có connection nào (Explorer mở bằng editor thường).
  W.sqlFileTab = (p) => {
    const saved = store.get("sqlFileConn", {})[p] || {};
    const id = conn(saved.conn) ? saved.conn : store.get("dbLastConn", conns()[0]?.id);
    const c = conn(id);
    if (!c) return null;
    const db = saved.conn === id && saved.db ? saved.db : c.database || "";
    return {
      id: `file:${p}`,
      title: W.base(p),
      icon: W.fileIcon(p),
      tooltip: W.shortPath(p),
      persist: { kind: "file", data: { path: p } },
      create: (host, tab) => createSqlTab(host, tab, { conn: id, db, sql: "", file: p }),
    };
  };

  // Trạng thái xem của lưới kết quả: sắp xếp, lọc từng cột, dòng/cột đang chọn (chỉ số gốc, không đổi khi sắp xếp)
  const newView = () => ({ sort: null, filters: {}, rows: new Set(), cols: new Set(), anchor: -1, colAnchor: -1 });
  function createSqlTab(host, tab, init) {
    const st = {
      conn: init.conn,
      db: init.db,
      editor: null,
      results: [],
      cur: 0,
      changes: null, // { updates: Map(rowIdx -> Map(colIdx -> value)), deletes: Set(rowIdx), inserts: [array] }
      sel: { r: -1, c: -1 },
      view: newView(),
      order: [], // thứ tự dòng đang hiện (sau lọc + sắp xếp), là chỉ số dòng gốc
      running: false,
      disposed: false,
      split: store.get("sqlSplit", 0.45),
      saved: "", // nội dung file đã lưu (chế độ file)
      mtime: 0,
      size: null,
      autoTimer: 0,
      autoBlocked: false,
    };
    const file = init.file;
    host.classList.add("sql-host");
    host.innerHTML = `<div class="sql-toolbar">
        <select class="sql-conn" title="Connection"></select><select class="sql-db" title="Database"></select>
        <button class="btn sm primary" data-q="run" title="Run statement at cursor or selection (Ctrl+Enter)">▶ Run</button>
        <button class="btn sm" data-q="runAll" title="Run all (Ctrl+Shift+Enter)">▶▶ All</button>
        <button class="btn sm" data-q="format" title="Format SQL (Shift+Alt+F)">✎ Format</button>
        <span class="sql-sep"></span>
        <span class="sql-edit-tools hidden"><button class="btn sm" data-q="addRow" title="Add row">＋ Row</button><button class="btn sm" data-q="delRow" title="Delete selected row (Ctrl+Delete)">− Row</button>
        <button class="btn sm primary" data-q="save" title="Save changes (Ctrl+S)">💾 Save</button><button class="btn sm ghost" data-q="discard" title="Discard changes">Discard</button></span>
        <span class="sql-msg faint"></span>
        <button class="btn sm ghost" data-q="csv" title="Export result as CSV" style="margin-left:auto">CSV</button>
      </div>
      <div class="sql-editor"></div><div class="sql-sash"></div>
      <div class="sql-results"><div class="res-tabs"></div><div class="res-grid" tabindex="0"><div class="empty faint">Run a query to see results. Ctrl+Enter runs the statement under the cursor.</div></div></div>`;
    const connSel = $(".sql-conn", host);
    const dbSel = $(".sql-db", host);
    const fillConns = () => {
      connSel.innerHTML = conns().map((c) => `<option value="${c.id}" ${c.id === st.conn ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    };
    const fillDbs = async () => {
      const c = conn(st.conn);
      dbSel.innerHTML = `<option>${esc(st.db || "…")}</option>`;
      if (!connected.has(st.conn)) return msg("Not connected · runs connect automatically");
      try {
        const dbs = await loadDatabases(c);
        if (!st.db) st.db = c.database || dbs[0] || "";
        dbSel.innerHTML = [...new Set([st.db, ...dbs].filter(Boolean))].map((d) => `<option ${d === st.db ? "selected" : ""}>${esc(d)}</option>`).join("");
      } catch (e) {
        dbSel.innerHTML = `<option>${esc(st.db || "?")}</option>`;
        msg(e.message, "err");
      }
      loadSchema(st.conn, st.db).catch(() => {});
    };
    fillConns();
    fillDbs();
    // mở danh sách database thì kết nối
    dbSel.addEventListener("mousedown", () => {
      if (connected.has(st.conn)) return;
      markConnected(st.conn);
      fillDbs();
    });
    connSel.onchange = async () => {
      if (!(await confirmDiscard())) return (connSel.value = st.conn);
      st.conn = connSel.value;
      st.db = conn(st.conn).database || "";
      store.set("dbLastConn", st.conn);
      fillDbs();
      setLang();
      persist();
      tab.tooltip = conn(st.conn).name;
    };
    dbSel.onchange = async () => {
      if (!(await confirmDiscard())) return (dbSel.value = st.db);
      st.db = dbSel.value;
      loadSchema(st.conn, st.db).catch(() => {});
      persist();
    };

    const msg = (text, kind = "") => {
      const el = $(".sql-msg", host);
      el.textContent = text;
      el.className = `sql-msg ${kind === "err" ? "err" : "faint"}`;
      el.title = text;
    };
    const persist = () => {
      if (file) {
        const m = store.get("sqlFileConn", {});
        delete m[file];
        m[file] = { conn: st.conn, db: st.db };
        store.set("sqlFileConn", Object.fromEntries(Object.entries(m).slice(-200)));
        return;
      }
      tab.persist.data = { ...tab.persist.data, conn: st.conn, db: st.db, sql: st.editor ? st.editor.getValue() : tab.persist.data.sql };
      W.persistTabs();
    };
    const setLang = () => st.editor && window.monaco.editor.setModelLanguage(st.editor.getModel(), LANG[conn(st.conn).type]);

    // kéo giãn editor / kết quả
    const applySplit = () => {
      $(".sql-editor", host).style.flex = `0 0 ${st.split * 100}%`;
    };
    applySplit();
    $(".sql-sash", host).addEventListener("pointerdown", (e) => {
      const rect = host.getBoundingClientRect();
      const sash = e.target;
      sash.setPointerCapture(e.pointerId);
      const move = (ev) => {
        st.split = Math.min(0.85, Math.max(0.1, (ev.clientY - rect.top - 36) / (rect.height - 36)));
        applySplit();
        st.editor?.layout();
      };
      sash.addEventListener("pointermove", move);
      sash.addEventListener("pointerup", () => {
        sash.removeEventListener("pointermove", move);
        store.set("sqlSplit", st.split);
      }, { once: true });
    });

    (async () => {
      const monaco = await W.monaco();
      if (st.disposed) return;
      registerSqlCompletion(monaco);
      let text = init.sql;
      if (file) {
        try {
          const f = await api("GET", `/api/files/read?path=${encodeURIComponent(file)}`);
          if (f.binary || f.tooLarge) throw new Error(`${f.binary ? "Binary file" : "File is too large to edit"}`);
          text = st.saved = f.content;
          st.mtime = f.mtime;
          st.size = f.size;
          W.emit("file:info");
        } catch (e) {
          $(".sql-editor", host).innerHTML = `<div class="empty">${esc(e.message)}</div>`;
          return;
        }
        if (st.disposed) return;
      }
      const model = monaco.editor.createModel(text, LANG[conn(st.conn).type]);
      model.dashSql = () => ({ conn: st.conn, db: st.db });
      st.editor = monaco.editor.create($(".sql-editor", host), {
        model,
        theme: W.monacoTheme(),
        automaticLayout: true,
        fontFamily: W.ws().fontFamily,
        fontSize: W.ws().editorFontSize,
        minimap: { enabled: false },
        wordWrap: "on",
        suggestOnTriggerCharacters: true,
        quickSuggestions: { other: true, strings: false, comments: false },
        tabSize: 2,
        fixedOverflowWidgets: true,
      });
      st.editor.addAction({ id: "dash.run", label: "Run statement", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => run(false) });
      st.editor.addAction({ id: "dash.runAll", label: "Run all", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter], run: () => run(true) });
      st.editor.addAction({ id: "dash.format", label: "Format SQL", keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF], run: format });
      let t = 0;
      model.onDidChangeContent(() => {
        if (!file) {
          clearTimeout(t);
          t = setTimeout(persist, 500);
          return;
        }
        W.markDirty();
        // Tự lưu file giống editor thường (Settings → auto save)
        const w = W.ws();
        clearTimeout(st.autoTimer);
        if (w.autoSave && !st.autoBlocked) st.autoTimer = setTimeout(() => fileDirty() && saveFile(false, true), w.autoSaveDelay || 1000);
      });
      if (init.run) run(true);
      else st.editor.focus();
    })();

    // Câu lệnh tại con trỏ: đoạn giữa hai dấu ";" (hoặc dòng trống) bao quanh con trỏ
    function statementAtCursor() {
      const ed = st.editor;
      const sel = ed.getSelection();
      const model = ed.getModel();
      if (sel && !sel.isEmpty()) return model.getValueInRange(sel);
      const text = model.getValue();
      const off = model.getOffsetAt(ed.getPosition());
      let start = 0;
      let end = text.length;
      const re = /;|\n\s*\n/g;
      let m;
      while ((m = re.exec(text))) {
        if (m.index + m[0].length <= off) start = m.index + m[0].length;
        else if (m.index >= off) {
          end = m.index;
          break;
        }
      }
      const stmt = text.slice(start, end).trim();
      return stmt || text.trim();
    }

    function format() {
      const ed = st.editor;
      if (!ed || !window.sqlFormatter) return;
      const model = ed.getModel();
      const sel = ed.getSelection();
      const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
      try {
        const out = sqlFormatter.format(model.getValueInRange(range), { language: FORMAT_LANG[conn(st.conn).type], keywordCase: "upper", tabWidth: 2, linesBetweenQueries: 1 });
        ed.executeEdits("format", [{ range, text: out }]);
      } catch (e) {
        toast(`Format failed: ${e.message.split("\n")[0]}`, "error");
      }
    }

    const fileDirty = () => Boolean(file && st.editor && st.editor.getValue() !== st.saved);
    async function saveFile(force = false, auto = false) {
      const content = st.editor.getValue();
      try {
        const r = await api("PUT", "/api/files/write", { path: file, content, mtime: st.mtime, force });
        st.saved = content;
        st.mtime = r.mtime;
        st.size = r.size;
        st.autoBlocked = false;
        W.markDirty();
        W.emit("file:info");
        W.emit("file:saved", file);
        return true;
      } catch (e) {
        if (/changed on disk/.test(e.message)) {
          // tự lưu không ghi đè thay đổi từ nơi khác: dừng tự lưu cho tới khi người dùng tự lưu
          if (auto) {
            st.autoBlocked = true;
            toast(`${W.base(file)} changed on disk. Auto save paused; press Ctrl+S to choose.`, "error");
            return false;
          }
          if (await confirmDialog(`${W.base(file)} was changed on disk since you opened it.\nOverwrite it with your version?`, { title: "File changed on disk", ok: "Overwrite", danger: true })) return saveFile(true);
          return false;
        }
        toast(e.message, "error");
        return false;
      }
    }

    const gridDirty = () => Boolean(st.changes && (st.changes.updates.size || st.changes.deletes.size || st.changes.inserts.length));
    async function confirmDiscard() {
      if (!gridDirty()) return true;
      const c = await W.confirm3("The result grid has unsaved changes.", "Save", "Discard");
      if (c === "cancel") return false;
      if (c === "yes") return save();
      resetChanges();
      return true;
    }
    function resetChanges() {
      st.changes = { updates: new Map(), deletes: new Set(), inserts: [] };
      W.markDirty();
      paintGrid();
    }

    async function run(all) {
      if (!st.editor || st.running) return;
      if (!(await confirmDiscard())) return;
      const sql = all ? st.editor.getValue() : statementAtCursor();
      if (!sql.trim()) return;
      st.running = true;
      if (!connected.has(st.conn)) {
        markConnected(st.conn);
        fillDbs();
      }
      msg("Running…");
      $(".res-grid", host).classList.add("busy");
      try {
        const r = await api("POST", `/api/databases/${st.conn}/query`, { db: st.db, sql });
        st.results = r.results;
        st.cur = Math.max(0, r.results.findIndex((x) => x.columns.length));
        st.lastSql = sql;
        const res = st.results[st.cur];
        msg(`${r.results.length > 1 ? `${r.results.length} results · ` : ""}${res?.columns.length ? `${res.rows.length}${res.truncated ? `+ (first ${r.limit})` : ""} rows` : `${res?.affected ?? 0} row(s) affected`} · ${r.ms} ms${res?.columns.length && !res.edit ? ` · read-only: ${res.readonlyReason || ""}` : ""}`);
        if (/^\s*(create|alter|drop|rename|truncate)\b/im.test(sql)) {
          treeData.delete(`schema:${st.conn}:${st.db}`);
          loadSchema(st.conn, st.db, true).then(() => root && paintTree()).catch(() => {});
        }
      } catch (e) {
        st.results = [];
        msg(e.message, "err");
        $(".res-grid", host).innerHTML = `<pre class="sql-error">${esc(e.message)}</pre>`;
        $(".res-tabs", host).innerHTML = "";
      }
      st.running = false;
      $(".res-grid", host).classList.remove("busy");
      st.changes = { updates: new Map(), deletes: new Set(), inserts: [] };
      st.sel = { r: -1, c: -1 };
      st.view = newView();
      W.markDirty();
      if (st.results.length) paintGrid();
    }

    // ---------- lưới kết quả ----------
    const res = () => st.results[st.cur];
    const cellText = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? v.$binary || JSON.stringify(v) : String(v));
    const valueAt = (r, c) => {
      const R = res();
      if (r >= R.rows.length) return st.changes.inserts[r - R.rows.length][c];
      const u = st.changes.updates.get(r);
      return u && u.has(c) ? u.get(c) : R.rows[r][c];
    };

    // So sánh để sắp xếp / lọc: NULL luôn ở cuối, số so theo số, còn lại so chữ (không phân biệt hoa thường, 2 < 10)
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent" });
    const isNum = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)));
    function sortCmp(x, y, dir = 1) {
      const xn = x === null || x === undefined;
      const yn = y === null || y === undefined;
      if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1;
      if (isNum(x) && isNum(y)) return (Number(x) - Number(y)) * dir;
      return collator.compare(cellText(x), cellText(y)) * dir;
    }
    // Ô lọc: chữ thường = chứa (không phân biệt hoa thường), !abc = không chứa, NULL / !NULL,
    // hoặc so sánh =, !=, <>, >, <, >=, <= (số so theo số)
    const FILTER_HELP = "Contains (case-insensitive). Also: !text, =value, !=value, >10, <=2024-01-01, NULL, !NULL";
    function matcher(raw) {
      const f = raw.trim();
      if (/^null$/i.test(f)) return (v) => v === null;
      if (/^(!|not\s+)null$/i.test(f)) return (v) => v !== null && v !== undefined;
      const m = f.match(/^(>=|<=|!=|<>|=|>|<)\s*(.*)$/);
      if (m) {
        const op = m[1];
        const test = { "=": (d) => d === 0, "!=": (d) => d !== 0, "<>": (d) => d !== 0, ">": (d) => d > 0, "<": (d) => d < 0, ">=": (d) => d >= 0, "<=": (d) => d <= 0 }[op];
        return (v) => (v === null || v === undefined ? op === "!=" || op === "<>" : test(Math.sign(sortCmp(v, m[2]))));
      }
      const neg = f.startsWith("!");
      const needle = (neg ? f.slice(1) : f).toLowerCase();
      return (v) => (v !== null && v !== undefined && cellText(v).toLowerCase().includes(needle)) !== neg;
    }
    function viewOrder() {
      const R = res();
      const fs = Object.entries(st.view.filters)
        .filter(([, v]) => v.trim())
        .map(([c, v]) => [Number(c), matcher(v)]);
      const order = [];
      for (let r = 0; r < R.rows.length; r++) if (fs.every(([c, m]) => m(valueAt(r, c)))) order.push(r);
      const s = st.view.sort;
      if (s) order.sort((a, b) => sortCmp(valueAt(a, s.c), valueAt(b, s.c), s.dir) || a - b);
      // dòng mới thêm luôn ở cuối, không bị lọc / sắp xếp để thấy dòng đang nhập
      for (let r = R.rows.length; r < R.rows.length + st.changes.inserts.length; r++) order.push(r);
      return order;
    }

    function paintGrid() {
      const R = res();
      const tabs = $(".res-tabs", host);
      tabs.innerHTML = st.results.length > 1 ? st.results.map((x, i) => `<button class="res-tab ${i === st.cur ? "active" : ""}" data-res="${i}">${x.columns.length ? `Result ${i + 1} (${x.rows.length})` : `Statement ${i + 1}: ${x.affected} affected`}</button>`).join("") : "";
      const grid = $(".res-grid", host);
      $(".sql-edit-tools", host).classList.toggle("hidden", !R?.edit);
      if (!R) return;
      if (!R.columns.length) {
        grid.innerHTML = `<div class="empty faint">${R.affected ?? 0} row(s) affected${R.info ? ` · ${esc(R.info)}` : ""}</div>`;
        return;
      }
      const V = st.view;
      // đang gõ trong ô lọc: vẽ lại xong thì đặt con trỏ về đúng chỗ
      const focused = document.activeElement?.classList?.contains("col-filter") && grid.contains(document.activeElement) ? document.activeElement : null;
      const keep = focused && { f: focused.dataset.f, at: focused.selectionStart };
      const order = (st.order = viewOrder());
      const pkSet = new Set(R.edit?.pk || []);
      const filtered = Object.values(V.filters).some((v) => v.trim());
      const sortIcon = (i) => (V.sort?.c === i ? (V.sort.dir > 0 ? "▲" : "▼") : "⇅");
      const head = `<tr><th class="rn">#</th>${R.columns
        .map(
          (c, i) =>
            `<th class="col-h ${V.cols.has(i) ? "col-sel" : ""}" data-col="${i}" title="${esc(c.type ?? "")}${c.type ? " · " : ""}Click to select the column"><span class="th-in"><span class="th-name">${pkSet.has(R.edit?.columns[i]) ? "🔑 " : ""}${esc(c.name)}</span><button class="th-sort ${V.sort?.c === i ? "on" : ""}" data-sort="${i}" title="Sort (ascending, descending, off)">${sortIcon(i)}</button></span></th>`
        )
        .join("")}</tr><tr class="filter-row"><th class="rn">${filtered ? `<button class="th-clear" data-clear-filters title="Clear all filters">✕</button>` : ""}</th>${R.columns
        .map((_, i) => `<th><input class="col-filter" data-f="${i}" value="${esc(V.filters[i] || "")}" placeholder="Filter" spellcheck="false" autocomplete="off" title="${FILTER_HELP}" /></th>`)
        .join("")}</tr>`;
      const shown = Math.min(order.length, 5000);
      let body = "";
      for (let i = 0; i < shown; i++) {
        const r = order[i];
        const isNew = r >= R.rows.length;
        const del = st.changes.deletes.has(r);
        const upd = st.changes.updates.get(r);
        body += `<tr class="${isNew ? "new" : ""} ${del ? "deleted" : ""} ${V.rows.has(r) ? "row-sel" : ""}" data-r="${r}"><td class="rn" title="Click to select the row (Shift: range, Ctrl/Cmd: add)">${isNew ? "＋" : r + 1}</td>`;
        for (let c = 0; c < R.columns.length; c++) {
          const v = valueAt(r, c);
          const changed = (upd && upd.has(c)) || (isNew && v !== undefined);
          const cls = [changed ? "changed" : "", v === null ? "null" : "", typeof v === "number" ? "num" : "", st.sel.r === r && st.sel.c === c ? "sel" : "", V.cols.has(c) ? "col-sel" : ""].join(" ");
          body += `<td class="${cls}" data-c="${c}">${v === null ? "NULL" : v === undefined ? '<span class="faint">default</span>' : esc(cellText(v).slice(0, 500))}</td>`;
        }
        body += "</tr>";
      }
      const foot = [order.length > shown ? `Showing ${shown} of ${order.length} rows` : "", filtered ? `${order.length - st.changes.inserts.length} of ${R.rows.length} rows match the filters` : ""].filter(Boolean).join(" · ");
      grid.innerHTML = `<table class="rgrid"><thead>${head}</thead><tbody>${body}</tbody></table>${foot ? `<div class="rgrid-foot faint">${foot}</div>` : ""}${filtered && !order.length ? `<div class="empty faint">No rows match the filters.</div>` : ""}`;
      const tr0 = $(".rgrid thead tr", grid);
      grid.style.setProperty("--rg-h", `${tr0.offsetHeight}px`);
      if (keep) {
        const inp = $(`.col-filter[data-f="${keep.f}"]`, grid);
        inp?.focus();
        inp?.setSelectionRange(keep.at, keep.at);
      }
    }

    // Tô lại dòng / cột đang chọn mà không vẽ lại cả lưới
    function paintSel() {
      const g = $(".res-grid", host);
      const V = st.view;
      $$("tr.row-sel", g).forEach((x) => x.classList.remove("row-sel"));
      $$(".col-sel", g).forEach((x) => x.classList.remove("col-sel"));
      for (const r of V.rows) $(`tr[data-r="${r}"]`, g)?.classList.add("row-sel");
      for (const c of V.cols) {
        $(`th[data-col="${c}"]`, g)?.classList.add("col-sel");
        $$(`td[data-c="${c}"]`, g).forEach((x) => x.classList.add("col-sel"));
      }
    }
    function clearPick() {
      if (!st.view.rows.size && !st.view.cols.size) return;
      st.view.rows.clear();
      st.view.cols.clear();
      paintSel();
    }
    // Bấm số dòng: chọn dòng; Shift chọn một đoạn (theo thứ tự đang hiện), Ctrl/Cmd thêm/bỏ từng dòng
    function pickRow(r, e) {
      const V = st.view;
      V.cols.clear();
      const a = st.order.indexOf(V.anchor);
      const b = st.order.indexOf(r);
      if (e.shiftKey && a >= 0 && b >= 0) {
        if (!(e.ctrlKey || e.metaKey)) V.rows.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) V.rows.add(st.order[i]);
      } else if (e.ctrlKey || e.metaKey) {
        if (V.rows.has(r)) V.rows.delete(r);
        else V.rows.add(r);
        V.anchor = r;
      } else {
        V.rows = new Set([r]);
        V.anchor = r;
      }
      selectCell(r, Math.max(0, st.sel.c), false, true);
      paintSel();
    }
    // Bấm tên cột: chọn cột (Shift / Ctrl / Cmd như chọn dòng)
    function pickCol(c, e) {
      const V = st.view;
      V.rows.clear();
      if (e.shiftKey && V.colAnchor >= 0) {
        if (!(e.ctrlKey || e.metaKey)) V.cols.clear();
        for (let i = Math.min(V.colAnchor, c); i <= Math.max(V.colAnchor, c); i++) V.cols.add(i);
      } else if (e.ctrlKey || e.metaKey) {
        if (V.cols.has(c)) V.cols.delete(c);
        else V.cols.add(c);
        V.colAnchor = c;
      } else {
        V.cols = new Set([c]);
        V.colAnchor = c;
      }
      paintSel();
      $(".res-grid", host).focus({ preventScroll: true });
    }
    // Bấm biểu tượng sắp xếp: tăng dần → giảm dần → tắt
    function cycleSort(c, dir) {
      const s = st.view.sort;
      st.view.sort = dir !== undefined ? (dir ? { c, dir } : null) : s?.c !== c ? { c, dir: 1 } : s.dir > 0 ? { c, dir: -1 } : null;
      paintGrid();
    }
    let filterTimer = 0;
    host.addEventListener("input", (e) => {
      const inp = e.target.closest(".col-filter");
      if (!inp) return;
      st.view.filters[inp.dataset.f] = inp.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(paintGrid, 150);
    });

    function selectCell(r, c, scroll = true, keepPick = false) {
      if (!keepPick) clearPick();
      st.sel = { r, c };
      $$(".res-grid td.sel", host).forEach((x) => x.classList.remove("sel"));
      const td = $(`.res-grid tr[data-r="${r}"] td[data-c="${c}"]`, host);
      td?.classList.add("sel");
      if (scroll) td?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    function editCell(r, c) {
      const R = res();
      if (!R?.edit || st.changes.deletes.has(r)) return;
      const colName = R.edit.columns[c];
      if (!colName) return toast("This column is computed and cannot be edited", "error");
      const td = $(`.res-grid tr[data-r="${r}"] td[data-c="${c}"]`, host);
      const v = valueAt(r, c);
      if (v && typeof v === "object" && v.$binary) return toast("Binary values cannot be edited here", "error");
      const multiline = typeof v === "string" && (v.length > 80 || v.includes("\n"));
      const input = document.createElement(multiline ? "textarea" : "input");
      input.className = "cell-input";
      input.value = v == null ? "" : String(v);
      td.innerHTML = "";
      td.append(input);
      input.focus();
      input.select();
      let done = false;
      const commit = (save) => {
        if (done) return;
        done = true;
        if (save) setValue(r, c, input.value);
        else paintGrid();
        selectCell(r, c);
        $(".res-grid", host).focus();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") commit(false);
        if (e.key === "Enter" && (!multiline || e.ctrlKey)) {
          e.preventDefault();
          commit(true);
        }
        if (e.key === "Tab") {
          e.preventDefault();
          commit(true);
          const nc = c + (e.shiftKey ? -1 : 1);
          if (nc >= 0 && nc < R.columns.length) {
            selectCell(r, nc);
            editCell(r, nc);
          }
        }
      });
      input.addEventListener("blur", () => commit(true));
    }

    function setValue(r, c, value) {
      const R = res();
      if (r >= R.rows.length) st.changes.inserts[r - R.rows.length][c] = value;
      else {
        const orig = R.rows[r][c];
        const u = st.changes.updates.get(r) || new Map();
        if ((orig === null && value === null) || (orig !== null && value !== null && String(orig) === String(value))) u.delete(c);
        else u.set(c, value);
        if (u.size) st.changes.updates.set(r, u);
        else st.changes.updates.delete(r);
      }
      W.markDirty();
      paintGrid();
    }

    function addRow() {
      const R = res();
      if (!R?.edit) return;
      st.changes.inserts.push(new Array(R.columns.length).fill(undefined));
      W.markDirty();
      paintGrid();
      const r = R.rows.length + st.changes.inserts.length - 1;
      const firstEditable = R.columns.findIndex((_, i) => R.edit.columns[i]);
      selectCell(r, Math.max(0, firstEditable));
      editCell(r, Math.max(0, firstEditable));
    }

    // Dòng sẽ áp thao tác: các dòng đang chọn (nếu r nằm trong đó), không thì chỉ dòng r; theo thứ tự đang hiện
    const targetRows = (r) => (st.view.rows.has(r) ? st.order.filter((x) => st.view.rows.has(x)) : [r]);

    // Xoá (hoặc bỏ xoá) dòng r hay mọi dòng đang chọn; dòng mới thêm thì bỏ hẳn
    function deleteRow(r = st.sel.r) {
      const R = res();
      if (!R?.edit || r < 0) return;
      const rows = targetRows(r);
      const old = rows.filter((x) => x < R.rows.length);
      const undo = old.length && old.every((x) => st.changes.deletes.has(x));
      for (const x of old) undo ? st.changes.deletes.delete(x) : st.changes.deletes.add(x);
      const added = rows.filter((x) => x >= R.rows.length).sort((a, b) => b - a);
      for (const x of added) st.changes.inserts.splice(x - R.rows.length, 1);
      if (added.length) st.view.rows.clear();
      W.markDirty();
      paintGrid();
    }

    function revertRow(r) {
      st.changes.updates.delete(r);
      st.changes.deletes.delete(r);
      W.markDirty();
      paintGrid();
    }

    async function save() {
      const R = res();
      if (!gridDirty() || !R?.edit) return true;
      const E = R.edit;
      const keyOf = (r) => Object.fromEntries(E.pk.map((k) => [k, R.rows[r][E.columns.indexOf(k)]]));
      const toCol = (c) => E.columns[c];
      const changes = {
        schema: E.schema,
        table: E.table,
        pk: E.pk,
        deletes: [...st.changes.deletes].map((r) => ({ key: keyOf(r) })),
        updates: [...st.changes.updates].filter(([r]) => !st.changes.deletes.has(r)).map(([r, m]) => ({ key: keyOf(r), set: Object.fromEntries([...m].map(([c, v]) => [toCol(c), v])) })),
        inserts: st.changes.inserts.map((row) => Object.fromEntries(row.map((v, c) => [toCol(c), v]).filter(([k, v]) => k && v !== undefined))),
      };
      const summary = `${changes.updates.length} update(s), ${changes.inserts.length} insert(s), ${changes.deletes.length} delete(s)`;
      if (changes.deletes.length && !(await confirmDialog(`Save changes to ${E.table}?\n\n${summary}\n\nDeleted rows cannot be recovered.`, { title: "Save changes", ok: "Save", danger: true }))) return false;
      msg(`Saving ${summary}…`);
      try {
        const r = await api("POST", `/api/databases/${st.conn}/save`, { db: st.db, changes });
        toast(`Saved · ${r.affected} row(s)`, "ok");
        st.changes = { updates: new Map(), deletes: new Set(), inserts: [] };
        W.markDirty();
        // chạy lại để thấy dữ liệu thật trong DB
        const again = await api("POST", `/api/databases/${st.conn}/query`, { db: st.db, sql: st.lastSql }).catch(() => null);
        if (again) {
          st.results = again.results;
          st.view.rows.clear();
          msg(`Saved ${summary} · reloaded`);
        }
        paintGrid();
        return true;
      } catch (e) {
        msg(e.message, "err");
        toast(e.message, "error", 8000);
        return false;
      }
    }

    function copyText(r, c) {
      navigator.clipboard?.writeText(cellText(valueAt(r, c)));
    }
    const csvCell = (v) => {
      const s = cellText(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    function rowAs(r, kind) {
      const R = res();
      const vals = R.columns.map((_, c) => valueAt(r, c));
      if (kind === "json") return JSON.stringify(Object.fromEntries(R.columns.map((col, c) => [col.name, vals[c]])));
      if (kind === "csv") return vals.map(csvCell).join(",");
      const type = conn(st.conn).type;
      const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? v : `'${String(cellText(v)).replace(/'/g, "''")}'`);
      return `INSERT INTO ${R.edit ? tableRef(type, R.edit.schema, R.edit.table) : "table_name"} (${R.columns.map((x) => q(type, x.name)).join(", ")}) VALUES (${vals.map(lit).join(", ")});`;
    }
    function rowsAs(rows, kind) {
      const out = rows.map((r) => rowAs(r, kind));
      return kind === "json" && rows.length > 1 ? `[\n${out.join(",\n")}\n]` : out.join("\n");
    }
    // Ctrl/Cmd+C: dòng đang chọn, cột đang chọn (kèm tên cột, các dòng đang hiện) hoặc ô; dạng TSV để dán vào bảng tính
    function copySelection() {
      const R = res();
      const V = st.view;
      const tsv = (v) => cellText(v).replace(/[\t\r\n]+/g, " ");
      let text;
      let what;
      if (V.rows.size) {
        const rows = targetRows([...V.rows][0]);
        text = rows.map((r) => R.columns.map((_, c) => tsv(valueAt(r, c))).join("\t")).join("\n");
        what = `${rows.length} row(s)`;
      } else if (V.cols.size) {
        const cols = [...V.cols].sort((a, b) => a - b);
        text = [cols.map((c) => R.columns[c].name).join("\t"), ...st.order.map((r) => cols.map((c) => tsv(valueAt(r, c))).join("\t"))].join("\n");
        what = `${cols.length} column(s) · ${st.order.length} row(s)`;
      } else return st.sel.r >= 0 && copyText(st.sel.r, st.sel.c);
      navigator.clipboard?.writeText(text).then(() => toast(`Copied ${what}`, "ok", 1500));
    }
    // CSV xuất theo đúng các dòng đang hiện (đã lọc, đã sắp xếp)
    function exportCsv() {
      const R = res();
      if (!R?.columns.length) return toast("No result to export", "error");
      const lines = [R.columns.map((c) => csvCell(c.name)).join(","), ...viewOrder().filter((r) => r < R.rows.length).map((r) => rowAs(r, "csv"))];
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
      a.download = `${R.edit?.table || "result"}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-q]");
      if (b) {
        const a = b.dataset.q;
        if (a === "run") run(false);
        if (a === "runAll") run(true);
        if (a === "format") format();
        if (a === "addRow") addRow();
        if (a === "delRow") deleteRow();
        if (a === "save") save();
        if (a === "discard") confirmDialog("Discard all unsaved changes in the grid?", { title: "Discard changes", ok: "Discard", danger: true }).then((ok) => ok && resetChanges());
        if (a === "csv") exportCsv();
        return;
      }
      const rt = e.target.closest("[data-res]");
      if (rt) {
        confirmDiscard().then((ok) => {
          if (!ok) return;
          st.cur = Number(rt.dataset.res);
          st.changes = { updates: new Map(), deletes: new Set(), inserts: [] };
          st.view = newView();
          paintGrid();
        });
        return;
      }
      if (e.target.closest(".res-grid [data-clear-filters]")) {
        st.view.filters = {};
        return paintGrid();
      }
      const sb = e.target.closest(".res-grid [data-sort]");
      if (sb) return cycleSort(Number(sb.dataset.sort));
      const th = e.target.closest(".res-grid th[data-col]");
      if (th) return pickCol(Number(th.dataset.col), e);
      const rn = e.target.closest(".res-grid td.rn");
      if (rn) return pickRow(Number(rn.parentElement.dataset.r), e);
      const td = e.target.closest(".res-grid td[data-c]");
      if (td) selectCell(Number(td.parentElement.dataset.r), Number(td.dataset.c), false);
    });
    // Shift+bấm số dòng không bôi đen chữ trong lưới
    host.addEventListener("mousedown", (e) => {
      if (e.shiftKey && e.target.closest(".res-grid td.rn, .res-grid th[data-col]")) e.preventDefault();
    });
    host.addEventListener("dblclick", (e) => {
      const td = e.target.closest(".res-grid td[data-c]");
      if (td) editCell(Number(td.parentElement.dataset.r), Number(td.dataset.c));
    });
    host.addEventListener("contextmenu", (e) => {
      const th = e.target.closest(".res-grid th[data-col]");
      if (th) {
        const c = Number(th.dataset.col);
        if (!st.view.cols.has(c)) pickCol(c, {});
        const s = st.view.sort;
        return W.menu(e, [
          { label: "Copy column values", run: copySelection, key: "Ctrl+C" },
          { sep: true },
          { label: "Sort ascending", run: () => cycleSort(c, 1), disabled: s?.c === c && s.dir > 0 },
          { label: "Sort descending", run: () => cycleSort(c, -1), disabled: s?.c === c && s.dir < 0 },
          { label: "Clear sort", run: () => cycleSort(c, 0), disabled: !s },
          { label: "Clear filters", run: () => ((st.view.filters = {}), paintGrid()), disabled: !Object.values(st.view.filters).some((v) => v.trim()) },
        ]);
      }
      const td = e.target.closest(".res-grid td");
      if (!td) return;
      const r = Number(td.parentElement.dataset.r);
      const c = td.dataset.c != null ? Number(td.dataset.c) : 0;
      if (td.classList.contains("rn") && !st.view.rows.has(r)) pickRow(r, {});
      selectCell(r, c, false, st.view.rows.has(r));
      const R = res();
      const editable = Boolean(R.edit);
      const rows = targetRows(r);
      const n = rows.length > 1 ? `${rows.length} rows` : "row";
      const copy = (kind) => navigator.clipboard?.writeText(rowsAs(rows, kind));
      W.menu(e, [
        { label: "Copy value", run: () => copyText(r, c), key: rows.length > 1 ? "" : "Ctrl+C" },
        ...(rows.length > 1 ? [{ label: `Copy ${n}`, run: copySelection, key: "Ctrl+C" }] : []),
        { label: `Copy ${n} as JSON`, run: () => copy("json") },
        { label: `Copy ${n} as CSV`, run: () => copy("csv") },
        { label: `Copy ${n} as INSERT`, run: () => copy("insert") },
        ...(editable
          ? [
              { sep: true },
              { label: "Edit cell", run: () => editCell(r, c), key: "Enter" },
              { label: "Set NULL", run: () => setValue(r, c, null) },
              { label: "Set empty string", run: () => setValue(r, c, "") },
              { label: "Add row", run: addRow },
              { label: "Duplicate row", run: () => { const R2 = res(); st.changes.inserts.push(R2.columns.map((_, i) => (R2.edit.pk.includes(R2.edit.columns[i]) ? undefined : valueAt(r, i)))); W.markDirty(); paintGrid(); } },
              { label: st.changes.deletes.has(r) ? `Undo delete${rows.length > 1 ? ` (${n})` : ""}` : `Delete ${n}`, danger: !st.changes.deletes.has(r), run: () => deleteRow(r), key: "Ctrl+Delete" },
              { label: "Revert row", run: () => revertRow(r), disabled: !st.changes.updates.has(r) && !st.changes.deletes.has(r) },
            ]
          : []),
      ]);
    });
    $(".res-grid", host).addEventListener("keydown", (e) => {
      const R = res();
      if (e.target.closest(".col-filter")) {
        if (e.key === "Escape" && e.target.value) {
          e.target.value = "";
          st.view.filters[e.target.dataset.f] = "";
          paintGrid();
        }
        return;
      }
      if (!R?.columns.length) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "c" && (st.view.rows.size || st.view.cols.size)) return copySelection();
      if (e.key === "Escape") return clearPick();
      if (st.sel.r < 0) return;
      const { r, c } = st.sel;
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (moves[e.key]) {
        e.preventDefault();
        if (!st.order.length) return;
        const pos = Math.min(st.order.length - 1, Math.max(0, st.order.indexOf(r) + moves[e.key][0]));
        selectCell(st.order[pos], Math.min(R.columns.length - 1, Math.max(0, c + moves[e.key][1])));
      } else if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        editCell(r, c);
      } else if (mod && e.key.toLowerCase() === "c") copyText(r, c);
      else if (mod && (e.key === "Delete" || e.key === "Backspace")) deleteRow(r);
      else if (e.key === "Delete" && R.edit) setValue(r, c, null);
      else if (R.edit && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        editCell(r, c);
        const input = $(".cell-input", host);
        if (input) {
          input.value = e.key;
          e.preventDefault();
        }
      }
    });

    const inst = {
      isDirty: () => gridDirty() || fileDirty(),
      // Ctrl+S: lưu file (chế độ file) rồi lưu thay đổi trong lưới kết quả
      save: async () => (fileDirty() && !(await saveFile())) ? false : save(),
      focus: () => st.editor?.focus(),
      layout: () => st.editor?.layout(),
      dispose() {
        st.disposed = true;
        clearTimeout(st.autoTimer);
        st.editor?.getModel()?.dispose();
        st.editor?.dispose();
      },
    };
    if (file) {
      Object.assign(inst, {
        path: file,
        size: () => st.size,
        reveal(line, column = 1, endColumn = 0) {
          if (!st.editor) return setTimeout(() => inst.reveal(line, column, endColumn), 200);
          if (endColumn > column) st.editor.setSelection({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn });
          else st.editor.setPosition({ lineNumber: line, column });
          st.editor.focus();
          requestAnimationFrame(() => st.editor.revealPositionInCenter({ lineNumber: line, column }));
        },
        // đọc lại sau khi file bị sửa ở nơi khác (vd. Replace của Search); bỏ qua nếu đang có thay đổi chưa lưu
        async reload() {
          if (!st.editor || fileDirty()) return false;
          const f = await api("GET", `/api/files/read?path=${encodeURIComponent(file)}`);
          if (f.content == null || fileDirty()) return false;
          st.mtime = f.mtime;
          st.size = f.size;
          if (f.content !== st.editor.getValue()) {
            st.saved = f.content;
            const model = st.editor.getModel();
            model.pushEditOperations([], [{ range: model.getFullModelRange(), text: f.content }], () => null);
          }
          return true;
        },
      });
    }
    return inst;
  }

  // ---------- gợi ý SQL ----------
  let completionRegistered = false;
  const KEYWORDS = "SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING GROUP BY ORDER ASC DESC HAVING LIMIT OFFSET FETCH FIRST ROWS ONLY DISTINCT AS CASE WHEN THEN ELSE END UNION ALL INTERSECT EXCEPT INSERT INTO VALUES UPDATE SET DELETE RETURNING CREATE TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES DEFAULT CHECK CONSTRAINT ALTER ADD COLUMN DROP RENAME TO TRUNCATE CASCADE BEGIN COMMIT ROLLBACK WITH RECURSIVE EXPLAIN ANALYZE TRUE FALSE".split(" ");
  const FUNCTIONS = "COUNT SUM AVG MIN MAX COALESCE NULLIF CAST CONCAT LENGTH LOWER UPPER TRIM SUBSTRING REPLACE NOW CURRENT_DATE CURRENT_TIMESTAMP DATE_TRUNC EXTRACT TO_CHAR ROUND ABS STRING_AGG ARRAY_AGG JSON_AGG ROW_NUMBER RANK DENSE_RANK LAG LEAD GETDATE ISNULL IFNULL DATE_FORMAT".split(" ");

  function registerSqlCompletion(monaco) {
    if (completionRegistered) return;
    completionRegistered = true;
    for (const lang of ["sql", "pgsql", "mysql"]) {
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: [".", " "],
        async provideCompletionItems(model, position) {
          const ctx = model.dashSql?.();
          const word = model.getWordUntilPosition(position);
          const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
          const K = monaco.languages.CompletionItemKind;
          let rows = [];
          if (ctx && connected.has(ctx.conn)) rows = await loadSchema(ctx.conn, ctx.db).catch(() => []);
          const tables = groupTables(rows);
          const allTables = [...tables].flatMap(([schema, t]) => [...t].map(([name, v]) => ({ schema, name, ...v })));
          const text = model.getValue();
          const before = model.getValueInRange({ startLineNumber: Math.max(1, position.lineNumber - 30), startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
          // alias.cột
          const dot = before.match(/([\w"`\]\[]+)\.(\w*)$/);
          const aliases = new Map();
          for (const m of text.matchAll(/\b(?:from|join|update|into)\s+((?:[\w"`\[\]]+\.)?[\w"`\[\]]+)(?:\s+(?:as\s+)?(\w+))?/gi)) {
            const tname = m[1].split(".").pop().replace(/["`\[\]]/g, "");
            aliases.set(tname.toLowerCase(), tname);
            if (m[2] && !/^(where|on|join|left|right|inner|set|values|group|order|limit)$/i.test(m[2])) aliases.set(m[2].toLowerCase(), tname);
          }
          const colsOf = (tname) => allTables.filter((t) => t.name === tname).flatMap((t) => t.cols);
          if (dot) {
            const target = dot[1].replace(/["`\[\]]/g, "");
            const tname = aliases.get(target.toLowerCase());
            if (tname) return { suggestions: colsOf(tname).map((c) => ({ label: c.column, kind: K.Field, insertText: c.column, detail: `${c.type}${c.pk ? " · PK" : ""}`, range, sortText: "0" })) };
            // schema.bảng
            if (tables.has(target)) return { suggestions: [...tables.get(target).keys()].map((t) => ({ label: t, kind: K.Struct, insertText: t, range })) };
          }
          const wantsTable = /\b(from|join|update|into|table)\s+[\w"`.]*$/i.test(before);
          const suggestions = [];
          for (const t of allTables) suggestions.push({ label: t.name, kind: t.view ? K.Interface : K.Struct, insertText: t.name, detail: `${t.view ? "view" : "table"} · ${t.schema}`, range, sortText: wantsTable ? "0" : "2" });
          if (!wantsTable) {
            const used = new Set(aliases.values());
            for (const t of allTables.filter((x) => used.has(x.name))) for (const c of t.cols) suggestions.push({ label: c.column, kind: K.Field, insertText: c.column, detail: `${t.name}.${c.type}`, range, sortText: "1" });
            for (const k of KEYWORDS) suggestions.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: "3" });
            for (const f of FUNCTIONS) suggestions.push({ label: f, kind: K.Function, insertText: `${f}($0)`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, sortText: "4" });
          }
          return { suggestions };
        },
      });
    }
  }

  // ---------- backup / restore ----------
  function fileSize(n) {
    return n > 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
  }

  async function dbOptions(id, selected) {
    const c = conn(id);
    let dbs = [];
    try {
      dbs = await loadDatabases(c);
    } catch {}
    return [...new Set([selected || c.database, ...dbs].filter(Boolean))].map((d) => `<option ${d === (selected || c.database) ? "selected" : ""}>${esc(d)}</option>`).join("");
  }

  async function backupModal(pre = {}) {
    if (!conns().length) return connModal();
    const id = pre.conn || store.get("dbLastConn", conns()[0].id);
    const m = openModal(
      "Backup database",
      `<form id="bk-form" class="form">
        <label class="field"><span>Connection</span><select name="conn">${conns().map((c) => `<option value="${c.id}" ${c.id === id ? "selected" : ""}>${esc(c.name)} · ${TYPES[c.type]}</option>`).join("")}</select></label>
        <label class="field net"><span>Database</span><input name="database" list="bk-dbs" class="mono" value="${esc(pre.db || conn(id).database || "")}" /><datalist id="bk-dbs"></datalist></label>
        <label class="field pg"><span>Format</span><select name="format"><option value="custom">Custom (-Fc, for pg_restore)</option><option value="plain">Plain SQL</option></select></label>
        <label class="field pg my"><span>Content</span><select name="content"><option value="">Schema + data</option><option value="schema">Schema only</option><option value="data">Data only</option></select></label>
        <label class="field full"><span>Output file</span><input name="file" class="mono" placeholder="Empty = ${esc(W.ws().backupDir)}/<connection>-<db>-<time>.backup" />
          <small class="ms hidden">For SQL Server this path is on the <b>SQL Server host</b> (e.g. /var/opt/mssql/backup/db.bak).</small></label>
      </form>`,
      `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="bk-form">⤓ Start backup</button>`
    );
    const form = $("#bk-form", m);
    const sync = async () => {
      const c = conn(form.conn.value);
      $$(".net", form).forEach((x) => x.classList.toggle("hidden", c.type === "sqlite"));
      $$(".pg", form).forEach((x) => x.classList.toggle("hidden", c.type !== "postgres" && !(x.classList.contains("my") && c.type === "mysql")));
      $(".ms", form).classList.toggle("hidden", c.type !== "mssql");
      $("#bk-dbs", form).innerHTML = await dbOptions(c.id, form.database.value);
    };
    form.conn.onchange = () => {
      form.database.value = conn(form.conn.value).database || "";
      sync();
    };
    sync();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const r = await guarded(() => api("POST", `/api/databases/${f.conn}/backup`, { database: f.database, format: f.format, file: f.file, schemaOnly: f.content === "schema", dataOnly: f.content === "data" }));
      if (!r) return;
      closeModal();
      showJob(r.key, `Backup → ${r.file}`);
    };
  }

  // Xoá database: gõ đúng tên để xác nhận, mặc định backup trước (backup lỗi thì không xoá)
  function dropModal(id, db) {
    const c = conn(id);
    const m = openModal(
      "Drop database",
      `<form id="drop-form" class="form">
        <div class="field full"><div class="notice danger">This permanently deletes <b class="mono">${esc(db)}</b> on <b>${esc(c.name)}</b>, with all its tables and data. Other connections to it are closed first.</div></div>
        <label class="field full"><span>Type the database name to confirm</span><input name="confirm" class="mono" autocomplete="off" spellcheck="false" placeholder="${esc(db)}" /></label>
        <label class="field full check-field"><label class="check"><input type="checkbox" name="backup" checked /> Back up first (recommended). If the backup fails, nothing is dropped.</label></label>
        <label class="field full bk"><span>Backup file</span><input name="file" class="mono" placeholder="Empty = ${esc(W.ws().backupDir)}/<connection>-<db>-<time>.backup" />
          ${c.type === "mssql" ? `<small>For SQL Server this path is on the <b>SQL Server host</b>.</small>` : ""}</label>
      </form>`,
      `<button class="btn" data-action="close-modal">Cancel</button><button class="btn danger" form="drop-form" disabled>Drop database</button>`
    );
    const form = $("#drop-form", m);
    const ok = $(".modal-foot .danger", m);
    form.confirm.oninput = () => (ok.disabled = form.confirm.value !== db);
    form.backup.onchange = () => $(".bk", form).classList.toggle("hidden", !form.backup.checked);
    form.confirm.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (form.confirm.value !== db) return;
      const r = await guarded(() => api("POST", `/api/databases/${id}/drop`, { database: db, backup: form.backup.checked, file: form.file.value }));
      if (!r) return;
      closeModal();
      showJob(r.key, `Drop ${c.name} / ${db}${r.file ? ` (backup → ${r.file})` : ""}`);
      const { code } = await api("POST", "/api/jobs/wait", { key: r.key }).catch(() => ({ code: null }));
      treeData.delete(`dbs:${id}`);
      treeData.delete(`schema:${id}:${db}`);
      expanded.delete(`d:${id}:${db}`);
      paintTree();
      toast(code === 0 ? `Dropped ${db}` : `Drop of ${db} did not finish, see the Output panel`, code === 0 ? "ok" : "error");
    };
  }

  async function restoreModal(pre = {}) {
    if (!conns().length) return connModal();
    const id = pre.conn || store.get("dbLastConn", conns()[0].id);
    const backups = await api("GET", "/api/backups").catch(() => []);
    const m = openModal(
      "Restore database",
      `<form id="rs-form" class="form">
        <label class="field full"><span>Backup file</span><input name="file" class="mono" list="rs-files" placeholder="/path/to/db.backup  (.backup / .dump = pg_restore, .sql = psql)" required />
          <datalist id="rs-files">${backups.map((b) => `<option value="${esc(b.path)}">${esc(b.name)} · ${fileSize(b.size)} · ${new Date(b.mtime).toLocaleString("en-GB")}</option>`).join("")}</datalist>
          <small>Recent backups in <code>${esc(W.ws().backupDir)}</code> are suggested. For SQL Server the path is on the server host.</small></label>
        <label class="field"><span>Target connection</span><select name="conn">${conns().map((c) => `<option value="${c.id}" ${c.id === id ? "selected" : ""}>${esc(c.name)} · ${TYPES[c.type]}</option>`).join("")}</select></label>
        <label class="field net"><span>Target database</span><input name="database" list="rs-dbs" class="mono" value="${esc(pre.db || conn(id).database || "")}" required /><datalist id="rs-dbs"></datalist></label>
        <div class="field full net"><label class="check"><input type="checkbox" name="recreate" checked /> <b>Drop and recreate the target database first</b> (closes its connections first)</label></div>
        <div class="field full pg"><label class="check"><input type="checkbox" name="clean" /> Clean (drop objects before recreating them) — when not recreating</label>
          <label class="check"><input type="checkbox" name="noOwner" checked /> --no-owner</label>
          <label class="check"><input type="checkbox" name="noPrivileges" checked /> --no-privileges</label>
          <label class="check">Parallel jobs <input name="jobs" type="number" min="1" max="16" value="1" style="width:64px" /></label></div>
        <div class="field full"><div class="notice warn rs-warn"></div></div>
        <label class="field full"><span>Type the target database name to confirm</span><input name="confirm" class="mono" autocomplete="off" /></label>
      </form>`,
      `<button class="btn" data-action="close-modal">Cancel</button><button class="btn danger" form="rs-form">⤒ Restore</button>`,
      true
    );
    const form = $("#rs-form", m);
    const sync = async () => {
      const c = conn(form.conn.value);
      $$(".net", form).forEach((x) => x.classList.toggle("hidden", c.type === "sqlite"));
      $$(".pg", form).forEach((x) => x.classList.toggle("hidden", c.type !== "postgres"));
      if (c.type === "sqlite") form.database.value = "main";
      $(".rs-warn", form).innerHTML =
        c.type === "sqlite"
          ? `The SQLite file <code>${esc(c.file)}</code> will be replaced (the old file is kept as <code>.before-restore</code>).`
          : `Data in <b>${esc(form.database.value || "?")}</b> on <b>${esc(c.name)}</b> (${esc(c.host)}:${esc(c.port)}) ${form.recreate.checked ? "will be <b>deleted</b> and replaced by the backup" : "will be overwritten where the backup has the same objects"}. Back it up first if unsure.`;
      $("#rs-dbs", form).innerHTML = await dbOptions(c.id, form.database.value);
    };
    form.addEventListener("input", sync);
    form.conn.onchange = () => {
      form.database.value = conn(form.conn.value).database || "";
      sync();
    };
    sync();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      if (f.confirm.trim() !== f.database.trim()) return toast("Type the target database name exactly to confirm", "error");
      const r = await guarded(() =>
        api("POST", `/api/databases/${f.conn}/restore`, { file: f.file, database: f.database, recreate: Boolean(f.recreate), clean: Boolean(f.clean), noOwner: Boolean(f.noOwner), noPrivileges: Boolean(f.noPrivileges), jobs: Number(f.jobs) || 1 })
      );
      if (!r) return;
      closeModal();
      showJob(r.key, `Restore ${f.file} → ${f.database}`);
      treeData.clear();
    };
  }

  // ---------- log tác vụ (panel Output) ----------
  let job = { key: null, es: null, text: "", title: "" };
  function showJob(key, title) {
    job.es?.close();
    job = { key, title, text: "", es: new EventSource(`/api/logs/stream?key=${encodeURIComponent(key)}`) };
    job.es.addEventListener("reset", () => {
      job.text = "";
      paintJob();
    });
    job.es.addEventListener("data", (e) => {
      job.text += JSON.parse(e.data);
      if (job.text.length > 300000) job.text = job.text.slice(-200000);
      paintJob();
    });
    W.showPanel("output");
  }
  W.showJob = showJob;
  function paintJob() {
    const el = $(".panel-view[data-panel-view=output] pre");
    if (!el) return;
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.innerHTML = window.ansiToHtml ? ansiToHtml(job.text) : esc(job.text);
    if (stick) el.scrollTop = el.scrollHeight;
    $(".panel-view[data-panel-view=output] .out-title").textContent = job.title || "No task yet";
  }
  W.registerPanel("output", {
    title: "Output",
    order: 3,
    mount: (el) => {
      el.innerHTML = `<div class="out"><div class="out-bar"><span class="out-title faint"></span><button class="btn sm danger" data-out="stop">■ Stop</button><button class="btn sm ghost" data-out="clear">Clear view</button></div><pre class="log out-log"></pre></div>`;
      el.addEventListener("click", (e) => {
        const b = e.target.closest("[data-out]");
        if (!b) return;
        if (b.dataset.out === "clear") {
          job.text = "";
          paintJob();
        }
        if (b.dataset.out === "stop" && job.key) api("POST", "/api/jobs/stop", { key: job.key }).then(() => toast("Stopped", "ok")).catch((err) => toast(err.message, "error"));
      });
      paintJob();
    },
  });

  W.registerView("database", { title: "Database", icon: W.ICON.db, order: 5, key: "view.database", mount, show: () => root && paintTree() });
  W.command("view.database", "Show Database", () => W.showView("database"), "Ctrl+Shift+Y");
  W.command("db.newQuery", "Database: new query", () => newQuery(), "Ctrl+Alt+Q");
  W.command("db.addConnection", "Database: add connection…", () => connModal());
  W.command("db.backup", "Database: backup…", () => backupModal());
  W.command("db.restore", "Database: restore…", () => restoreModal());
})();
