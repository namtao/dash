"use strict";
// Explorer: cây thư mục của thư mục hiện tại, mở file bằng Monaco (lưu Ctrl+S, báo khi file bị sửa ở nơi khác),
// tạo/đổi tên/xoá, mở terminal tại thư mục, mở nhanh file bằng Ctrl+P.
(() => {
  const open = new Set(store.get("explorerOpen", [])); // thư mục đang mở rộng
  const cache = new Map(); // dir -> items
  let root = null;
  let selected = null;
  let gitMarks = new Map(); // đường dẫn tuyệt đối -> chữ trạng thái git
  let gitIgnored = new Set(); // đường dẫn tuyệt đối bị .gitignore (thư mục ignore chỉ có một mục)
  let gitRoot = "";

  const saveOpen = () => store.set("explorerOpen", [...open].slice(-300));
  const join = (a, b) => `${a.replace(/\/+$/, "")}/${b}`;

  async function listDir(dir, force) {
    if (!force && cache.has(dir)) return cache.get(dir);
    const r = await api("GET", `/api/files/list?path=${encodeURIComponent(dir)}`);
    cache.set(dir, r.items);
    return r.items;
  }

  // Bị ignore khi chính nó hoặc một thư mục cha trong repo bị ignore (như VS Code tô mờ cả nhánh)
  const isIgnored = (full) => {
    if (!gitIgnored.size || !full.startsWith(gitRoot + "/")) return false;
    for (let p = full; p.length > gitRoot.length; p = p.slice(0, p.lastIndexOf("/"))) if (gitIgnored.has(p)) return true;
    return false;
  };

  async function renderDir(dir, depth) {
    let items;
    try {
      items = await listDir(dir);
    } catch (e) {
      return `<div class="tree-row faint" style="padding-left:${8 + depth * 12}px">${esc(e.message)}</div>`;
    }
    let html = "";
    for (const it of items) {
      const full = join(dir, it.name);
      const isOpen = it.dir && open.has(full);
      const mark = gitMarks.get(full) || (it.dir && [...gitMarks.keys()].some((k) => k.startsWith(full + "/")) ? "•" : "");
      html += `<div class="tree-row ${it.dir ? "dir" : "file"} ${it.dim ? "dim" : ""} ${isIgnored(full) ? "git-ignored" : ""} ${selected === full ? "sel" : ""} ${mark ? `git-${mark === "•" ? "dot" : mark}` : ""}" data-path="${esc(full)}" data-dir="${it.dir ? 1 : 0}" style="padding-left:${8 + depth * 12}px" draggable="true">
        <span class="twisty">${it.dir ? (isOpen ? "▾" : "▸") : ""}</span>${it.dir ? W.folderIcon(it.name, isOpen) : W.fileIcon(it.name)}<span class="fname">${esc(it.name)}</span>${mark ? `<span class="gmark">${mark === "•" ? "•" : mark}</span>` : ""}</div>`;
      if (isOpen) html += await renderDir(full, depth + 1);
    }
    return html;
  }

  async function paint() {
    if (!root) return;
    const body = $(".tree", root);
    $(".tree-root", root).textContent = W.base(W.folder).toUpperCase();
    $(".tree-root", root).title = W.folder;
    const scroll = body.scrollTop;
    body.innerHTML = await renderDir(W.folder, 0);
    body.scrollTop = scroll;
  }

  async function refreshGit() {
    gitMarks = new Map();
    gitIgnored = new Set();
    gitRoot = "";
    try {
      const s = await api("GET", `/api/git/status?dir=${encodeURIComponent(W.folder)}`);
      for (const c of [...s.staged, ...s.changes, ...s.conflicts]) gitMarks.set(join(s.root, c.path), c.status === "?" ? "U" : c.status);
      gitRoot = s.root.replace(/\/+$/, "");
      gitIgnored = new Set((s.ignored || []).map((p) => join(gitRoot, p)));
    } catch {}
  }

  async function refresh(force = true) {
    if (force) cache.clear();
    await refreshGit();
    await paint();
  }
  W.explorerRefresh = refresh;

  async function newItem(dir, isDir) {
    const name = await W.prompt(isDir ? "New folder" : "New file", "", { label: `In ${W.shortPath(dir)}` });
    if (!name) return;
    const target = join(dir, name.trim());
    await api("POST", "/api/files/create", { path: target, dir: isDir }).catch((e) => toast(e.message, "error"));
    open.add(dir);
    saveOpen();
    await refresh();
    if (!isDir) openFile(target);
  }

  async function renameItem(p) {
    const name = await W.prompt("Rename", W.base(p));
    if (!name || name === W.base(p)) return;
    const to = join(p.slice(0, p.lastIndexOf("/")), name);
    if (await guarded(() => api("POST", "/api/files/rename", { from: p, to }))) {
      const t = W.findTab(`file:${p}`);
      if (t) W.closeTab(t.id, { force: false });
      refresh();
    }
  }

  async function deleteItem(p, isDir) {
    if (!(await confirmDialog(`Delete ${isDir ? "folder" : "file"} "${W.shortPath(p)}"?${isDir ? "\nEverything inside it is deleted." : ""}\nThis cannot be undone.`, { title: `Delete ${isDir ? "folder" : "file"}`, ok: "Delete", danger: true }))) return;
    if (await guarded(() => api("POST", "/api/files/delete", { path: p }), "Deleted")) {
      const t = W.findTab(`file:${p}`);
      if (t) W.closeTab(t.id, { force: true });
      refresh();
    }
  }

  function mount(body, actions) {
    root = body;
    body.innerHTML = `<div class="tree-head"><span class="tree-root"></span></div><div class="tree"></div>`;
    actions.innerHTML = `<button class="icon" data-ex="newfile" title="New file">＋</button><button class="icon" data-ex="newdir" title="New folder">⊞</button><button class="icon" data-ex="refresh" title="Refresh">↻</button><button class="icon" data-ex="collapse" title="Collapse all">⊟</button><button class="icon" data-cmd="folder.open" title="Open folder (${esc(W.keyFor("folder.open"))})">📂</button>`;
    actions.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ex]");
      if (!b) return;
      const base = selected && cache.has(selected) ? selected : W.folder;
      if (b.dataset.ex === "newfile") newItem(base, false);
      if (b.dataset.ex === "newdir") newItem(base, true);
      if (b.dataset.ex === "refresh") refresh();
      if (b.dataset.ex === "collapse") {
        open.clear();
        saveOpen();
        paint();
      }
    });
    const tree = $(".tree", body);
    tree.addEventListener("click", async (e) => {
      const row = e.target.closest(".tree-row[data-path]");
      if (!row) return;
      const p = row.dataset.path;
      selected = p;
      if (row.dataset.dir === "1") {
        if (open.has(p)) open.delete(p);
        else open.add(p);
        saveOpen();
        paint();
      } else {
        $$(".tree-row.sel", tree).forEach((x) => x.classList.remove("sel"));
        row.classList.add("sel");
        openFile(p, { preview: true });
      }
    });
    tree.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".tree-row.file");
      if (row) openFile(row.dataset.path);
    });
    tree.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".tree-row[data-path]");
      const p = row?.dataset.path || W.folder;
      const isDir = !row || row.dataset.dir === "1";
      const dir = isDir ? p : p.slice(0, p.lastIndexOf("/"));
      W.menu(e, [
        { label: "New file…", run: () => newItem(dir, false) },
        { label: "New folder…", run: () => newItem(dir, true) },
        { sep: true },
        ...(isDir ? [{ label: "Open as current folder", run: () => W.setFolder(p) }] : [{ label: "Open", run: () => openFile(p) }]),
        ...(!isDir ? [{ label: "Open as text", run: () => openFile(p, { asText: true }) }] : []),
        { label: "Open terminal here", run: () => W.term.create({ cwd: dir }) },
        { label: "Generate file tree", run: () => fileTree(isDir ? p : dir) },
        ...(!isDir ? [{ label: isReadonly(p) ? "Allow editing" : "Make read-only", run: () => { const t = W.findTab(`file:${p}`); if (t?.inst?.toggleReadonly) t.inst.toggleReadonly(); else setReadonly(p, !isReadonly(p)); } }] : []),
        { label: "Ask Claude about this", run: () => W.claudeMention?.(p) },
        { label: "Copy path", run: () => navigator.clipboard?.writeText(p) },
        { label: "Copy relative path", run: () => navigator.clipboard?.writeText(p.slice(W.folder.length + 1)) },
        ...(row ? [{ sep: true }, { label: "Rename…", run: () => renameItem(p), key: "F2" }, { label: "Delete", danger: true, run: () => deleteItem(p, isDir), key: "Delete" }] : []),
      ]);
    });
    tree.tabIndex = 0;
    tree.addEventListener("keydown", (e) => {
      if (!selected) return;
      const row = $(`.tree-row[data-path="${CSS.escape(selected)}"]`, tree);
      if (e.key === "F2") renameItem(selected);
      else if (e.key === "Delete") deleteItem(selected, row?.dataset.dir === "1");
      else if (e.key === "Enter" && row?.dataset.dir === "0") openFile(selected);
    });
    // kéo file sang Claude để nhắc tên
    tree.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".tree-row[data-path]");
      if (row) e.dataTransfer.setData("text/plain", row.dataset.path);
    });
    refresh(false);
  }

  // ---------- editor file ----------
  const fmtSize = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const rawUrl = (p) => `/api/files/raw?path=${encodeURIComponent(p)}`;
  const dirOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
  // URL xem trước HTML theo đường dẫn (route /api/files/view trong server.js), để đường dẫn tương đối trong trang tự đúng
  const viewUrl = (p) => {
    const enc = (s) => s.split("/").map(encodeURIComponent).join("/");
    const m = p.match(/^ssh:\/\/([^/]+)(\/.*)$/);
    return `/api/files/view/${m ? `ssh/${encodeURIComponent(m[1])}${enc(m[2])}` : `local${enc(p)}`}`;
  };

  // Nạp thư viện của trình xem khi cần (chỉ một lần). Loader AMD của Monaco đặt define.amd, khiến thư viện UMD
  // tự đăng ký thành module AMD thay vì biến toàn cục (marked, DOMPurify…), nên tạm ẩn define.amd khi nạp.
  const scripts = new Map();
  let amdHidden = 0;
  let savedAmd;
  W.loadScript = (src) => {
    if (!scripts.has(src)) {
      scripts.set(
        src,
        new Promise((resolve, reject) => {
          const el = document.createElement("script");
          el.src = src;
          const hide = Boolean(window.define);
          if (hide && amdHidden++ === 0) {
            savedAmd = window.define.amd;
            window.define.amd = undefined;
          }
          const restore = () => {
            if (hide && --amdHidden === 0) window.define.amd = savedAmd;
          };
          el.onload = () => {
            restore();
            resolve();
          };
          el.onerror = () => {
            restore();
            scripts.delete(src);
            reject(new Error(`Could not load ${src}`));
          };
          document.head.append(el);
        })
      );
    }
    return scripts.get(src);
  };
  // HTML lấy từ file (markdown, docx) phải được làm sạch: script chạy trong Dash có thể chạy lệnh trên máy
  async function sanitize(html) {
    await W.loadScript("/vendor/dompurify/purify.min.js");
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }

  // Markdown -> HTML; mỗi khối cấp cao nhất mang data-line = dòng nguồn (tính từ 1) để đồng bộ cuộn với editor
  function markdownHtml(text) {
    const lines = (a, b) => {
      let n = 0;
      for (let i = a; i < b; i++) if (text.charCodeAt(i) === 10) n++;
      return n;
    };
    let pos = 0;
    let line = 1;
    return marked
      .lexer(text, { gfm: true })
      .map((t) => {
        const at = t.raw ? text.indexOf(t.raw, pos) : -1;
        if (at >= 0) (line += lines(pos, at)), (pos = at);
        const start = line;
        if (at >= 0) (line += lines(at, at + t.raw.length)), (pos = at + t.raw.length);
        return marked.parser([t], { gfm: true }).replace(/^\s*<([a-z][\w-]*)/i, `<$1 data-line="${start}"`);
      })
      .join("");
  }

  // Markdown -> HTML an toàn; ảnh / link tương đối tính theo thư mục của file
  async function renderMarkdown(el, text, file) {
    await W.loadScript("/vendor/marked/marked.umd.js");
    el.innerHTML = await sanitize(markdownHtml(text));
    const base = dirOf(file);
    const resolve = (href) => (href.startsWith("/") && !W.isRemote(file) ? href : `${base}/${href}`.replace(/\/\.\//g, "/"));
    for (const img of el.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src");
      if (!/^(https?:|data:)/.test(src)) img.src = rawUrl(resolve(src));
    }
    for (const a of el.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (/^https?:/.test(href)) {
        a.target = "_blank";
        a.rel = "noopener";
      } else if (!href.startsWith("#")) {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          openFile(resolve(href.split("#")[0]));
        });
      }
    }
  }
  W.renderMarkdown = renderMarkdown;

  const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
  function viewerKind(p) {
    if (IMAGE_RE.test(p)) return "image";
    if (/\.pdf$/i.test(p)) return "pdf";
    if (/\.(csv|tsv)$/i.test(p)) return "csv";
    if (/\.docx$/i.test(p)) return "docx";
    if (/\.xlsx$/i.test(p)) return "xlsx";
    if (/\.(doc|xls|ppt|pptx|odt|ods)$/i.test(p)) return "unsupported";
    return null;
  }

  function parseCsv(text, sep) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === sep) row.push(cell), (cell = "");
      else if (ch === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
      else if (ch !== "\r") cell += ch;
    }
    if (cell || row.length) row.push(cell), rows.push(row);
    return rows;
  }

  const MAX_ROWS = 5000;
  function gridHtml(rows, { header = true, letters = false } = {}) {
    const cols = Math.max(0, ...rows.map((r) => r.length));
    const colName = (i) => {
      let s = "";
      for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
      return s;
    };
    const head = letters ? Array.from({ length: cols }, (_, i) => colName(i)) : header ? rows[0] || [] : [];
    const body = (letters || !header ? rows : rows.slice(1)).slice(0, MAX_ROWS);
    return `<table class="rgrid"><thead><tr><th class="rn"></th>${Array.from({ length: cols }, (_, i) => `<th>${esc(head[i] ?? "")}</th>`).join("")}</tr></thead><tbody>${body
      .map((r, n) => `<tr><td class="rn">${n + 1}</td>${Array.from({ length: cols }, (_, i) => `<td title="${esc(r[i] ?? "")}">${esc(r[i] ?? "")}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>${rows.length > MAX_ROWS ? `<div class="empty faint">Showing the first ${MAX_ROWS} rows of ${rows.length}.</div>` : ""}`;
  }

  // Trình xem cho file không sửa bằng editor: ảnh, PDF, CSV, Word (.docx), Excel (.xlsx)
  function createViewer(host, tab, p, kind) {
    host.classList.add("code-host");
    const textable = kind === "csv" || /\.svg$/i.test(p);
    host.innerHTML = `<div class="crumbs"><span class="crumb-path">${esc(W.shortPath(p))}</span><span class="crumb-actions">
        ${textable ? `<button class="btn sm ghost" data-v="text" title="Open in the text editor">Edit as text</button>` : ""}
        <button class="btn sm ghost" data-v="reload" title="Reload">↻</button></span></div>
      <div class="viewer viewer-${kind}"><div class="loading"><span class="spinner"></span></div></div>`;
    const box = $(".viewer", host);
    const st = { size: null, url: null };
    async function load() {
      box.innerHTML = `<div class="loading"><span class="spinner"></span></div>`;
      try {
        if (kind === "unsupported") {
          box.innerHTML = `<div class="empty">This old Office format cannot be previewed. Save it as .docx / .xlsx / .pdf to view it here.</div>`;
          return;
        }
        const res = await fetch(rawUrl(p));
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const blob = await res.blob();
        st.size = blob.size;
        W.emit("file:info");
        if (st.url) URL.revokeObjectURL(st.url);
        if (kind === "image" || kind === "pdf") st.url = URL.createObjectURL(blob);
        if (kind === "image") box.innerHTML = `<div class="img-view"><img src="${st.url}" alt="${esc(W.base(p))}" /><div class="faint img-meta"></div></div>`;
        else if (kind === "pdf") box.innerHTML = `<iframe class="pdf-view" src="${st.url}" title="${esc(W.base(p))}"></iframe>`;
        else if (kind === "csv") {
          const rows = parseCsv(await blob.text(), /\.tsv$/i.test(p) ? "\t" : ",");
          box.innerHTML = `<div class="grid-view">${gridHtml(rows)}</div>`;
        } else if (kind === "docx") {
          await W.loadScript("/vendor/mammoth/mammoth.browser.min.js");
          const r = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
          box.innerHTML = `<div class="doc-view md-body">${await sanitize(r.value)}</div>`;
        } else if (kind === "xlsx") {
          await W.loadScript("/vendor/exceljs/exceljs.min.js");
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(await blob.arrayBuffer());
          const sheets = wb.worksheets.map((ws) => {
            const rows = [];
            const cols = Math.min(200, ws.actualColumnCount || ws.columnCount || 0);
            ws.eachRow({ includeEmpty: true }, (row, n) => {
              if (n > MAX_ROWS + 1) return;
              rows[n - 1] = Array.from({ length: cols }, (_, i) => row.getCell(i + 1).text);
            });
            return { name: ws.name, rows: Array.from(rows, (r) => r || []) };
          });
          const show = (i) => {
            $$(".sheet-tab", box).forEach((b, j) => b.classList.toggle("active", i === j));
            $(".grid-view", box).innerHTML = sheets[i]?.rows.length ? gridHtml(sheets[i].rows, { letters: true }) : `<div class="empty faint">Empty sheet</div>`;
          };
          box.innerHTML = `<div class="sheet-tabs">${sheets.map((s, i) => `<button class="sheet-tab" data-sheet="${i}">${esc(s.name)}</button>`).join("")}</div><div class="grid-view"></div>`;
          box.onclick = (e) => {
            const b = e.target.closest("[data-sheet]");
            if (b) show(Number(b.dataset.sheet));
          };
          show(0);
        }
        const img = $(".img-view img", box);
        if (img) img.onload = () => ($(".img-meta", box).textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${fmtSize(st.size)}`);
      } catch (e) {
        box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
    }
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-v]");
      if (!b) return;
      if (b.dataset.v === "reload") return load();
      W.closeTab(tab.id, { force: true });
      openFile(p, { asText: true });
    });
    load();
    return {
      path: p,
      size: () => st.size,
      layout() {},
      focus() {},
      dispose: () => st.url && URL.revokeObjectURL(st.url),
    };
  }

  // ----- format / báo lỗi -----
  let formattersReady = false;
  async function loadPrettier(plugins) {
    await W.loadScript("/vendor/prettier/standalone.js");
    for (const pl of plugins) await W.loadScript(`/vendor/prettier/plugins/${pl}.js`);
  }
  // Monaco tự format JSON, CSS, HTML, JS/TS. Thêm: prettier (YAML, Markdown, GraphQL, SCSS, Less), sql-formatter,
  // và công cụ trên máy qua server (ruff/black, shfmt, gofmt, rustfmt, clang-format, stylua, taplo).
  function registerFormatters(monaco) {
    if (formattersReady) return;
    formattersReady = true;
    const provide = (lang, fn) =>
      monaco.languages.registerDocumentFormattingEditProvider(lang, {
        async provideDocumentFormattingEdits(model, options) {
          try {
            const text = await fn(model.getValue(), options, model);
            return text == null || text === model.getValue() ? [] : [{ range: model.getFullModelRange(), text }];
          } catch (e) {
            toast(`Format failed: ${String(e.message).split("\n")[0]}`, "error");
            return [];
          }
        },
      });
    const PRETTIER = { yaml: ["yaml", ["yaml"]], markdown: ["markdown", ["markdown"]], graphql: ["graphql", ["graphql"]], scss: ["scss", ["postcss"]], less: ["less", ["postcss"]] };
    for (const [lang, [parser, plugins]] of Object.entries(PRETTIER)) {
      provide(lang, async (text, o) => {
        await loadPrettier(plugins);
        return prettier.format(text, { parser, plugins: Object.values(prettierPlugins), tabWidth: o.tabSize, useTabs: !o.insertSpaces, proseWrap: "preserve" });
      });
    }
    provide("sql", async (text, o) => sqlFormatter.format(text, { tabWidth: o.tabSize, keywordCase: "upper" }));
    for (const lang of ["python", "shell", "go", "rust", "c", "cpp", "java", "lua", "ini"]) {
      provide(lang, async (text, o, model) => {
        if (lang === "ini" && !/\.toml$/i.test(model.dashPath || "")) throw new Error("No formatter for this file type");
        return (await api("POST", "/api/code/format", { lang, content: text, path: model.dashPath || "" })).content;
      });
    }
    // JS/TS: kiểm tra ngữ nghĩa như VS Code (tên chưa khai báo, sai kiểu, gọi sai hàm…). Bỏ qua lỗi "không tìm
    // thấy module / kiểu của thư viện" vì editor không đọc node_modules, và thêm sẵn biến toàn cục của Node.
    const ts = monaco.typescript || monaco.languages.typescript;
    if (ts) {
      const IGNORE = [2307, 2792, 7016, 2580, 2591, 2582, 2593, 80001, 80005, 1375, 1378, 2686, 2875];
      const base = { allowJs: true, allowNonTsExtensions: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, allowSyntheticDefaultImports: true, noEmit: true, skipLibCheck: true };
      ts.javascriptDefaults.setCompilerOptions({ ...base, checkJs: true });
      ts.typescriptDefaults.setCompilerOptions({ ...base, strict: false });
      for (const d of [ts.javascriptDefaults, ts.typescriptDefaults]) {
        d.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: IGNORE });
        d.addExtraLib("declare var require: any; declare var module: any; declare var exports: any; declare var process: any; declare var __dirname: string; declare var __filename: string; declare var Buffer: any; declare var global: any;", "file:///dash-node-globals.d.ts");
      }
    }
    // Tên chưa khai báo ở JS (2304, 2552) hạ xuống cảnh báo: script nhiều file dùng chung biến toàn cục mà
    // editor không thấy hết
    const SOFT = new Set(["2304", "2552", "2339"]);
    let softening = false;
    monaco.editor.onDidChangeMarkers((uris) => {
      if (!softening) {
        softening = true;
        for (const uri of uris) {
          const ms = monaco.editor.getModelMarkers({ resource: uri, owner: "javascript" });
          const model = monaco.editor.getModel(uri);
          if (model && ms.some((m) => m.severity === 8 && SOFT.has(String(m.code?.value ?? m.code)))) {
            monaco.editor.setModelMarkers(model, "javascript", ms.map((m) => (SOFT.has(String(m.code?.value ?? m.code)) ? { ...m, severity: monaco.MarkerSeverity.Warning } : m)));
          }
        }
        softening = false;
      }
      paintFileStatus();
      paintProblems();
    });
  }

  const LINT_LANGS = new Set(["python", "shell", "yaml", "go"]);
  // YAML: yamllint trên server nếu có, không thì dùng parser YAML của prettier để báo lỗi cú pháp
  async function yamlSyntax(text) {
    await loadPrettier(["yaml"]);
    try {
      await prettier.format(text, { parser: "yaml", plugins: Object.values(prettierPlugins) });
      return [];
    } catch (e) {
      const loc = e.loc?.start || { line: 1, column: 1 };
      return [{ line: loc.line, column: loc.column || 1, endLine: e.loc?.end?.line || loc.line, endColumn: (e.loc?.end?.column || loc.column) + 1, severity: "error", message: String(e.message).split("\n")[0].replace(/\s*\(\d+:\d+\)$/, ""), source: "yaml" }];
    }
  }
  async function lintModel(st, p) {
    const monaco = window.monaco;
    const lang = st.model?.getLanguageId();
    if (!monaco || !LINT_LANGS.has(lang)) return;
    const content = st.model.getValue();
    let r = await api("POST", "/api/code/lint", { lang, content, path: p }).catch(() => null);
    if (lang === "yaml" && r && !r.tool) r = { markers: await yamlSyntax(content).catch(() => []) };
    if (!r || st.disposed) return;
    const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
    monaco.editor.setModelMarkers(
      st.model,
      "dash-lint",
      r.markers.map((m) => ({ startLineNumber: m.line, startColumn: m.column, endLineNumber: m.endLine || m.line, endColumn: m.endColumn || m.column + 1, message: m.message, source: m.source, severity: sev[m.severity] || sev.info }))
    );
  }

  // ----- chỉ đọc (như extension "Toggle Read-only" của VS Code), nhớ theo đường dẫn -----
  const readonlySet = () => new Set(store.get("readonlyFiles", []));
  const isReadonly = (p) => readonlySet().has(p);
  function setReadonly(p, on) {
    const set = readonlySet();
    if (on) set.add(p);
    else set.delete(p);
    store.set("readonlyFiles", [...set].slice(-500));
  }

  function createEditor(host, tab, p) {
    host.classList.add("code-host");
    const isMd = /\.(md|markdown|mdx)$/i.test(p);
    const isHtml = /\.html?$/i.test(p);
    const previewKey = isMd ? "mdPreview" : "htmlPreview";
    // Trang HTML chạy trong iframe sandbox không có allow-same-origin: script của trang không chạm được vào Dash
    const previewEl = isHtml ? `<iframe class="html-preview hidden" sandbox="allow-scripts allow-forms allow-popups" referrerpolicy="no-referrer" title="HTML preview"></iframe>` : `<div class="md-preview md-body hidden"></div>`;
    host.innerHTML = `<div class="crumbs"><span class="crumb-path">${esc(W.shortPath(p))}</span><span class="crumb-actions">
        ${isMd || isHtml ? `<button class="btn sm ghost" data-e="preview" title="Toggle ${isMd ? "Markdown" : "HTML"} preview (${esc(W.keyFor("markdown.preview") || "")})">Preview</button>` : ""}
        <button class="btn sm ghost" data-e="format" title="Format document (Shift+Alt+F)">Format</button>
        <button class="btn sm ghost ro-btn" data-e="ro" title="Toggle read-only">${W.ICON.lock}</button></span></div>
      <div class="code-split"><div class="code-editor"><div class="loading"><span class="spinner"></span></div></div>${previewEl}</div>`;
    const st = { editor: null, model: null, saved: "", mtime: 0, size: null, disposed: false, readonly: isReadonly(p), preview: false, autoTimer: 0, lintTimer: 0, previewTimer: 0, autoBlocked: false };
    const paintRo = () => {
      $(".ro-btn", host).classList.toggle("on", st.readonly);
      st.editor?.updateOptions({ readOnly: st.readonly });
      paintFileStatus();
    };
    const preview = $(".md-preview, .html-preview", host);
    // ----- đồng bộ cuộn editor <-> preview: neo theo data-line của từng khối, nội suy tuyến tính giữa hai neo.
    // mute chặn vòng lặp: cuộn do code gây ra ở một bên không được đẩy ngược lại bên kia.
    const mute = { editor: 0, preview: 0 };
    let anchors = null;
    const getAnchors = () => {
      if (anchors && anchors.h === preview.scrollHeight && anchors.w === preview.clientWidth) return anchors;
      const base = preview.getBoundingClientRect().top - preview.scrollTop;
      const list = [{ line: 1, top: 0 }];
      for (const el of preview.querySelectorAll(":scope > [data-line]")) {
        const line = Number(el.dataset.line);
        const top = el.getBoundingClientRect().top - base;
        const last = list[list.length - 1];
        if (line > last.line && top > last.top) list.push({ line, top });
      }
      const end = st.model.getLineCount() + 1;
      if (end > list[list.length - 1].line) list.push({ line: end, top: Math.max(preview.scrollHeight, list[list.length - 1].top + 1) });
      return (anchors = Object.assign(list, { h: preview.scrollHeight, w: preview.clientWidth }));
    };
    const mapScroll = (from, to, v) => {
      const a = getAnchors();
      let i = 0;
      while (i < a.length - 2 && a[i + 1][from] <= v) i++;
      const [x, y] = [a[i], a[i + 1] || a[i]];
      const r = y[from] > x[from] ? Math.min(1, Math.max(0, (v - x[from]) / (y[from] - x[from]))) : 0;
      return x[to] + (y[to] - x[to]) * r;
    };
    const lineTop = (n) => st.editor.getTopForLineNumber(Math.min(Math.max(1, n), st.model.getLineCount()));
    // dòng (có phần lẻ) đang nằm ở mép trên editor
    const editorLine = () => {
      const top = st.editor.getScrollTop();
      const n = st.editor.getVisibleRanges()[0]?.startLineNumber || 1;
      const y0 = lineTop(n);
      const y1 = n < st.model.getLineCount() ? lineTop(n + 1) : y0;
      return n + (y1 > y0 ? Math.min(1, Math.max(0, (top - y0) / (y1 - y0))) : 0);
    };
    const syncPreview = () => {
      if (!isMd || !st.preview || !st.editor || performance.now() < mute.editor) return;
      const ed = st.editor;
      const top = ed.getScrollTop();
      const atEnd = top > 0 && top + ed.getLayoutInfo().height >= ed.getScrollHeight() - 2;
      mute.preview = performance.now() + 150;
      preview.scrollTop = atEnd ? preview.scrollHeight : mapScroll("line", "top", editorLine());
    };
    const syncEditor = () => {
      if (!isMd || !st.preview || !st.editor || performance.now() < mute.preview) return;
      const ed = st.editor;
      const top = preview.scrollTop;
      const atEnd = top > 0 && top >= preview.scrollHeight - preview.clientHeight - 2;
      const immediate = window.monaco.editor.ScrollType.Immediate;
      mute.editor = performance.now() + 150;
      if (atEnd) return ed.setScrollTop(ed.getScrollHeight(), immediate);
      const line = mapScroll("top", "line", top);
      const n = Math.floor(line);
      ed.setScrollTop(lineTop(n) + (lineTop(n + 1) - lineTop(n)) * (line - n), immediate);
    };
    // ảnh trong preview tải xong / khung đổi kích thước làm lệch vị trí: căn lại theo editor
    let resyncFrame = 0;
    const resync = () => {
      cancelAnimationFrame(resyncFrame);
      resyncFrame = requestAnimationFrame(syncPreview);
    };
    preview.addEventListener("scroll", syncEditor, { passive: true });
    preview.addEventListener("load", resync, true);
    const previewResize = new ResizeObserver(resync);
    previewResize.observe(preview);
    const paintPreview = async () => {
      if (!st.preview || !st.model) return;
      if (isHtml) {
        // nội dung đang sửa (chưa lưu cũng được); <base> đặt sau DOCTYPE để không rơi vào quirks mode
        const base = `<base href="${viewUrl(p).replace(/[^/]*$/, "")}">`;
        preview.srcdoc = st.model.getValue().replace(/^(\s*<!doctype[^>]*>)?/i, (d) => d + base);
        return;
      }
      mute.preview = Infinity; // dựng lại HTML có thể đổi scrollTop của preview, không đẩy ngược sang editor
      try {
        await renderMarkdown(preview, st.model.getValue(), p);
      } finally {
        anchors = null;
        mute.preview = performance.now() + 150;
      }
      syncPreview();
    };
    (async () => {
      let file;
      try {
        file = await api("GET", `/api/files/read?path=${encodeURIComponent(p)}`);
      } catch (e) {
        $(".code-editor", host).innerHTML = `<div class="empty">${esc(e.message)}</div>`;
        return;
      }
      st.size = file.size;
      W.emit("file:info");
      if (file.binary || file.tooLarge) {
        $(".code-editor", host).innerHTML = `<div class="empty">${file.binary ? "Binary file" : "File is too large to edit"} (${fmtSize(file.size)}).</div>`;
        return;
      }
      const monaco = await W.monaco();
      if (st.disposed) return;
      registerFormatters(monaco);
      const ws = W.ws();
      st.saved = file.content;
      st.mtime = file.mtime;
      st.model = monaco.editor.createModel(file.content, W.langOf(p), W.isRemote(p) ? monaco.Uri.parse(p) : monaco.Uri.file(p));
      st.model.dashPath = p;
      $(".code-editor", host).innerHTML = "";
      st.editor = monaco.editor.create($(".code-editor", host), {
        model: st.model,
        theme: W.monacoTheme(),
        automaticLayout: true,
        fontFamily: ws.fontFamily,
        fontSize: ws.editorFontSize,
        fontLigatures: true,
        tabSize: ws.editorTabSize,
        wordWrap: ws.editorWordWrap ? "on" : "off",
        minimap: { enabled: true, renderCharacters: false },
        smoothScrolling: true,
        renderWhitespace: "selection",
        bracketPairColorization: { enabled: true },
        stickyScroll: { enabled: true },
        readOnly: st.readonly,
        fixedOverflowWidgets: true,
      });
      st.model.onDidChangeContent(() => {
        W.markDirty();
        clearTimeout(st.lintTimer);
        st.lintTimer = setTimeout(() => lintModel(st, p), 800);
        clearTimeout(st.previewTimer);
        st.previewTimer = setTimeout(paintPreview, 200);
        // Tự lưu (mặc định bật) sau khi ngừng gõ autoSaveDelay ms
        const w = W.ws();
        clearTimeout(st.autoTimer);
        if (w.autoSave && !st.readonly && !st.autoBlocked) st.autoTimer = setTimeout(() => inst.isDirty() && inst.save(false, { auto: true }), w.autoSaveDelay || 1000);
      });
      st.editor.onDidScrollChange((e) => e.scrollTopChanged && syncPreview());
      st.editor.onDidFocusEditorText(() => paintFileStatus());
      st.editor.onDidChangeCursorSelection(() => W.active?.inst === inst && paintFileStatus());
      paintRo();
      lintModel(st, p);
      if ((isMd || isHtml) && store.get(previewKey, false)) inst.togglePreview();
      st.editor.focus();
    })();
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-e]");
      if (!b) return;
      if (b.dataset.e === "format") inst.format();
      if (b.dataset.e === "ro") inst.toggleReadonly();
      if (b.dataset.e === "preview") inst.togglePreview();
    });
    const inst = {
      path: p,
      size: () => st.size,
      readonly: () => st.readonly,
      editor: () => st.editor,
      isDirty: () => Boolean(st.model && st.model.getValue() !== st.saved),
      focus: () => st.editor?.focus(),
      layout: () => st.editor?.layout(),
      format: () => st.editor?.getAction("editor.action.formatDocument")?.run(),
      toggleReadonly() {
        st.readonly = !st.readonly;
        setReadonly(p, st.readonly);
        if (st.readonly) clearTimeout(st.autoTimer);
        paintRo();
        toast(st.readonly ? `${W.base(p)} is read-only` : `${W.base(p)} is editable`, "ok", 1200);
      },
      togglePreview() {
        if (!isMd && !isHtml) return;
        st.preview = !st.preview;
        store.set(previewKey, st.preview);
        preview.classList.toggle("hidden", !st.preview);
        host.classList.toggle("with-preview", st.preview);
        $("[data-e=preview]", host)?.classList.toggle("on", st.preview);
        paintPreview();
        st.editor?.layout();
      },
      async save(force = false, { auto = false } = {}) {
        if (!st.model) return true;
        if (st.readonly && !auto) {
          toast("This file is read-only. Toggle read-only to save it.", "error");
          return false;
        }
        const content = st.model.getValue();
        try {
          const r = await api("PUT", "/api/files/write", { path: p, content, mtime: st.mtime, force });
          st.saved = content;
          st.mtime = r.mtime;
          st.size = r.size;
          st.autoBlocked = false;
          W.markDirty();
          paintFileStatus();
          refreshGit().then(paint);
          W.emit("file:saved", p);
          return true;
        } catch (e) {
          if (/changed on disk/.test(e.message)) {
            // tự lưu không ghi đè thay đổi từ nơi khác: dừng tự lưu cho tới khi người dùng tự lưu
            if (auto) {
              st.autoBlocked = true;
              toast(`${W.base(p)} changed on disk. Auto save paused; press Ctrl+S to choose.`, "error");
              return false;
            }
            if (await confirmDialog(`${W.base(p)} was changed on disk since you opened it.\nOverwrite it with your version?`, { title: "File changed on disk", ok: "Overwrite", danger: true })) return this.save(true);
            return false;
          }
          toast(e.message, "error");
          return false;
        }
      },
      reveal(line, column = 1) {
        if (!st.editor) return setTimeout(() => this.reveal(line, column), 200);
        st.editor.setPosition({ lineNumber: line, column });
        st.editor.focus();
        // cuộn sau khi editor đã đổi kích thước (vd. vừa mở panel bên dưới)
        requestAnimationFrame(() => {
          st.editor.layout();
          st.editor.revealPositionInCenter({ lineNumber: line, column });
        });
      },
      dispose() {
        st.disposed = true;
        clearTimeout(st.autoTimer);
        clearTimeout(st.lintTimer);
        cancelAnimationFrame(resyncFrame);
        previewResize.disconnect();
        st.editor?.dispose();
        st.model?.dispose();
      },
    };
    return inst;
  }

  // ----- status bar: lỗi / cảnh báo, chỉ đọc, dung lượng file đang mở -----
  function paintFileStatus() {
    const inst = W.active?.persist?.kind === "file" ? W.active.inst : null;
    if (!inst) {
      for (const id of ["file-size", "file-ro", "problems"]) W.status(id, null);
      return;
    }
    const size = inst.size?.();
    W.status("file-size", { side: "right", order: 18, html: `<span>${esc(fmtSize(size) || "…")}</span>`, title: `Size of ${inst.path} on disk` });
    const ed = inst.editor?.();
    if (!ed) {
      W.status("file-ro", null);
      W.status("problems", null);
      return;
    }
    const ro = inst.readonly();
    W.status("file-ro", { side: "right", order: 17, cls: ro ? "sb-warn" : "sb-dim", html: `${W.ICON.lock}<span>${ro ? "Read-only" : ""}</span>`, title: ro ? "Read-only · click to allow editing" : "Editable · click to make read-only", cmd: "file.toggleReadonly" });
    const markers = window.monaco ? monaco.editor.getModelMarkers({ resource: ed.getModel().uri }) : [];
    const errors = markers.filter((m) => m.severity === 8).length;
    const warnings = markers.filter((m) => m.severity === 4).length;
    W.status("problems", { side: "left", order: 12, html: `<span class="${errors ? "err" : ""}">⊗ ${errors}</span><span>⚠ ${warnings}</span>`, title: "Problems in this file · click to open the Problems panel (F8: next problem)", cmd: "problems.show" });
  }

  // ----- panel Problems (dưới, cạnh Terminal): lỗi / cảnh báo của mọi file đang mở, bấm để nhảy tới dòng -----
  let probRoot = null;
  const SEV = { 8: ["err", "⊗", "Error"], 4: ["warn", "⚠", "Warning"], 2: ["info", "ℹ", "Info"], 1: ["info", "ℹ", "Hint"] };
  const collapsedFiles = new Set();
  function problemList() {
    if (!window.monaco) return [];
    const byFile = new Map();
    for (const m of monaco.editor.getModelMarkers({})) {
      const p = monaco.editor.getModel(m.resource)?.dashPath;
      if (!p || m.severity < 2) continue;
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p).push(m);
    }
    for (const list of byFile.values()) list.sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
    return [...byFile].sort((a, b) => a[0].localeCompare(b[0]));
  }
  function paintProblems() {
    const files = problemList();
    const all = files.flatMap(([, l]) => l);
    const errors = all.filter((m) => m.severity === 8).length;
    W.setPanelBadge?.("problems", all.length ? String(all.length) : "");
    if (!probRoot) return;
    $(".prob-sum", probRoot).innerHTML = `<span class="err">⊗ ${errors}</span> <span class="warn">⚠ ${all.filter((m) => m.severity === 4).length}</span> <span class="faint">in ${files.length} open file(s)</span>`;
    $(".prob-list", probRoot).innerHTML = files.length
      ? files
          .map(([p, list]) => {
            const open = !collapsedFiles.has(p);
            return `<div class="prob-file" data-prob-file="${esc(p)}"><span class="twisty">${open ? "▾" : "▸"}</span>${W.fileIcon(p)}<span class="fname">${esc(W.base(p))}</span><span class="fdir">${esc(W.shortPath(p.slice(0, p.lastIndexOf("/"))))}</span><span class="count">${list.length}</span></div>${
              open
                ? list
                    .map((m, i) => {
                      const [cls, icon, label] = SEV[m.severity] || SEV[2];
                      return `<div class="prob-row" data-prob="${esc(p)}" data-line="${m.startLineNumber}" data-col="${m.startColumn}" title="${label}: ${esc(m.message)}"><span class="prob-ico ${cls}">${icon}</span><span class="prob-msg">${esc(m.message.split("\n")[0])}</span><span class="faint">${esc(m.source || m.owner || "")}${m.code ? `(${esc(typeof m.code === "object" ? m.code.value : m.code)})` : ""}</span><span class="prob-pos">[Ln ${m.startLineNumber}, Col ${m.startColumn}]</span></div>`;
                    })
                    .join("")
                : ""
            }`;
          })
          .join("")
      : `<div class="empty faint">No problems have been detected in the open files.</div>`;
  }
  W.registerPanel("problems", {
    title: "Problems",
    order: 1.5,
    mount(el) {
      probRoot = el;
      el.innerHTML = `<div class="prob"><div class="prob-bar"><span class="prob-sum"></span></div><div class="prob-list"></div></div>`;
      el.addEventListener("click", (e) => {
        const f = e.target.closest("[data-prob-file]");
        if (f) {
          const p = f.dataset.probFile;
          if (collapsedFiles.has(p)) collapsedFiles.delete(p);
          else collapsedFiles.add(p);
          return paintProblems();
        }
        const r = e.target.closest("[data-prob]");
        if (r) openFile(r.dataset.prob, { line: Number(r.dataset.line), column: Number(r.dataset.col) });
      });
      paintProblems();
    },
    show: () => paintProblems(),
  });
  W.command("problems.show", "View: show Problems", () => W.showPanel("problems"), "Ctrl+Shift+M");
  W.on("tab", paintFileStatus);
  W.on("file:info", paintFileStatus);

  function fileTab(p, asText) {
    const kind = asText ? null : viewerKind(p);
    return {
      id: `file:${p}`,
      title: W.base(p),
      icon: W.fileIcon(p),
      tooltip: W.shortPath(p),
      persist: { kind: "file", data: { path: p, ...(asText ? { asText: true } : {}) } },
      create: (host, tab) => (kind ? createViewer(host, tab, p, kind) : createEditor(host, tab, p)),
    };
  }

  function openFile(p, { line, column, asText } = {}) {
    const t = W.openTab(fileTab(p, asText));
    if (line) t.inst?.reveal?.(line, column);
    return t;
  }
  W.openFile = openFile;
  W.registerRestorer("file", (d) => openFile(d.path, { asText: d.asText }));

  // ----- cây thư mục dạng chữ -----
  async function fileTree(dir) {
    const r = await guarded(() => api("GET", `/api/files/tree?path=${encodeURIComponent(dir)}`));
    if (!r) return;
    const m = openModal(
      `File tree · ${esc(W.base(dir))}`,
      `<textarea class="tree-text mono" rows="22" readonly spellcheck="false">${esc(r.text)}</textarea>${r.truncated ? `<p class="faint">The tree was cut at 3000 entries.</p>` : ""}<p class="faint" style="font-size:12px">Heavy folders (.git, node_modules, .venv, __pycache__…) are left out.</p>`,
      `<button class="btn" data-action="close-modal">Close</button><button class="btn primary" id="tree-copy">Copy</button>`,
      true
    );
    $("#tree-copy", m).onclick = () => navigator.clipboard?.writeText(r.text).then(() => toast("File tree copied", "ok", 1500));
  }

  // ---------- mở nhanh (Ctrl+P) ----------
  let indexCache = { root: "", at: 0, files: [] };
  async function quickOpen() {
    if (indexCache.root !== W.folder || Date.now() - indexCache.at > 60000) {
      try {
        const r = await api("GET", `/api/files/index?root=${encodeURIComponent(W.folder)}`);
        indexCache = { root: W.folder, at: Date.now(), files: r.files };
      } catch (e) {
        return toast(e.message, "error");
      }
    }
    const recent = store.get("recentFiles", []).filter((f) => f.startsWith(W.folder + "/"));
    const items = [...recent.map((f) => f.slice(W.folder.length + 1)), ...indexCache.files.filter((f) => !recent.includes(join(W.folder, f)))].map((f) => ({
      label: W.base(f),
      detail: f,
      value: f,
    }));
    const commandsHint = { label: "> Show all commands", detail: W.keyFor("palette.show"), value: ">" };
    const picked = await W.quickPick([commandsHint, ...items], { placeholder: `Go to file in ${W.base(W.folder)} (type > for commands)` });
    if (!picked) return;
    if (picked === ">") return W.palette();
    const full = join(W.folder, picked);
    store.set("recentFiles", [full, ...store.get("recentFiles", []).filter((x) => x !== full)].slice(0, 30));
    openFile(full);
  }

  W.registerView("explorer", { title: "Explorer", icon: W.ICON.files, order: 2, key: "view.explorer", mount, show: () => refresh(false) });
  W.command("view.explorer", "Show Explorer", () => W.showView("explorer"), "Ctrl+Shift+E");
  W.command("explorer.quickOpen", "Go to file…", quickOpen, "", { hidden: true });
  W.command("explorer.refresh", "Explorer: refresh", () => refresh());
  W.command("explorer.fileTree", "Explorer: generate file tree of current folder", () => fileTree(W.folder));
  const activeFile = () => (W.active?.persist?.kind === "file" ? W.active.inst : null);
  W.command("file.toggleReadonly", "File: toggle read-only", () => activeFile()?.toggleReadonly?.(), "");
  W.command("file.format", "File: format document", () => activeFile()?.format?.(), "Shift+Alt+F", { when: () => W.notTerm() && W.active?.persist?.kind === "file" });
  W.command("markdown.preview", "Toggle Markdown / HTML preview", () => activeFile()?.togglePreview?.(), "Ctrl+Shift+V", { when: W.notTerm });
  W.command("editor.nextProblem", "File: go to next problem", () => activeFile()?.editor?.()?.getAction("editor.action.marker.next")?.run(), "F8", { when: W.notTerm });
  W.on("folder", () => {
    cache.clear();
    if (root) refresh();
  });
  W.on("git:changed", () => root && refresh(false));
  W.on("icons", () => {
    if (root) paint();
    for (const t of W.tabs) if (t.persist?.kind === "file") t.icon = W.fileIcon(t.persist.data.path);
    W.paintTabs();
  });
  W.on("theme", () => root && paint());
})();
