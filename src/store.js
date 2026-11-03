// Đọc/ghi cấu hình projects.json (ghi nguyên tử) và chuẩn hoá dữ liệu dự án.
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = process.env.DASH_CONFIG || path.join(ROOT, "projects.json");

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 8899,
  python: "python3",
  projectsRoot: path.dirname(ROOT),
};

const ENV_TYPES = ["none", "conda", "venv", "uv"];

// Shell mặc định: zsh nếu có (macOS: /bin/zsh, Linux thường /usr/bin/zsh), rồi tới $SHELL, cuối cùng bash.
const isFile = (f) => Boolean(f) && fs.existsSync(f);
const DEFAULT_SHELL = [process.env.SHELL_FOR_DASH, "/bin/zsh", "/usr/bin/zsh", process.env.SHELL].find(isFile) || "/bin/bash";

// Tuỳ chọn của workspace (terminal, editor, Claude, phím tắt). Kiểu dữ liệu lấy theo giá trị mặc định.
const DEFAULT_WORKSPACE = {
  shell: DEFAULT_SHELL,
  fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClickPaste: true,
  confirmDangerousPaste: true,
  editorFontSize: 13,
  editorTabSize: 2,
  editorWordWrap: false,
  claudeModel: "",
  claudePermissionMode: "default",
  claudeEffort: "",
  usageRefreshSec: 60,
  backupDir: path.join(os.homedir(), "Backups", "dash"),
  sqlRowLimit: 500,
  autoSave: true,
  autoSaveDelay: 1000,
  claudeAutoUpdate: true,
  keybindings: {},
};
// AI chạy local (OpenAI-compatible như Cline: Ollama, LM Studio, llama.cpp…). Khoá API chỉ nằm ở server.
const DEFAULT_AI = { baseUrl: "http://localhost:11434/v1", model: "", apiKey: "" };
const SNIPPET_OS = ["any", "linux", "macos", "windows"];
// Thư mục / dự án trên máy SSH: ssh://<id hồ sơ>/đường/dẫn/tuyệt/đối
const REMOTE_RE = /^ssh:\/\/([^/]+)(\/.*)$/;
const CURSOR_STYLES = ["bar", "block", "underline"];
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "auto"];
const DB_TYPES = ["postgres", "mysql", "mssql", "sqlite"];
const DB_PORTS = { postgres: 5432, mysql: 3306, mssql: 1433, sqlite: null };

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
  const remote = dir.match(REMOTE_RE);
  if (!dir || (!remote && !path.isAbsolute(dir))) throw new Error(`Project "${name}" needs an absolute path`);
  const id = p.id && !takenIds.has(p.id) ? slugify(p.id) : uniqueId(name, takenIds);
  takenIds.add(id);
  const cmdIds = new Set();
  return {
    id,
    name,
    path: remote ? `ssh://${remote[1]}${path.posix.resolve(remote[2])}` : path.resolve(dir),
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

function normalizeWorkspace(raw = {}) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_WORKSPACE)) {
    const v = raw[key];
    if (typeof def === "number") out[key] = Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : def;
    else if (typeof def === "boolean") out[key] = v == null ? def : v === true || v === "true" || v === "on";
    else if (typeof def === "object") out[key] = v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
    else out[key] = String(v ?? def).trim();
  }
  if (!CURSOR_STYLES.includes(out.cursorStyle)) out.cursorStyle = DEFAULT_WORKSPACE.cursorStyle;
  if (!PERMISSION_MODES.includes(out.claudePermissionMode)) out.claudePermissionMode = "default";
  out.fontSize = Math.min(32, Math.max(8, out.fontSize));
  out.usageRefreshSec = Math.max(30, out.usageRefreshSec);
  out.sqlRowLimit = Math.min(100000, Math.max(10, Math.round(out.sqlRowLimit)));
  out.autoSaveDelay = Math.min(60000, Math.max(200, Math.round(out.autoSaveDelay)));
  // Shell không có trên máy này (vd. cấu hình chép từ Linux sang macOS) thì dùng shell mặc định
  if (!isFile(out.shell)) out.shell = DEFAULT_WORKSPACE.shell;
  for (const [k, v] of Object.entries(out.keybindings)) if (typeof v !== "string") delete out.keybindings[k];
  return out;
}

