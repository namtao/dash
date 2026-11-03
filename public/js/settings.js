"use strict";
// Settings (tab editor): terminal, editor, Claude, database, phím tắt (bấm để gán lại).
// View SSH: hồ sơ kết nối (lưu trong projects.json), mở thư mục trên máy SSH, chuyển tiếp cổng.
(() => {
  // ---------- Settings ----------
  const FIELDS = [
    ["Terminal", [
      ["shell", "Shell", "text", "Path of the shell for new terminals. zsh and bash get command history per folder."],
      ["fontFamily", "Font family", "text", "Used by terminals and editors. Nerd Fonts show powerlevel10k icons."],
      ["fontSize", "Terminal font size", "number"],
      ["lineHeight", "Line height", "number", "", 0.05],
      ["cursorStyle", "Cursor style", ["bar", "block", "underline"]],
      ["cursorBlink", "Blinking cursor", "bool"],
      ["scrollback", "Scrollback lines", "number"],
      ["copyOnSelect", "Copy on select", "bool", "Selecting text copies it, like WezTerm."],
      ["rightClickPaste", "Right click copies / pastes", "bool", "Right click copies the selection, or pastes when nothing is selected. Shift+right click opens the menu."],
      ["confirmDangerousPaste", "Warn before pasting dangerous commands", "bool", "rm -rf, git reset --hard, docker system prune…"],
    ]],
    ["Editor", [
      ["editorFontSize", "Editor font size", "number"],
      ["editorTabSize", "Tab size", "number"],
      ["editorWordWrap", "Word wrap", "bool"],
      ["autoSave", "Auto save", "bool", "Save files automatically after you stop typing. Read-only files are never saved."],
      ["autoSaveDelay", "Auto save delay (ms)", "number", "How long to wait after the last change. 200 to 60000."],
    ]],
    ["Claude", [
      ["claudeModel", "Default model", "text", "Empty uses the model from your Claude Code settings. E.g. opus, sonnet, claude-opus-5-5."],
      ["claudePermissionMode", "Default permission mode", ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]],
      ["claudeEffort", "Effort", ["", "low", "medium", "high", "xhigh", "max"], "Empty = Claude Code default."],
      ["usageRefreshSec", "Usage refresh (seconds)", "number", "How often the 5-hour / weekly limits are re-read. Reading them sends no prompt and uses no tokens. Minimum 30."],
      ["claudeAutoUpdate", "Update Claude Code automatically", "bool", "Runs `claude update` a few minutes after Dash starts and then once a day."],
    ]],
    ["Database", [
      ["sqlRowLimit", "Max rows per query", "number", "SELECT results are cut at this many rows."],
      ["backupDir", "Backup folder", "text", "Default folder for backups."],
    ]],
  ];

  function settingsTab(host) {
    host.classList.add("settings-host");
    const render = () => {
      const ws = W.ws();
      host.innerHTML = `<div class="settings">
        <div class="settings-nav">${[...FIELDS.map(([s]) => s), "Claude Code updates", "Local AI", "Keyboard shortcuts", "Projects & server", "Export"].map((s) => `<a href="#" data-jump="${esc(s)}">${esc(s)}</a>`).join("")}</div>
        <div class="settings-body">
          <input class="settings-filter" type="search" placeholder="Search settings" />
          ${FIELDS.map(
            ([section, fields]) => `<section data-sec="${esc(section)}"><h2>${esc(section)}</h2>${fields
              .map(([key, label, type, help, step]) => {
                const v = ws[key];
                let input;
                if (type === "bool") input = `<label class="switch"><input type="checkbox" data-key="${key}" ${v ? "checked" : ""}/><span></span></label>`;
                else if (Array.isArray(type)) input = `<select data-key="${key}">${type.map((o) => `<option value="${esc(o)}" ${v === o ? "selected" : ""}>${esc(o || "(default)")}</option>`).join("")}</select>`;
                else input = `<input data-key="${key}" type="${type}" ${step ? `step="${step}"` : ""} class="${type === "text" ? "mono" : ""}" value="${esc(v ?? "")}" />`;
                return `<div class="setting" data-search="${esc(`${label} ${help || ""} ${key}`.toLowerCase())}"><div class="setting-label"><b>${esc(label)}</b>${help ? `<small>${esc(help)}</small>` : ""}</div><div class="setting-input">${input}</div></div>`;
              })
              .join("")}</section>`
          ).join("")}
          <section data-sec="Claude Code updates"><h2>Claude Code updates</h2>
            <div class="setting"><div class="setting-label"><b>Installed version</b><small class="cu-status">Checking…</small></div>
              <div class="setting-input"><button class="btn" data-cu="update">Update now</button></div></div>
          </section>
          <section data-sec="Local AI"><h2>Local AI</h2>
            <p class="faint">An OpenAI-compatible server on your machine, as in Cline (Ollama: <code>http://localhost:11434/v1</code>, LM Studio: <code>http://localhost:1234/v1</code>, llama.cpp, vLLM…). Used by the AI chat view and by “Write commit message” in Source Control. Dash calls it from the server, so the API key never reaches the browser.</p>
            <div class="setting"><div class="setting-label"><b>Base URL</b><small>Ends with /v1 for most servers.</small></div><div class="setting-input"><input data-ai="baseUrl" class="mono" value="${esc(W.config().ai?.baseUrl || "")}" /></div></div>
            <div class="setting"><div class="setting-label"><b>Model ID</b><small>Click the field to list the models the server has.</small></div><div class="setting-input"><input data-ai="model" class="mono" list="ai-models" value="${esc(W.config().ai?.model || "")}" placeholder="e.g. qwen2.5-coder:7b" /><datalist id="ai-models"></datalist></div></div>
            <div class="setting"><div class="setting-label"><b>API key</b><small>Optional. Most local servers do not need one.</small></div><div class="setting-input"><input data-ai="apiKey" type="password" autocomplete="new-password" placeholder="${W.config().ai?.hasApiKey ? "•••••• (saved)" : "none"}" /></div></div>
            <div class="setting"><div class="setting-label"><b>Connection</b><small class="ai-status"></small></div><div class="setting-input"><button class="btn" data-ai-test>Test / list models</button></div></div>
          </section>
          <section data-sec="Keyboard shortcuts"><h2>Keyboard shortcuts</h2>
            <p class="faint">Click a shortcut, then press the new keys. Separate several shortcuts with a comma. Browsers reserve a few keys (Ctrl+T, Ctrl+W, Ctrl+N, Ctrl+Tab); install Dash as an app (browser menu → Install) to free more of them.</p>
            <input class="kb-filter" type="search" placeholder="Search commands or keys" />
            <table class="kb-table"><thead><tr><th>Command</th><th>Shortcut</th><th></th></tr></thead><tbody></tbody></table>
          </section>
          <section data-sec="Projects & server"><h2>Projects & server</h2>
            <p>Projects folder, Python for venvs, editor, external terminal, host and port.</p>
            <button class="btn" data-action="settings">Open project & server settings…</button> <button class="btn ghost" data-action="json">Edit JSON (advanced)</button>
          </section>
          <section data-sec="Export"><h2>Export</h2>
            <p>Download every setting as one JSON file: workspace options, shortcuts, projects and their commands, SSH profiles and port forwards, database connections, saved commands and the local AI settings. Passwords and API keys are left out. The file is only downloaded to this computer; nothing is uploaded.</p>
            <a class="btn primary" href="/api/export" download>Export configuration (JSON)</a>
            <button class="btn" data-action="import-config">Import configuration…</button>
          </section>
        </div></div>`;
      paintKeys();
      paintUpdate();
    };

    async function paintUpdate(force) {
      const el = $(".cu-status", host);
      if (!el) return;
      const r = force ? await api("POST", "/api/claude/update").catch((e) => ({ error: e.message })) : await api("GET", "/api/claude/version").catch((e) => ({ error: e.message }));
      el.textContent = `${r.version || "claude not found"}${r.lastCheck ? ` · last update check ${new Date(r.lastCheck).toLocaleString("en-GB")}` : ""}${r.error ? ` · ${r.error.split("\n").pop()}` : r.output && force ? ` · ${r.output.split("\n").pop()}` : ""}`;
    }

    async function testAi() {
      const el = $(".ai-status", host);
      el.textContent = "Connecting…";
      try {
        const list = await api("GET", "/api/ai/models");
        $("#ai-models", host).innerHTML = list.map((m) => `<option value="${esc(m)}">`).join("");
        el.textContent = `Connected · ${list.length} model(s): ${list.slice(0, 6).join(", ")}${list.length > 6 ? "…" : ""}`;
      } catch (e) {
        el.textContent = e.message;
      }
    }

    function paintKeys(filter = "") {
      const user = W.ws().keybindings || {};
      const f = filter.toLowerCase();
      const rows = [...W.commands.values()]
        .filter((c) => !f || `${c.title} ${c.id} ${W.keyFor(c.id)}`.toLowerCase().includes(f))
        .sort((a, b) => a.title.localeCompare(b.title));
      $(".kb-table tbody", host).innerHTML = rows
        .map((c) => {
          const k = W.keyFor(c.id);
          const custom = c.id in user;
          return `<tr><td>${esc(c.title)}<div class="faint mono" style="font-size:11px">${esc(c.id)}</div></td>
            <td><button class="kb-key ${custom ? "custom" : ""}" data-kb="${esc(c.id)}">${k ? k.split(/\s*,\s*/).map((x) => `<kbd>${esc(x)}</kbd>`).join(" ") : '<span class="faint">—</span>'}</button></td>
            <td>${custom ? `<button class="btn sm ghost" data-kb-reset="${esc(c.id)}" title="Reset to default (${esc(c.key || "none")})">↺</button>` : ""}<button class="btn sm ghost" data-kb-clear="${esc(c.id)}" title="Remove shortcut">✕</button></td></tr>`;
        })
        .join("");
    }

    async function saveKeys(patch) {
      const keybindings = { ...(W.ws().keybindings || {}) };
      for (const [id, v] of Object.entries(patch)) {
        if (v === undefined) delete keybindings[id];
        else keybindings[id] = v;
      }
      await guarded(() => api("PUT", "/api/workspace", { keybindings }));
      await W.reloadConfig();
      paintKeys($(".kb-filter", host)?.value || "");
    }

    function record(btn) {
      const id = btn.dataset.kb;
      btn.innerHTML = `<span class="faint">Press keys… (Esc cancel, Enter keep)</span>`;
      btn.classList.add("recording");
      const combos = [];
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return finish(null);
        if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.shiftKey) return finish(combos.length ? combos.join(", ") : null);
        const combo = W.comboOf(e);
        if (!combo) return;
        combos.push(combo);
        btn.innerHTML = combos.map((x) => `<kbd>${esc(x)}</kbd>`).join(" ") + ` <span class="faint">Enter to save</span>`;
        // phím trùng với lệnh khác
        const clash = [...W.commands.values()].find((c) => c.id !== id && W.keyFor(c.id).split(/\s*,\s*/).includes(combo));
        if (clash) toast(`${combo} is also used by "${clash.title}"`, "info", 4000);
      };
      const finish = (value) => {
        window.removeEventListener("keydown", onKey, true);
        btn.classList.remove("recording");
        if (value != null) saveKeys({ [id]: value });
        else paintKeys($(".kb-filter", host)?.value || "");
      };
      window.addEventListener("keydown", onKey, true);
    }

    let saveTimer = 0;
    host.addEventListener("change", async (e) => {
      const ai = e.target.closest("[data-ai]");
      if (ai) {
        if (await guarded(() => api("PUT", "/api/ai", { [ai.dataset.ai]: ai.value.trim() }))) {
          await W.reloadConfig();
          if (ai.dataset.ai === "apiKey") ai.value = "";
          toast("Local AI setting saved", "ok", 1200);
        }
        return;
      }
      const el = e.target.closest("[data-key]");
      if (!el) return;
      const value = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        if (await guarded(() => api("PUT", "/api/workspace", { [el.dataset.key]: value }))) {
          await W.reloadConfig();
          toast("Setting saved", "ok", 1200);
        }
      }, 150);
    });
    host.addEventListener("input", (e) => {
      if (e.target.classList.contains("kb-filter")) paintKeys(e.target.value);
      if (e.target.classList.contains("settings-filter")) {
        const q = e.target.value.toLowerCase();
        $$(".setting", host).forEach((s) => s.classList.toggle("hidden", Boolean(q) && !s.dataset.search.includes(q)));
      }
    });
    host.addEventListener("click", (e) => {
      const j = e.target.closest("[data-jump]");
      if (j) {
        e.preventDefault();
        $(`[data-sec="${CSS.escape(j.dataset.jump)}"]`, host)?.scrollIntoView({ behavior: "smooth" });
      }
      const kb = e.target.closest("[data-kb]");
      if (kb) record(kb);
      const rs = e.target.closest("[data-kb-reset]");
      if (rs) saveKeys({ [rs.dataset.kbReset]: undefined });
      const cl = e.target.closest("[data-kb-clear]");
      if (cl) saveKeys({ [cl.dataset.kbClear]: "" });
      const cu = e.target.closest("[data-cu]");
      if (cu) {
        cu.disabled = true;
        $(".cu-status", host).textContent = "Running claude update…";
        paintUpdate(true).finally(() => (cu.disabled = false));
      }
      if (e.target.closest("[data-ai-test]")) testAi();
    });
    host.addEventListener("focusin", (e) => {
      if (e.target.dataset?.ai === "model" && !$("#ai-models", host).children.length) testAi();
    });
    render();
    return { focus: () => {}, jump: (s) => $(`[data-sec="${CSS.escape(s)}"]`, host)?.scrollIntoView() };
  }

  // Nhập file JSON đã xuất: xem trước số mục, chọn gộp (chỉ thêm cái chưa có) hoặc thay toàn bộ
  function importConfig() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      let data;
      try {
        data = JSON.parse(await input.files[0].text());
        if (!Array.isArray(data.projects)) throw new Error("This is not a Dash configuration file");
      } catch (e) {
        return toast(`Cannot read the file: ${e.message}`, "error");
      }
      const n = (k) => (Array.isArray(data[k]) ? data[k].length : 0);
      const mode = await askDialog({
        title: "Import configuration",
        message: `${input.files[0].name}${data.exportedAt ? ` · exported ${new Date(data.exportedAt).toLocaleString("en-GB")}` : ""}\n\n${n("projects")} projects · ${n("ssh")} SSH profiles · ${n("databases")} database connections · ${n("snippets")} saved commands\n\nMerge adds only the items you do not have yet and keeps your settings. Replace overwrites everything (database passwords and the AI key you already saved are kept).`,
        buttons: [{ id: "cancel", label: "Cancel" }, { id: "replace", label: "Replace all", cls: "danger" }, { id: "merge", label: "Merge", cls: "primary" }],
      });
      if (mode === "cancel") return;
      const r = await guarded(() => api("POST", "/api/import", { data, mode }));
      if (!r) return;
      await W.reloadConfig();
      W.paintActivity();
      const moved = r.home ? `\nPaths moved from ${r.home.from} to ${r.home.to}` : "";
      toast(`Imported: ${Object.entries(r.added).map(([k, v]) => `${v >= 0 ? "+" : ""}${v} ${k}`).join(" · ")}${moved}`, "ok", 8000);
    };
    input.click();
  }
  actions["import-config"] = importConfig;

  const openSettings = (section) => {
    const t = W.openTab({ id: "settings", title: "Settings", icon: W.ICON.settings, persist: { kind: "settings", data: {} }, create: (host) => settingsTab(host) });
    if (section) setTimeout(() => t.inst?.jump?.(section), 30);
  };
  W.registerRestorer("settings", () => openSettings());
  W.registerView("settings", { title: "Settings", icon: W.ICON.settings, bottom: true, order: 99, action: () => openSettings() });
  W.command("settings.open", "Open settings", () => openSettings(), "Ctrl+,");
  W.command("settings.keys", "Keyboard shortcuts", () => openSettings("Keyboard shortcuts"), "Ctrl+Shift+H");
  W.command("settings.export", "Export configuration (JSON)", () => {
    const a = document.createElement("a");
    a.href = "/api/export";
    a.download = "";
    a.click();
  });
  W.command("settings.import", "Import configuration (JSON)…", () => importConfig());
  W.command("claude.update", "Claude: update Claude Code now", async () => {
    toast("Running claude update…");
    const r = await api("POST", "/api/claude/update").catch((e) => ({ error: e.message }));
    toast(r.error ? r.error.split("\n").pop() : `${r.version} · ${(r.output || "up to date").split("\n").pop()}`, r.error ? "error" : "ok", 6000);
  });

  // ---------- SSH ----------
  let sshRoot = null;
  let forwards = []; // chuyển tiếp cổng đang chạy (từ server)
  const profiles = () => S.config?.ssh || [];
  const TAG_CLS = { ROOT: "red", LAN: "cyan", VPN: "violet", CLOUD: "amber", WAN: "blue" };

  function paintSsh() {
    if (!sshRoot) return;
    const list = profiles();
    $(".ssh-list", sshRoot).innerHTML =
      list
        .map((p) => {
          const tag = W.term.sshTag(p);
          const fw = forwards.filter((f) => f.profileId === p.id);
          return `<div class="ssh-row" data-ssh="${esc(p.id)}" title="Double-click to connect"><span class="ssh-tag tag-${TAG_CLS[tag]}">${tag}</span><span class="ssh-label">${esc(p.label)}</span>
            <span class="ssh-host faint">${esc(p.user ? `${p.user}@` : "")}${esc(p.host)}${p.port !== 22 ? `:${p.port}` : ""}</span>
            <span class="ssh-actions"><button class="icon" data-ssh-act="connect" title="Open a terminal">▶</button><button class="icon" data-ssh-act="folder" title="Open a folder on the remote machine in the Explorer">${W.ICON.files}</button><button class="icon" data-ssh-act="forward" title="Port forwarding">⇄</button><button class="icon" data-ssh-act="edit" title="Edit">✎</button></span></div>
            ${fw.map((f) => `<div class="fw-row ${f.running ? "" : "dead"}" data-fw="${esc(f.id)}" title="${esc(f.error || "")}"><span class="dot ${f.running ? "on" : "err"}"></span><a href="http://localhost:${f.local}" target="_blank" rel="noopener" class="mono">:${f.local}</a><span class="faint mono">→ ${esc(f.host)}:${f.remote}</span>${f.label ? `<span class="faint">${esc(f.label)}</span>` : ""}${f.running ? "" : `<span class="err">${esc((f.error || "stopped").split("\n").pop())}</span>`}<button class="icon" data-fw-stop="${esc(f.id)}" title="${f.running ? "Stop" : "Remove"}">✕</button></div>`).join("")}`;
        })
        .join("") || `<div class="empty">No SSH profiles.<br><br><button class="btn sm primary" data-ssh-top="add">＋ Add SSH profile</button></div>`;
  }

  async function loadForwards() {
    forwards = await api("GET", "/api/ssh/forwards").catch(() => forwards);
    paintSsh();
  }

  async function saveProfiles(list) {
    await api("PUT", "/api/ssh", { profiles: list });
    await W.reloadConfig();
    paintSsh();
  }

  function sshModal(p = {}) {
    const isNew = !p.id;
    const m = openModal(
      isNew ? "Add SSH profile" : `Edit ${esc(p.label)}`,
      `<form id="ssh-form" class="form">
        <label class="field"><span>Label</span><input name="label" value="${esc(p.label || "")}" required /></label>
        <label class="field"><span>Host</span><input name="host" class="mono" value="${esc(p.host || "")}" required placeholder="192.168.1.10 or alias" /></label>
        <label class="field"><span>User</span><input name="user" class="mono" value="${esc(p.user || "")}" /></label>
        <label class="field"><span>Port</span><input name="port" type="number" value="${esc(p.port || 22)}" /></label>
        <label class="field full"><span>Identity file (optional)</span><input name="identityFile" class="mono" value="${esc(p.identityFile || "")}" placeholder="~/.ssh/id_ed25519" /></label>
        <label class="field full"><span>Remote folder (optional)</span><input name="remoteDir" class="mono" value="${esc(p.remoteDir || "")}" placeholder="/var/www/app" /><small>Terminals start here, and "Open folder" suggests it.</small></label>
        <label class="field full"><span>Extra ssh arguments (optional)</span><input name="args" class="mono" value="${esc(p.args || "")}" placeholder="-o StrictHostKeyChecking=no" /></label>
        <div class="field full"><div class="notice">Passwords are not stored. Terminals can ask for a password; browsing folders, remote projects and port forwarding need an SSH key or ssh-agent.</div></div>
      </form>`,
      `${isNew ? "" : `<button class="btn danger" id="ssh-del" style="margin-right:auto">Delete</button>`}<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" form="ssh-form">Save</button>`
    );
    $("#ssh-form", m).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const data = { ...p, ...f, port: Number(f.port) || 22 };
      const list = isNew ? [...profiles(), data] : profiles().map((x) => (x.id === p.id ? data : x));
      if (await guarded(() => saveProfiles(list), "SSH profile saved")) closeModal();
    };
    $("#ssh-del", m)?.addEventListener("click", () => deleteProfile(p, true));
  }

  async function deleteProfile(p, fromModal) {
    if (!(await confirmDialog(`Delete SSH profile "${p.label}"?`, { title: "Delete SSH profile", ok: "Delete", danger: true }))) return;
    if ((await guarded(() => saveProfiles(profiles().filter((x) => x.id !== p.id)), "Deleted")) !== null && fromModal) closeModal();
  }

  // Mở một thư mục trên máy SSH trong Explorer (đường dẫn ssh://<id>/…)
  async function openRemoteFolder(p) {
    const dir = await W.prompt(`Open folder on ${p.label}`, p.remoteDir || (p.user === "root" ? "/root" : `/home/${p.user || ""}`), { label: "Absolute path on the remote machine" });
    if (!dir) return;
    if (!dir.startsWith("/")) return toast("Enter an absolute path", "error");
    const target = `ssh://${p.id}${dir.replace(/\/+$/, "") || "/"}`;
    if (!(await guarded(() => api("GET", `/api/files/list?path=${encodeURIComponent(target)}`)))) return;
    W.setFolder(target);
    const recent = store.get("recentFolders", []);
    store.set("recentFolders", [target, ...recent.filter((r) => r !== target)].slice(0, 15));
    W.showView("explorer");
  }

  // Chuyển tiếp cổng: danh sách đã lưu trong hồ sơ (bật / tắt) và form thêm mới
  function forwardModal(p) {
    const saved = () => profiles().find((x) => x.id === p.id)?.forwards || [];
    const running = (local) => forwards.find((f) => f.profileId === p.id && f.local === local);
    const m = openModal(
      `Port forwarding · ${esc(p.label)}`,
      `<div class="fw-saved"></div>
      <form id="fw-form" class="form">
        <label class="field"><span>Local port</span><input name="local" type="number" min="1" max="65535" required placeholder="5432" /></label>
        <label class="field"><span>Remote port</span><input name="remote" type="number" min="1" max="65535" required placeholder="5432" /></label>
        <label class="field"><span>Remote host</span><input name="host" class="mono" value="localhost" /><small>As seen from ${esc(p.host)}</small></label>
        <label class="field"><span>Label</span><input name="label" placeholder="postgres" /></label>
        <label class="field full"><label class="check"><input type="checkbox" name="save" checked /> Save in this profile</label></label>
      </form>
      <p class="faint" style="font-size:12px;margin-bottom:0">Runs <code>ssh -N -L 127.0.0.1:local:host:remote</code>. Needs an SSH key or ssh-agent. Forwards stop when Dash stops.</p>`,
      `<button class="btn" data-action="close-modal">Close</button><button class="btn primary" form="fw-form">Start forward</button>`
    );
    const paint = () => {
      const list = saved();
      $(".fw-saved", m).innerHTML = list.length
        ? `<table class="kb-table"><thead><tr><th></th><th>Local</th><th>Remote</th><th>Label</th><th></th></tr></thead><tbody>${list
            .map((f, i) => {
              const r = running(f.local);
              return `<tr><td><span class="dot ${r?.running ? "on" : r ? "err" : ""}"></span></td><td class="mono">:${f.local}</td><td class="mono">${esc(f.host)}:${f.remote}</td><td>${esc(f.label)}</td>
                <td class="actions">${r?.running ? `<button class="btn sm danger" data-fw-off="${i}">Stop</button>` : `<button class="btn sm success" data-fw-on="${i}">Start</button>`}<button class="btn sm ghost" data-fw-del="${i}" title="Remove from profile">✕</button></td></tr>`;
            })
            .join("")}</tbody></table>`
        : `<p class="faint" style="margin-top:0">No saved forwards yet.</p>`;
    };
    const start = async (spec) => {
      if (await guarded(() => api("POST", `/api/ssh/${p.id}/forwards`, spec), `Forwarding :${spec.local} → ${spec.host}:${spec.remote}`)) {
        await loadForwards();
        // ssh báo lỗi (cổng bận, đăng nhập thất bại) sau một chút
        setTimeout(async () => {
          await loadForwards();
          const r = running(Number(spec.local));
          if (r && !r.running) toast(`:${spec.local}: ${r.error || "stopped"}`, "error");
          if (m.open) paint();
        }, 2500);
      }
      paint();
    };
    m.onclick = async (e) => {
      const on = e.target.closest("[data-fw-on]");
      const off = e.target.closest("[data-fw-off]");
      const del = e.target.closest("[data-fw-del]");
      if (on) return start(saved()[Number(on.dataset.fwOn)]);
      if (off) {
        await api("DELETE", `/api/ssh/forwards/${encodeURIComponent(`${p.id}:${saved()[Number(off.dataset.fwOff)].local}`)}`).catch(() => {});
        await loadForwards();
        return paint();
      }
      if (del) {
        const list = saved().filter((_, i) => i !== Number(del.dataset.fwDel));
        await guarded(() => saveProfiles(profiles().map((x) => (x.id === p.id ? { ...x, forwards: list } : x))));
        return paint();
      }
    };
    $("#fw-form", m).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const spec = { local: Number(f.local), remote: Number(f.remote), host: f.host.trim() || "localhost", label: f.label.trim() };
      if (f.save && !saved().some((x) => x.local === spec.local)) await guarded(() => saveProfiles(profiles().map((x) => (x.id === p.id ? { ...x, forwards: [...(x.forwards || []), spec] } : x))));
      e.target.reset();
      e.target.host.value = "localhost";
      await start(spec);
    };
    paint();
  }

  function mountSsh(body, actions) {
    sshRoot = body;
    body.innerHTML = `<div class="ssh-list"></div>`;
    actions.innerHTML = `<button class="icon" data-ssh-top="add" title="Add profile">＋</button>`;
    const onClick = async (e) => {
      if (e.target.closest("[data-ssh-top]")) return sshModal();
      const stop = e.target.closest("[data-fw-stop]");
      if (stop) {
        await api("DELETE", `/api/ssh/forwards/${encodeURIComponent(stop.dataset.fwStop)}`).catch(() => {});
        return loadForwards();
      }
      const row = e.target.closest("[data-ssh]");
      if (!row) return;
      const p = profiles().find((x) => x.id === row.dataset.ssh);
      const act = e.target.closest("[data-ssh-act]")?.dataset.sshAct;
      if (act === "connect") W.term.create({ ssh: p.id });
      if (act === "edit") sshModal(p);
      if (act === "folder") openRemoteFolder(p);
      if (act === "forward") forwardModal(p);
    };
    actions.addEventListener("click", onClick);
    body.addEventListener("click", onClick);
    body.addEventListener("dblclick", (e) => {
      const row = e.target.closest("[data-ssh]");
      if (row && !e.target.closest("button")) W.term.create({ ssh: row.dataset.ssh });
    });
    body.addEventListener("contextmenu", (e) => {
      const row = e.target.closest("[data-ssh]");
      if (!row) return;
      const p = profiles().find((x) => x.id === row.dataset.ssh);
      W.menu(e, [
        { label: "Connect", run: () => W.term.create({ ssh: p.id }) },
        { label: "Open folder…", run: () => openRemoteFolder(p) },
        { label: "Port forwarding…", run: () => forwardModal(p) },
        { label: "Copy ssh command", run: () => navigator.clipboard?.writeText(`ssh ${p.port !== 22 ? `-p ${p.port} ` : ""}${p.user ? `${p.user}@` : ""}${p.host}`) },
        { label: "Edit…", run: () => sshModal(p) },
        { sep: true },
        { label: "Delete", danger: true, run: () => deleteProfile(p) },
      ]);
    });
    loadForwards();
  }

  W.onMsg("forward", () => loadForwards());
  // Cho terminal SSH dùng: mở thư mục / chuyển tiếp cổng của đúng máy đang kết nối
  W.ssh = {
    openFolder: (id) => {
      const p = profiles().find((x) => x.id === id);
      if (p) openRemoteFolder(p);
    },
    forward: (id) => {
      const p = profiles().find((x) => x.id === id);
      if (p) forwardModal(p);
    },
  };
  // Lệnh palette: ưu tiên máy của terminal SSH đang focus, không thì hỏi chọn máy
  const pickProfile = async (placeholder) => {
    const cur = W.term.focusedPane()?.info.sshId;
    if (cur && profiles().some((x) => x.id === cur)) return cur;
    return W.quickPick(profiles().map((p) => ({ label: p.label, detail: `${p.user ? `${p.user}@` : ""}${p.host}`, value: p.id })), { placeholder });
  };
  W.registerView("terminals", { title: "Terminals", icon: W.ICON.terminal, order: 4, action: () => W.run("terminal.toggle") });
  W.registerView("ssh", { title: "SSH", icon: W.ICON.ssh, order: 4.5, key: "view.ssh", mount: mountSsh, show: paintSsh });
  W.command("view.ssh", "Show SSH profiles", () => W.showView("ssh"), "Ctrl+Shift+U");
  W.command("ssh.add", "SSH: add profile…", () => sshModal());
  W.command("ssh.openFolder", "SSH: open remote folder…", async () => W.ssh.openFolder(await pickProfile("Open a folder on…")));
  W.command("ssh.forward", "SSH: port forwarding…", async () => W.ssh.forward(await pickProfile("Forward ports through…")));
  W.on("config", paintSsh);
})();
