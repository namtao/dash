"use strict";
// Browse Files: duyệt mọi thư mục trên máy này và trên các máy SSH (không phụ thuộc thư mục hiện tại như Explorer),
// mở file bằng trình xem / editor, tải file hoặc cả thư mục (ZIP) về, tải file / thư mục lên bằng nút hoặc kéo thả.
// W.download / W.uploadPick / W.uploadDropZone dùng chung với Explorer.
(() => {
  const join = (a, b) => `${a.replace(/\/+$/, "")}/${b}`;
  // thư mục cha, giữ tiền tố ssh://<id>
  const parentOf = (p) => {
    const m = p.match(/^(ssh:\/\/[^/]+)(\/.*)$/);
    const [pre, rest] = m ? [m[1], m[2]] : ["", p];
    return pre + (rest.slice(0, rest.replace(/\/+$/, "").lastIndexOf("/")) || "/");
  };
  const IC = {
    home: W.ICON.home,
    drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5.5 13 8 5h8l2.5 8M7 16.5h.01M10.5 16.5h.01"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7 9.5l5-5 5 5M5 20h14"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  };

  // ---------- tải về ----------
  function saveUrl(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  }
  W.download = async (p, isDir) => {
    const url = `/api/files/download?path=${encodeURIComponent(p)}`;
    if (!isDir) return saveUrl(url);
    const pick = await askDialog({
      title: "Download folder",
      message: `Download "${W.base(p) || p}" as a ZIP file?`,
      detail: "The ZIP is built while it downloads, so the size is not known up front.\nSymbolic links are left out; files that cannot be read are listed in _skipped-by-dash.txt.",
      buttons: [
        { id: "cancel", label: "Cancel" },
        { id: "all", label: "Everything" },
        { id: "skip", label: "Skip node_modules, .git, .venv…", cls: "primary" },
      ],
    });
    if (pick === "all" || pick === "skip") {
      saveUrl(pick === "skip" ? `${url}&skip=1` : url);
      toast("Download started. Your browser shows its progress.", "ok", 2500);
    }
  };

  // ---------- tải lên: hàng đợi từng file, có tiến độ và nút huỷ ----------
  const queue = []; // { dir, files: [{ file, rel }], dirs: [rel] }
  let busy = false;
  let xhr = null;
  let stopped = false;
  let card = null;

  function showCard(html) {
    const box = $("#toasts");
    if (!card) {
      card = document.createElement("div");
      card.className = "toast xfer";
      card.addEventListener("click", (e) => {
        if (!e.target.closest("[data-xfer=cancel]")) return;
        stopped = true;
        xhr?.abort();
      });
      box.append(card);
    }
    card.innerHTML = html;
    try {
      if (box.matches(":popover-open")) box.hidePopover();
      box.showPopover();
    } catch {}
  }
  function hideCard() {
    card?.remove();
    card = null;
    try {
      if (!$("#toasts").children.length) $("#toasts").hidePopover();
    } catch {}
  }

  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

  function put(path, file, overwrite, onProgress) {
    return new Promise((resolve, reject) => {
      const x = (xhr = new XMLHttpRequest());
      x.open("PUT", `/api/files/upload?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`);
      x.setRequestHeader("X-Dash", "1");
      x.setRequestHeader("Content-Type", "application/octet-stream");
      x.upload.onprogress = (e) => onProgress(e.loaded);
      x.onload = () => {
        let data = {};
        try {
          data = JSON.parse(x.responseText);
        } catch {}
        if (x.status === 401) toLogin();
        if (x.status >= 200 && x.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || `HTTP ${x.status}`), { status: x.status }));
      };
      x.onerror = () => reject(new Error("Upload failed (network error)"));
      x.onabort = () => reject(Object.assign(new Error("Upload cancelled"), { cancelled: true }));
      x.send(file);
    });
  }

  async function runQueue() {
    if (busy) return;
    busy = true;
    stopped = false;
    while (queue.length && !stopped) {
      const job = queue.shift();
      const total = job.files.reduce((n, f) => n + f.file.size, 0);
      let doneBytes = 0;
      let ok = 0;
      let skipped = 0;
      let replaceAll = false;
      let replaceOne = false;
      const where = W.shortPath(job.dir);
      // thư mục rỗng kéo vào cũng được tạo
      for (const rel of job.dirs) await api("POST", "/api/files/create", { path: join(job.dir, rel), dir: true }).catch(() => {});
      for (let i = 0; i < job.files.length && !stopped; i++) {
        const { file, rel } = job.files[i];
        const target = join(job.dir, rel);
        const paint = (sent) => {
          const pct = total ? Math.floor(((doneBytes + sent) / total) * 100) : 100;
          showCard(`<div class="xfer-head"><b>Uploading ${i + 1} of ${job.files.length}</b><button class="btn sm ghost" data-xfer="cancel">Cancel</button></div>
            <div class="xfer-name" title="${esc(target)}">${esc(rel)}</div>
            <div class="xfer-bar"><i style="width:${pct}%"></i></div>
            <div class="xfer-meta faint">${pct}% · ${fmtSize(doneBytes + sent)} of ${fmtSize(total)} · to ${esc(where)}</div>`);
        };
        paint(0);
        try {
          await put(target, file, replaceAll || replaceOne, paint);
          ok++;
        } catch (e) {
          if (e.cancelled) break;
          if (e.status === 409 && /file with this name/.test(e.message)) {
            const left = job.files.length - i - 1;
            const pick = await askDialog({
              title: "File already exists",
              message: `"${rel}" already exists in ${where}.`,
              buttons: [{ id: "cancel", label: "Stop" }, { id: "skip", label: "Skip" }, ...(left ? [{ id: "all", label: "Replace all" }] : []), { id: "replace", label: "Replace", cls: "danger" }],
            });
            if (pick === "cancel") stopped = true;
            else if (pick === "skip") skipped++;
            else {
              replaceAll = pick === "all";
              replaceOne = true;
              i--; // thử lại file này, cho ghi đè
              continue;
            }
          } else {
            toast(`${rel}: ${e.message}`, "error");
            skipped++;
          }
        }
        replaceOne = false;
        doneBytes += file.size;
      }
      W.emit("files:changed", job.dir);
      if (stopped) toast(`Upload stopped. ${ok} file(s) were uploaded to ${where}.`, "error");
      else toast(`Uploaded ${ok} file(s) to ${where}${skipped ? ` · ${skipped} skipped` : ""}`, "ok");
    }
    queue.length = 0;
    xhr = null;
    busy = false;
    hideCard();
  }

  function enqueue(dir, files, dirs = []) {
    if (!files.length && !dirs.length) return;
    queue.push({ dir, files, dirs });
    runQueue();
  }

  // Chọn file / thư mục bằng hộp chọn của trình duyệt
  W.uploadPick = (dir, folder) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (folder) input.webkitdirectory = true;
    input.onchange = () => enqueue(dir, [...input.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name })));
    input.click();
  };

  // Đọc cả thư mục được kéo vào (FileSystemEntry), kể cả thư mục con rỗng
  async function collect(entry, prefix, files, dirs) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      files.push({ file, rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      const rel = prefix + entry.name;
      dirs.push(rel);
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await collect(e, `${rel}/`, files, dirs);
      }
    }
  }

  // Gắn kéo-thả tải lên cho một cây thư mục; dirFor(row|null) -> thư mục đích
  W.uploadDropZone = (el, dirFor) => {
    let hover = null;
    const mark = (row) => {
      if (hover === row) return;
      hover?.classList.remove("drop-target");
      hover = row;
      hover?.classList.add("drop-target");
      el.classList.toggle("drop-root", !row);
    };
    const target = (e) => {
      const row = e.target.closest(".tree-row[data-path]");
      if (!row) return null;
      // tô thư mục sẽ nhận file (file thì tô thư mục cha nếu đang hiện)
      return row.dataset.dir === "1" || row.classList.contains("fm-root") ? row : null;
    };
    el.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      mark(target(e));
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) {
        mark(null);
        el.classList.remove("drop-root");
      }
    });
    el.addEventListener("drop", async (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      const row = e.target.closest(".tree-row[data-path]");
      mark(null);
      el.classList.remove("drop-root");
      const dir = dirFor(row);
      if (!dir) return;
      const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
      const files = [];
      const dirs = [];
      try {
        if (entries.length) for (const en of entries) await collect(en, "", files, dirs);
        else files.push(...[...e.dataTransfer.files].map((file) => ({ file, rel: file.name })));
      } catch (err) {
        return toast(`Could not read the dropped items: ${err.message}`, "error");
      }
      enqueue(dir, files, dirs);
    });
  };

  // ---------- view Browse Files ----------
  let root = null;
  const open = new Set(store.get("fmOpen", []));
  const cache = new Map();
  let selected = null;
  const saveOpen = () => store.set("fmOpen", [...open].slice(-300));
  // Vị trí gốc: thư mục home, cả máy, từng máy SSH, và thư mục người dùng thêm (Go to folder… / Add to Places)
  const custom = () => store.get("fmPlaces", []);
  const moved = () => store.get("fmMoved", {}); // gốc đã "lên một cấp": id -> đường dẫn
  const sshHome = new Map();

  function places() {
    const m = moved();
    const list = [
      { id: "home", label: "Home", icon: IC.home, path: m.home || W.home },
      { id: "computer", label: "This computer", icon: IC.drive, path: m.computer || "/" },
      ...(S.config?.ssh || []).map((s) => ({ id: `ssh:${s.id}`, label: s.label || s.id, icon: W.ICON.ssh, path: m[`ssh:${s.id}`] || sshHome.get(s.id) || null, ssh: s.id })),
      ...custom().map((p) => ({ id: `place:${p}`, label: W.base(p) || p, icon: W.ICON.files, path: p, custom: true })),
    ];
    return list;
  }

  async function listDir(dir, force) {
    if (!force && cache.has(dir)) return cache.get(dir);
    const r = await api("GET", `/api/files/list?path=${encodeURIComponent(dir)}`);
    cache.set(dir, r.items);
    return r.items;
  }

  const rowActions = (isDir) => `<span class="fm-acts">
      ${isDir ? `<button class="fm-btn" data-fm="upload" title="Upload files here">${IC.up}</button>` : ""}
      <button class="fm-btn" data-fm="download" title="${isDir ? "Download as ZIP" : "Download"}">${IC.down}</button>
      <button class="fm-btn fm-more" data-fm="more" title="More">${IC.more}</button></span>`;

  async function renderDir(dir, depth) {
    let items;
    try {
      items = await listDir(dir);
    } catch (e) {
      return `<div class="tree-row faint" style="padding-left:${8 + depth * 12}px">${esc(e.message)}</div>`;
    }
    if (!items.length) return `<div class="tree-row faint fm-empty" style="padding-left:${24 + depth * 12}px">Empty folder</div>`;
    let html = "";
    for (const it of items) {
      const full = join(dir, it.name);
      const isOpen = it.dir && open.has(full);
      html += `<div class="tree-row ${it.dir ? "dir" : "file"} ${it.dim ? "dim" : ""} ${selected === full ? "sel" : ""}" data-path="${esc(full)}" data-dir="${it.dir ? 1 : 0}" style="padding-left:${8 + depth * 12}px">
        <span class="twisty">${it.dir ? (isOpen ? "▾" : "▸") : ""}</span>${it.dir ? W.folderIcon(it.name, isOpen) : W.fileIcon(it.name)}<span class="fname">${esc(it.name)}</span>${rowActions(it.dir)}</div>`;
      if (isOpen) html += await renderDir(full, depth + 1);
    }
    return html;
  }

  async function paint() {
    if (!root) return;
    const tree = $(".fm-tree", root);
    let html = "";
    for (const pl of places()) {
      const isOpen = open.has(pl.id);
      const where = pl.path ? W.shortPath(pl.path) : "";
      html += `<div class="tree-row fm-root ${isOpen ? "open" : ""}" data-root="${esc(pl.id)}" ${pl.path ? `data-path="${esc(pl.path)}" data-dir="1"` : ""}>
        <span class="twisty">${isOpen ? "▾" : "▸"}</span><span class="fm-ic">${pl.icon}</span><span class="fname">${esc(pl.label)}</span><span class="fm-where faint" title="${esc(where)}">${esc(where)}</span>${pl.path ? rowActions(true) : ""}</div>`;
      if (!isOpen) continue;
      if (!pl.path) {
        html += `<div class="tree-row faint" style="padding-left:28px"><span class="spinner"></span> Connecting…</div>`;
        if (pl.ssh) resolveSsh(pl);
      }
      else html += await renderDir(pl.path, 1);
    }
    const scroll = tree.scrollTop;
    tree.innerHTML = html;
    tree.scrollTop = scroll;
  }

  // Thư mục bắt đầu của máy SSH: hỏi máy đó một lần (cả khi nút đã mở sẵn từ lần trước)
  const resolving = new Set();
  async function resolveSsh(pl) {
    if (resolving.has(pl.ssh)) return;
    resolving.add(pl.ssh);
    try {
      sshHome.set(pl.ssh, (await api("GET", `/api/files/home?ssh=${encodeURIComponent(pl.ssh)}`)).home);
    } catch (e) {
      open.delete(pl.id);
      saveOpen();
      toast(e.message, "error");
    } finally {
      resolving.delete(pl.ssh);
    }
    paint();
  }

  function toggleRoot(id) {
    if (open.has(id)) open.delete(id);
    else open.add(id);
    saveOpen();
    paint();
  }

  function setRootPath(id, path) {
    if (id.startsWith("place:")) {
      const old = id.slice(6);
      store.set("fmPlaces", custom().map((p) => (p === old ? path : p)));
      if (open.delete(id)) open.add(`place:${path}`);
      saveOpen();
    } else store.set("fmMoved", { ...moved(), [id]: path });
    paint();
  }
  function resetRoot(id) {
    const m = moved();
    delete m[id];
    store.set("fmMoved", m);
    paint();
  }
  function addPlace(p) {
    if (!custom().includes(p)) store.set("fmPlaces", [...custom(), p]);
    open.add(`place:${p}`);
    saveOpen();
    paint();
    $(".fm-tree", root)?.scrollTo({ top: 1e9 });
  }
  function removePlace(p) {
    store.set("fmPlaces", custom().filter((x) => x !== p));
    open.delete(`place:${p}`);
    saveOpen();
    paint();
  }

  function rowMenu(e, row) {
    const p = row.dataset.path;
    const rootId = row.dataset.root;
    const isDir = row.dataset.dir === "1";
    const dir = isDir ? p : parentOf(p);
    const pl = rootId ? places().find((x) => x.id === rootId) : null;
    if (rootId && !p) return;
    const fileItems = [
      { label: "Open", run: () => W.openFile(p) },
      { label: "Open as text", run: () => W.openFile(p, { asText: true }) },
      { label: "Download", run: () => W.download(p, false) },
    ];
    const dirItems = [
      { label: "Download as ZIP…", run: () => W.download(p, true) },
      { label: "Upload files here…", run: () => W.uploadPick(p, false) },
      { label: "Upload folder here…", run: () => W.uploadPick(p, true) },
      { sep: true },
      { label: "New file…", run: () => W.fileOps.newItem(p, false) },
      { label: "New folder…", run: () => W.fileOps.newItem(p, true) },
      { label: "Open as current folder", run: () => W.setFolder(p) },
      { label: "Open terminal here", run: () => W.term.create({ cwd: p }) },
      ...(!rootId ? [{ label: "Add to Places", run: () => addPlace(p) }] : []),
    ];
    const rootItems = pl
      ? [
          { sep: true },
          { label: "Show parent folder", run: () => setRootPath(rootId, parentOf(p)), disabled: /^(ssh:\/\/[^/]+)?\/$/.test(p) },
          ...(!pl.custom && moved()[rootId] ? [{ label: "Back to the default folder", run: () => resetRoot(rootId) }] : []),
          ...(pl.custom ? [{ label: "Remove from Places", run: () => removePlace(p) }] : []),
          { label: "Refresh", run: () => refresh() },
        ]
      : [];
    W.menu(e, [
      ...(isDir ? dirItems : fileItems),
      ...rootItems,
      { sep: true },
      { label: "Copy path", run: () => navigator.clipboard?.writeText(p) },
      ...(!rootId ? [{ sep: true }, { label: "Rename…", run: () => W.fileOps.rename(p), key: "F2" }, { label: "Delete", danger: true, run: () => W.fileOps.remove(p, isDir), key: "Delete" }] : []),
    ]);
  }

  async function refresh(force = true) {
    if (force) cache.clear();
    await paint();
  }

  // Gõ / chọn đường dẫn bất kỳ (kể cả ssh://<hồ sơ>/…), thêm vào Places
  async function goTo() {
    await W.pickFolder({ pick: addPlace, placeholder: "Type a path to add to Browse Files (e.g. ~/Downloads, /var/log, ssh://<profile>/srv)" });
  }

  function mount(body, actions) {
    root = body;
    body.innerHTML = `<div class="fm-tree tree" tabindex="0"></div><div class="fm-hint faint">Drop files or folders on a folder to upload them.</div>`;
    actions.innerHTML = `<button class="icon" data-fmh="goto" title="Go to folder…">⌖</button><button class="icon" data-fmh="refresh" title="Refresh">↻</button><button class="icon" data-fmh="collapse" title="Collapse all">⊟</button>`;
    actions.addEventListener("click", (e) => {
      const b = e.target.closest("[data-fmh]");
      if (!b) return;
      if (b.dataset.fmh === "goto") goTo();
      if (b.dataset.fmh === "refresh") refresh();
      if (b.dataset.fmh === "collapse") {
        open.clear();
        saveOpen();
        paint();
      }
    });
    const tree = $(".fm-tree", body);
    tree.addEventListener("click", (e) => {
      const row = e.target.closest(".tree-row[data-path], .tree-row[data-root]");
      if (!row) return;
      const p = row.dataset.path;
      const act = e.target.closest("[data-fm]")?.dataset.fm;
      if (act === "download") return W.download(p, row.dataset.dir === "1");
      if (act === "upload") return W.uploadPick(p, false);
      if (act === "more") return rowMenu(e, row);
      if (row.dataset.root) return toggleRoot(row.dataset.root);
      selected = p;
      if (row.dataset.dir === "1") {
        if (open.has(p)) open.delete(p);
        else open.add(p);
        saveOpen();
        paint();
      } else {
        $$(".tree-row.sel", tree).forEach((x) => x.classList.remove("sel"));
        row.classList.add("sel");
        W.openFile(p);
      }
    });
    tree.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".tree-row[data-path]");
      if (row) rowMenu(e, row);
    });
    tree.addEventListener("keydown", (e) => {
      if (!selected) return;
      const row = $(`.tree-row[data-path="${CSS.escape(selected)}"]:not(.fm-root)`, tree);
      if (!row) return;
      if (e.key === "F2") W.fileOps.rename(selected);
      else if (e.key === "Delete") W.fileOps.remove(selected, row.dataset.dir === "1");
      else if (e.key === "Enter" && row.dataset.dir === "0") W.openFile(selected);
    });
    W.uploadDropZone(tree, (row) => (!row ? null : row.dataset.dir === "1" ? row.dataset.path : parentOf(row.dataset.path)));
    paint();
  }

  W.registerView("files", { title: "Browse Files", icon: IC.drive, order: 2.2, key: "view.files", mount, show: () => refresh(false) });
  W.command("view.files", "Show Browse Files (browse, download, upload)", () => W.showView("files"), "");
  W.command("files.goTo", "Browse Files: go to folder…", () => (W.showView("files"), goTo()));
  W.on("files:changed", () => root && refresh());
  W.on("icons", () => root && paint());
  W.on("theme", () => root && paint());
})();