function normalizeSsh(list) {
  const ids = new Set();
  return (Array.isArray(list) ? list : []).map((h) => {
    const label = String(h.label || h.host || "").trim();
    const host = String(h.host || "").trim();
    if (!label || !host) throw new Error("SSH profile needs a label and a host");
    const id = h.id && !ids.has(h.id) ? slugify(h.id) : uniqueId(label, ids);
    ids.add(id);
    return {
      id,
      label,
      host,
      port: Number(h.port) || 22,
      user: String(h.user || "").trim(),
      identityFile: String(h.identityFile || "").trim(),
      args: String(h.args || "").trim(),
      remoteDir: String(h.remoteDir || "").trim(),
      forwards: (Array.isArray(h.forwards) ? h.forwards : []).map(normalizeForward).filter(Boolean),
    };
  });
}

// Chuyển tiếp cổng: cổng local -> host:cổng nhìn từ máy SSH
function normalizeForward(f) {
  const local = Number(f?.local);
  const remote = Number(f?.remote);
  const ok = (n) => Number.isInteger(n) && n > 0 && n < 65536;
  if (!ok(local) || !ok(remote)) return null;
  return { local, host: String(f.host || "localhost").trim() || "localhost", remote, label: String(f.label || "").trim() };
}

function normalizeAi(raw = {}, previous = {}) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_AI)) out[k] = String(raw[k] ?? def).trim();
  out.baseUrl = out.baseUrl.replace(/\/+$/, "") || DEFAULT_AI.baseUrl;
  if (!/^https?:\/\//.test(out.baseUrl)) throw new Error("AI base URL must start with http:// or https://");
  if (!raw.apiKey && raw.apiKey !== null) out.apiKey = previous.apiKey || "";
  return out;
}

// Câu lệnh hay dùng (như quick commands của WezTerm)
function normalizeSnippets(list) {
  const ids = new Set();
  return (Array.isArray(list) ? list : []).map((x) => {
    const name = String(x.name || "").trim();
    const command = String(x.command || "").replace(/\s+$/, "");
    if (!name || !command.trim()) throw new Error("Saved command needs a name and a command");
    const id = x.id && !ids.has(x.id) ? slugify(x.id) : uniqueId(name, ids);
    ids.add(id);
    return {
      id,
      name,
      command,
      group: String(x.group || "").trim(),
      os: SNIPPET_OS.includes(x.os) ? x.os : "any",
      description: String(x.description || "").trim(),
    };
  });
}

// Mật khẩu DB lưu trong file cấu hình (không commit, quyền 600). Giữ mật khẩu cũ khi form gửi trống.
function normalizeDatabases(list, previous = []) {
  const ids = new Set();
  return (Array.isArray(list) ? list : []).map((d) => {
    const type = DB_TYPES.includes(d.type) ? d.type : "postgres";
    const name = String(d.name || "").trim();
    if (!name) throw new Error("Connection needs a name");
    const id = d.id && !ids.has(d.id) ? slugify(d.id) : uniqueId(name, ids);
    ids.add(id);
    const old = previous.find((x) => x.id === id);
    const out = { id, name, type, color: String(d.color || "").trim() };
    if (type === "sqlite") {
      out.file = String(d.file || "").trim();
      if (!path.isAbsolute(out.file)) throw new Error(`"${name}": SQLite file must be an absolute path`);
      return out;
    }
    out.host = String(d.host || "localhost").trim();
    out.port = Number(d.port) || DB_PORTS[type];
    out.user = String(d.user || "").trim();
    out.password = d.password != null && d.password !== "" ? String(d.password) : old?.password || "";
    out.database = String(d.database || "").trim();
    out.ssl = Boolean(d.ssl);
    return out;
  });
}

function normalizeConfig(raw, previous = cache) {
  if (!raw || typeof raw !== "object") throw new Error("Config must be a JSON object");
  const settings = normalizeSettings(raw.settings);
  const ids = new Set();
  const projects = (raw.projects || []).map((p) => normalizeProject(p, ids));
  return {
    settings,
    workspace: normalizeWorkspace(raw.workspace),
    ssh: normalizeSsh(raw.ssh),
    databases: normalizeDatabases(raw.databases, previous?.databases),
    ai: normalizeAi(raw.ai, previous?.ai),
    snippets: normalizeSnippets(raw.snippets),
    projects,
  };
}

// Bản gửi cho trình duyệt: không kèm mật khẩu DB và khoá API.
function publicConfig() {
  const c = load();
  const { apiKey, ...ai } = c.ai;
  return { ...c, ai: { ...ai, hasApiKey: Boolean(apiKey) }, databases: c.databases.map(({ password, ...d }) => ({ ...d, hasPassword: Boolean(password) })) };
}

