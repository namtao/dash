// Đọc/ghi cấu hình projects.json (ghi nguyên tử) và chuẩn hoá dữ liệu dự án.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = process.env.DASH_CONFIG || path.join(ROOT, "projects.json");

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 8899,
  python: "python3",
  projectsRoot: path.dirname(ROOT),
  editor: "code {dir}",
  terminal: "",
};

const ENV_TYPES = ["none", "conda", "venv", "uv"];

function slugify(text) {
  return (
    String(text || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

function uniqueId(base, taken) {
  let id = slugify(base);
  let n = 2;
  while (taken.has(id)) id = `${slugify(base)}-${n++}`;
  return id;
}

function normalizeCommand(cmd, taken) {
  if (!cmd || typeof cmd !== "object") throw new Error("Invalid command");
  const name = String(cmd.name || "").trim();
  const line = String(cmd.cmd || "").trim();
  if (!name) throw new Error("Command needs a name");
  if (!line) throw new Error(`Command "${name}" has no command line`);
  const id = cmd.id && !taken.has(cmd.id) ? slugify(cmd.id) : uniqueId(name, taken);
  taken.add(id);
  const port = Number(cmd.port) || null;
  return {
    id,
    name,
    cmd: line,
    cwd: String(cmd.cwd || "").trim(),
    background: Boolean(cmd.background),
    port: port && port > 0 && port < 65536 ? port : null,
    url: String(cmd.url || "").trim(),
    stopCmd: String(cmd.stopCmd || "").trim(),
    autostart: Boolean(cmd.autostart),
    autoRestart: Boolean(cmd.autoRestart),
  };
}

function normalizeEnv(env) {
  const type = ENV_TYPES.includes(env?.type) ? env.type : "none";
  const out = { type };
  if (type === "conda") out.name = String(env.name || "").trim();
  if (type === "venv" || type === "uv") out.path = String(env.path || ".venv").trim();
  if (type !== "none") out.python = String(env.python || "").trim();
  return out;
}

function normalizeEnvVars(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars || {})) {
    const key = String(k).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = String(v ?? "");
  }
  return out;
}

function normalizeProject(p, takenIds) {
  if (!p || typeof p !== "object") throw new Error("Invalid project");
  const name = String(p.name || "").trim();
  const dir = String(p.path || "").trim();
  if (!name) throw new Error("Project needs a name");
  if (!dir || !path.isAbsolute(dir)) throw new Error(`Project "${name}" needs an absolute path`);
  const id = p.id && !takenIds.has(p.id) ? slugify(p.id) : uniqueId(name, takenIds);
  takenIds.add(id);
  const cmdIds = new Set();
  return {
    id,
    name,
    path: path.resolve(dir),
    description: String(p.description || "").trim(),
    tags: (Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(","))
      .map((t) => String(t).trim())
      .filter(Boolean),
    url: String(p.url || "").trim(),
    env: normalizeEnv(p.env),
    envVars: normalizeEnvVars(p.envVars),
    commands: (p.commands || []).map((c) => normalizeCommand(c, cmdIds)),
  };
}

function normalizeSettings(raw = {}) {
  const settings = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    settings[key] = typeof def === "number" ? Number(raw[key] ?? def) : String(raw[key] ?? def).trim();
  }
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new Error("Port must be a number from 1 to 65535");
  if (!settings.host) settings.host = DEFAULT_SETTINGS.host;
  if (!settings.python) settings.python = DEFAULT_SETTINGS.python;
  if (settings.projectsRoot && !path.isAbsolute(settings.projectsRoot)) throw new Error("Projects folder must be an absolute path");
  return settings;
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Config must be a JSON object");
  const settings = normalizeSettings(raw.settings);
  const ids = new Set();
  const projects = (raw.projects || []).map((p) => normalizeProject(p, ids));
  return { settings, projects };
}

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(CONFIG_PATH)) {
    cache = normalizeConfig({ projects: [] });
    save(cache);
    return cache;
  }
  cache = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  return cache;
}

function save(config) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG_PATH);
  cache = config;
}

function replaceAll(raw) {
  const config = normalizeConfig(raw);
  save(config);
  return config;
}

function getProject(id) {
  const p = load().projects.find((x) => x.id === id);
  if (!p) throw Object.assign(new Error("Project not found"), { status: 404 });
  return p;
}

function getCommand(project, cmdId) {
  const c = project.commands.find((x) => x.id === cmdId);
  if (!c) throw Object.assign(new Error("Command not found"), { status: 404 });
  return c;
}

function upsertProject(data, existingId) {
  const config = load();
  const others = config.projects.filter((p) => p.id !== existingId);
  const ids = new Set(others.map((p) => p.id));
  const project = normalizeProject({ ...data, id: existingId || data.id }, ids);
  const idx = config.projects.findIndex((p) => p.id === existingId);
  const projects = [...config.projects];
  if (idx >= 0) projects[idx] = project;
  else projects.push(project);
  save({ ...config, projects });
  return project;
}

function deleteProject(id) {
  const config = load();
  getProject(id);
  save({ ...config, projects: config.projects.filter((p) => p.id !== id) });
}

function updateSettings(patch) {
  const config = load();
  const next = normalizeConfig({ ...config, settings: { ...config.settings, ...patch } });
  save(next);
  return next.settings;
}

module.exports = {
  ROOT,
  CONFIG_PATH,
  load,
  replaceAll,
  getProject,
  getCommand,
  upsertProject,
  deleteProject,
  updateSettings,
  slugify,
};
