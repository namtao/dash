"use strict";
// Chọn môi trường Python cho dự án (kiểu "Select Interpreter" của VS Code): mục ở thanh trạng thái và lệnh
// "Select Python environment…". Env đã chọn được lưu vào project.env; lệnh của dự án chạy trong env đó và
// terminal mới mở trong thư mục dự án tự kích hoạt nó (shell-integration/activate-python-env.sh).
(() => {
  let data = null; // { env, status, venvs, conda }
  let pid = null;
  let seq = 0;

  // Dự án của cửa sổ này; cửa sổ chính thì là dự án chứa thư mục đang mở
  function currentProject() {
    const projects = S.config?.projects || [];
    const own = projects.find((p) => p.id === W.wsId);
    if (own) return own;
    const dir = W.folder || "";
    return projects.filter((p) => dir === p.path || dir.startsWith(p.path.replace(/\/+$/, "") + "/")).sort((a, b) => b.path.length - a.path.length)[0] || null;
  }

  const envLabel = (env) => (env.type === "conda" ? `conda: ${env.name}` : env.path || ".venv");
  const shortVersion = (v) => String(v || "").replace(/^Python\s+/i, "");

  async function refresh() {
    const p = currentProject();
    const my = ++seq;
    pid = p?.id || null;
    if (!p || W.isRemote(p.path)) {
      data = null;
      return paint();
    }
    try {
      const r = await api("GET", `/api/projects/${encodeURIComponent(p.id)}/python-envs`);
      if (my !== seq) return;
      data = r;
    } catch {
      if (my !== seq) return;
      data = null;
    }
    paint();
  }

  function paint() {
    if (!data) return W.status("pyenv", null);
    const { env, status } = data;
    if (env.type === "none") {
      return W.status("pyenv", { order: 14, cls: "sb-dim", html: `<span>🐍 Select Python env</span>`, title: "No Python env selected for this project · click to pick one", cmd: "python.selectEnv" });
    }
    const ver = shortVersion(status.pythonVersion);
    W.status("pyenv", {
      order: 14,
      cls: status.exists ? "" : "sb-warn",
      html: `<span>🐍 ${esc(envLabel(env))}${status.exists ? (ver ? ` (${esc(ver)})` : "") : " (not created)"}</span>`,
      title: `${env.type} · ${status.prefix || status.target || ""}\n${status.exists ? "Project commands use this env and new terminals in the project activate it." : "This env does not exist yet. Create it in the Env tab."}\nClick to pick another env`,
      cmd: "python.selectEnv",
    });
  }

  function openEnvTab(p) {
    location.hash = `#/p/${encodeURIComponent(p.id)}/env`;
    W.openTab({ id: "dashboard", title: p.name, icon: W.ICON.home });
  }

  async function select() {
    const p = currentProject();
    if (!p) return toast("Open a project folder first", "error");
    if (W.isRemote(p.path)) return toast("Python envs are only available for local projects", "error");
    await refresh();
    if (!data) return;
    const cur = data.env;
    const isVenv = cur.type === "venv" || cur.type === "uv";
    const mark = (on) => (on ? "● " : "");
    const items = [
      ...data.venvs.map((v) => ({
        label: `${mark(isVenv && (cur.path || ".venv") === v.path)}${v.path}`,
        detail: `${v.kind === "uv" ? "uv venv" : "venv"}${v.python ? ` · Python ${v.python}` : ""}`,
        value: { type: v.kind, path: v.path },
      })),
      ...data.conda.map((c) => ({ label: `${mark(cur.type === "conda" && cur.name === c.name)}conda: ${c.name}`, detail: c.prefix, value: { type: "conda", name: c.name } })),
      { label: `${mark(cur.type === "none")}None`, detail: "system Python, terminals are not activated", value: { type: "none" } },
      { label: "Create or configure an env…", detail: "open the project's Env tab", value: "configure" },
    ];
    const picked = await W.quickPick(items, { placeholder: `Python env for ${p.name}` });
    if (!picked) return;
    if (picked === "configure") return openEnvTab(p);
    const saved = await guarded(() => api("PUT", `/api/projects/${encodeURIComponent(p.id)}`, { ...p, env: { ...picked, python: cur.python || "" } }));
    if (!saved) return;
    await W.reloadConfig();
    toast(picked.type === "none" ? `${p.name} no longer uses a Python env` : `${p.name} now uses ${envLabel(saved.env)}. New terminals in the project activate it.`, "ok");
  }

  W.command("python.selectEnv", "Select Python environment…", select);
  W.on("ready", refresh);
  W.on("config", refresh);
  W.on("pyenv", refresh);
  W.on("folder", () => {
    if (currentProject()?.id !== pid) refresh();
  });
})();
