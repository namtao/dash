"use strict";
// Câu lệnh hay dùng (giống quick commands của WezTerm): tên, nhóm, hệ điều hành, mô tả, lệnh (nhiều dòng được).
// Bấm để gõ vào terminal đang mở, ▶ để chạy luôn; thêm / sửa / xoá; Alt+Q mở hộp chọn nhanh. Lưu trong projects.json.
(() => {
  const OS = { any: "Any OS", linux: "Linux", macos: "macOS", windows: "Windows" };
  let root = null;
  let filter = "";
  const list = () => S.config?.snippets || [];

  function paint() {
    if (!root) return;
    const q = filter.toLowerCase();
    const items = list().filter((x) => !q || `${x.name} ${x.group} ${x.command} ${x.description} ${x.os}`.toLowerCase().includes(q));
    const groups = new Map();
    for (const x of items) {
      const g = x.group || "Other";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(x);
    }
    $(".snip-list", root).innerHTML =
      [...groups]
        .map(
          ([g, xs]) => `<div class="snip-group"><div class="tree-head">${esc(g)} <span class="faint">${xs.length}</span></div>${xs
            .map(
              (x) => `<div class="snip-row" data-snip="${esc(x.id)}" title="${esc(x.description || x.command)}\nClick: type into the terminal · ▶ run">
                <div class="snip-main"><span class="snip-name">${esc(x.name)}</span>${x.os !== "any" ? `<span class="chip outline snip-os">${esc(OS[x.os])}</span>` : ""}
                <div class="snip-cmd">${W.highlightShell ? W.highlightShell(x.command.split("\n")[0]) : esc(x.command.split("\n")[0])}${x.command.includes("\n") ? ` <span class="faint">+${x.command.split("\n").length - 1} lines</span>` : ""}</div></div>
                <span class="snip-actions"><button class="icon" data-sn="run" title="Run in terminal">▶</button><button class="icon" data-sn="edit" title="Edit">✎</button><button class="icon" data-sn="delete" title="Delete">✕</button></span></div>`
            )
            .join("")}</div>`
        )
        .join("") || `<div class="empty">${list().length ? "No matches" : `No saved commands yet.<br><br><button class="btn sm primary" data-sn-top="add">＋ Add command</button>`}</div>`;
  }

  async function save(next, msg) {
    await api("PUT", "/api/snippets", { snippets: next });
    await W.reloadConfig();
    paint();
    if (msg) toast(msg, "ok", 1500);
  }

  function editModal(x = {}) {
    const isNew = !x.id;
    const groups = [...new Set(list().map((s) => s.group).filter(Boolean))];
    const m = openModal(
      isNew ? "Add saved command" : `Edit ${esc(x.name)}`,
      `<form id="snip-form" class="form">
        <label class="field"><span>Name</span><input name="name" value="${esc(x.name || "")}" required placeholder="Disk usage top 10" /></label>
        <label class="field"><span>Group</span><input name="group" list="snip-groups" value="${esc(x.group || "")}" placeholder="System" /><datalist id="snip-groups">${groups.map((g) => `<option value="${esc(g)}">`).join("")}</datalist></label>
        <label class="field"><span>Operating system</span><select name="os">${Object.entries(OS).map(([k, v]) => `<option value="${k}" ${(x.os || "any") === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="field"><span>Description</span><input name="description" value="${esc(x.description || "")}" /></label>
        <label class="field full"><span>Command</span><textarea name="command" class="mono" rows="5" required placeholder="du -sh * | sort -rh | head -10">${esc(x.command || "")}</textarea><small>Several lines run one after another when you press ▶.</small></label>
      </form>`,
      `${isNew ? "" : `<button class="btn danger" id="snip-del" style="margin-right:auto">Delete</button>`}<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="snip-form">Save</button>`
    );
    $("#snip-form", m).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const data = { ...x, ...f };
      const next = isNew ? [...list(), data] : list().map((s) => (s.id === x.id ? data : s));
      if ((await guarded(() => save(next, isNew ? "Command added" : "Command saved"))) !== null) closeModal();
    };
    $("#snip-del", m)?.addEventListener("click", async () => {
      if (await remove(x)) closeModal();
    });
  }

  async function remove(x) {
    if (!(await confirmDialog(`Delete saved command "${x.name}"?`, { title: "Delete saved command", ok: "Delete", danger: true }))) return false;
    return (await guarded(() => save(list().filter((s) => s.id !== x.id), "Deleted"))) !== null;
  }

  const use = (x, run) => W.term.insert(x.command, { run, cwd: W.folder });

  function mount(body, actions) {
    root = body;
    body.innerHTML = `<div class="side-search"><input class="snip-filter" type="search" placeholder="Filter saved commands…" /></div><div class="snip-list"></div>`;
    actions.innerHTML = `<button class="icon" data-sn-top="add" title="Add command">＋</button><button class="icon" data-sn-top="pick" title="Quick pick (${esc(W.keyFor("snippets.pick"))})">⌕</button>`;
    $(".snip-filter", body).addEventListener("input", (e) => {
      filter = e.target.value;
      paint();
    });
    const onClick = (e) => {
      const top = e.target.closest("[data-sn-top]");
      if (top) return top.dataset.snTop === "add" ? editModal() : pick();
      const row = e.target.closest("[data-snip]");
      if (!row) return;
      const x = list().find((s) => s.id === row.dataset.snip);
      const a = e.target.closest("[data-sn]")?.dataset.sn;
      if (a === "run") return use(x, true);
      if (a === "edit") return editModal(x);
      if (a === "delete") return remove(x);
      use(x, false);
    };
    body.addEventListener("click", onClick);
    actions.addEventListener("click", onClick);
    body.addEventListener("contextmenu", (e) => {
      const row = e.target.closest("[data-snip]");
      if (!row) return;
      const x = list().find((s) => s.id === row.dataset.snip);
      W.menu(e, [
        { label: "Run in terminal", run: () => use(x, true) },
        { label: "Type into terminal", run: () => use(x, false) },
        { label: "Copy command", run: () => navigator.clipboard?.writeText(x.command) },
        { label: "Duplicate", run: () => editModal({ ...x, id: undefined, name: `${x.name} copy` }) },
        { label: "Edit…", run: () => editModal(x) },
        { sep: true },
        { label: "Delete", danger: true, run: () => remove(x) },
      ]);
    });
    paint();
  }

  async function pick() {
    if (!list().length) return editModal();
    const id = await W.quickPick(
      list().map((x) => ({ label: `[${x.group || "Other"}]  ${x.name}`, detail: x.command.split("\n")[0], value: x.id, hint: x.os !== "any" ? OS[x.os] : "" })),
      { placeholder: "Saved commands · Enter runs it in the terminal" }
    );
    const x = list().find((s) => s.id === id);
    if (x) use(x, true);
  }

  W.registerView("snippets", { title: "Saved commands", icon: W.ICON.snippets, order: 4.7, key: "view.snippets", mount, show: paint });
  W.command("view.snippets", "Show saved commands", () => W.showView("snippets"), "");
  W.command("snippets.pick", "Saved commands: run…", pick, "Alt+Q");
  W.command("snippets.add", "Saved commands: add…", () => editModal());
  W.on("config", paint);
})();