// Xuất toàn bộ cấu hình ra JSON để sao lưu / chuyển máy: bỏ mật khẩu, khoá API.
// Kèm thư mục home để máy nhập đổi được đường dẫn (/home/a -> /Users/a).
function exportConfig() {
  const { ai, databases, ...c } = publicConfig();
  const { hasApiKey, ...aiPublic } = ai;
  return {
    app: "dash",
    exportedAt: new Date().toISOString(),
    home: os.homedir(),
    ...c,
    ai: aiPublic,
    databases: databases.map(({ hasPassword, ...d }) => d),
  };
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
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  cache = config;
}

function replaceAll(raw) {
  const config = normalizeConfig(raw);
  save(config);
  return config;
}

// Thư mục home của máy đã xuất: lấy từ file, file cũ thì đoán từ đường dẫn local đầu tiên dạng /home/x hoặc /Users/x.
function exportedHome(data) {
  if (typeof data.home === "string" && path.isAbsolute(data.home)) return data.home.replace(/\/+$/, "");
  const paths = [data.settings?.projectsRoot, ...data.projects.map((p) => p?.path)];
  for (const p of paths) {
    const m = typeof p === "string" && p.match(/^\/(?:home|Users)\/[^/]+/);
    if (m) return m[0];
  }
  return "";
}

// Đổi home cũ sang home của máy này trong mọi chuỗi phía local. Bỏ qua thứ chạy trên máy SSH:
// dự án ssh://, thư mục từ xa của hồ sơ SSH và câu lệnh đã lưu (có thể gõ trong terminal SSH).
function remapHome(data, from, to) {
  const re = new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g");
  const deep = (v) => {
    if (typeof v === "string") return v.startsWith("ssh://") ? v : v.replace(re, to);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    return v;
  };
  return {
    ...data,
    settings: deep(data.settings),
    workspace: deep(data.workspace),
    databases: deep(data.databases),
    ssh: Array.isArray(data.ssh) ? data.ssh.map((h) => (h && typeof h === "object" ? { ...deep(h), remoteDir: h.remoteDir } : h)) : data.ssh,
    projects: data.projects.map((p) => (typeof p?.path === "string" && p.path.startsWith("ssh://") ? p : deep(p))),
  };
}

// Nhập file đã xuất. "merge": giữ cấu hình hiện tại, chỉ thêm dự án / SSH / kết nối / câu lệnh chưa có (theo id).
// "replace": thay toàn bộ. Mật khẩu DB và khoá API không có trong file xuất nên được giữ nguyên theo id.
// File từ máy khác (home khác, vd. Linux -> macOS) được đổi đường dẫn home trước khi nhập.
function importConfig(data, mode = "merge") {
  if (!data || typeof data !== "object" || !Array.isArray(data.projects)) throw Object.assign(new Error("This is not a Dash configuration file"), { status: 400 });
  const from = exportedHome(data);
  const home = os.homedir();
  if (from && from !== home) data = remapHome(data, from, home);
  const cur = load();
  const LISTS = ["projects", "ssh", "databases", "snippets"];
  let next;
  if (mode === "replace") {
    next = { ...cur, ...data, ai: { ...cur.ai, ...(data.ai || {}), apiKey: cur.ai.apiKey } };
  } else {
    next = { ...cur };
    for (const k of LISTS) {
      const have = new Set(cur[k].map((x) => x.id));
      next[k] = [...cur[k], ...(Array.isArray(data[k]) ? data[k] : []).filter((x) => x && !have.has(x.id))];
    }
  }
  const config = normalizeConfig(next);
  save(config);
  return { added: Object.fromEntries(LISTS.map((k) => [k, config[k].length - cur[k].length])), home: from && from !== home ? { from, to: home } : null };
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

function updateSection(key, value) {
  const config = load();
  const next = normalizeConfig({ ...config, [key]: value });
  save(next);
  return next[key];
}

function getDatabase(id) {
  const d = load().databases.find((x) => x.id === id);
  if (!d) throw Object.assign(new Error("Connection not found"), { status: 404 });
  return d;
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
  updateSection,
  getDatabase,
  publicConfig,
  exportConfig,
  importConfig,
  slugify,
  REMOTE_RE,
  DEFAULT_WORKSPACE,
};
