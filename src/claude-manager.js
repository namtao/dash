// Quản lý toàn bộ Claude Code trên máy: lịch sử chat mọi thư mục, skills, agents, lệnh /, output style,
// rules, CLAUDE.md và memory, hooks, quyền, MCP server, plugin.
//
// Đọc trực tiếp các file của Claude Code (~/.claude, <dự án>/.claude, ~/.claude.json, .mcp.json).
// Ghi: settings.json chỉ sửa đúng một khoá (ghi nguyên tử, giữ bản sao lưu gần nhất trong ~/.claude/backups);
// MCP và plugin đi qua CLI `claude mcp` / `claude plugin` để không đụng ~/.claude.json mà Claude Code ghi liên tục.
// Xoá skill/agent/lệnh… là chuyển vào ~/.claude/backups/dash-trash, không xoá hẳn.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const HOME = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const CLAUDE_JSON = () => (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json"));
const MASK = "••••••";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS = { skill: "skills", agent: "agents", command: "commands", rule: "rules", outputStyle: "output-styles" };

const err = (status, message) => Object.assign(new Error(message), { status });
let sdk = null;
const loadSdk = async () => (sdk ||= await import("@anthropic-ai/claude-agent-sdk"));
let binary = () => "claude";

const readJson = (p, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p) => fs.existsSync(p);
// Claude Code lưu đường dẫn thật (macOS: /tmp là /private/tmp), nên so sánh theo realpath.
const local = (cwd) => (cwd && !String(cwd).startsWith("ssh://") && path.isAbsolute(cwd) && isDir(cwd) ? fs.realpathSync(cwd) : "");
// Thư mục memory tự động của Claude Code: ~/.claude/projects/<đường dẫn, ký tự lạ thành ->/memory
const projectKey = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

// ---------- Front matter (YAML đơn giản: key: value, giá trị nhiều dòng với > hoặc |) ----------
function frontMatter(file) {
  let text;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.slice(0, n).toString("utf8");
  } catch {
    return {};
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { description: (text.split(/\r?\n/).find((l) => l.trim() && !/^#+\s*$/.test(l)) || "").replace(/^#+\s*/, "").slice(0, 200) };
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(" ").trim();
    }
    out[kv[1]] = v.replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return out;
}

// ---------- Phạm vi ----------
function roots(cwd) {
  const r = [{ scope: "user", dir: HOME() }];
  if (cwd) r.push({ scope: "project", dir: path.join(cwd, ".claude") });
  return r;
}

function settingsFiles(cwd) {
  const f = { user: path.join(HOME(), "settings.json") };
  if (cwd) {
    f.project = path.join(cwd, ".claude", "settings.json");
    f.local = path.join(cwd, ".claude", "settings.local.json");
  }
  return f;
}

// Plugin đã cài (installed_plugins.json v2: { plugins: { "ten@marketplace": [{ scope, installPath, version }] } })
function installedPlugins() {
  const j = readJson(path.join(HOME(), "plugins", "installed_plugins.json"), {});
  const out = [];
  for (const [id, entries] of Object.entries(j.plugins || {})) for (const e of [].concat(entries || [])) if (e?.installPath) out.push({ id, ...e });
  return out;
}

function listMd(dir, scope, recursive = false, prefix = "") {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (recursive && isDir(p)) out.push(...listMd(p, scope, true, `${prefix}${e.name}:`));
    else if (e.name.endsWith(".md") && !isDir(p)) {
      const fm = frontMatter(p);
      out.push({ name: fm.name || prefix + e.name.slice(0, -3), description: fm.description || "", model: fm.model || "", tools: fm.tools || "", scope, path: p });
    }
  }
  return out;
}

function listSkills(dir, scope) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => path.join(dir, n, "SKILL.md"))
    .filter(exists)
    .map((p) => {
      const fm = frontMatter(p);
      const d = path.dirname(p);
      let link = false;
      try {
        link = fs.lstatSync(d).isSymbolicLink();
      } catch {}
      return { name: fm.name || path.basename(d), description: fm.description || "", scope, path: p, dir: d, link };
    });
}

// ---------- Kiểm kê cấu hình ----------
async function inventory(cwdIn) {
  const cwd = local(cwdIn);
  const out = { home: HOME(), cwd, hookEvents: (await loadSdk()).HOOK_EVENTS || [], skills: [], agents: [], commands: [], rules: [], outputStyles: [], memory: [], settings: {}, hooks: {}, permissions: {}, mcp: [], plugins: installedPlugins().map(({ id, scope, version, installPath }) => ({ id, scope, version, installPath })) };
  const sources = [...roots(cwd), ...out.plugins.map((p) => ({ scope: `plugin:${p.id}`, dir: p.installPath, readOnly: true }))];
  for (const { scope, dir } of sources) {
    out.skills.push(...listSkills(path.join(dir, "skills"), scope));
    out.agents.push(...listMd(path.join(dir, "agents"), scope));
    out.commands.push(...listMd(path.join(dir, "commands"), scope, true));
    out.outputStyles.push(...listMd(path.join(dir, "output-styles"), scope));
    if (!scope.startsWith("plugin:")) out.rules.push(...listMd(path.join(dir, "rules"), scope, true));
  }

  const mem = (label, scope, p) => out.memory.push({ label, scope, path: p, exists: exists(p) });
  mem("User CLAUDE.md (all projects)", "user", path.join(HOME(), "CLAUDE.md"));
  if (cwd) {
    mem("Project CLAUDE.md (shared, committed)", "project", path.join(cwd, "CLAUDE.md"));
    if (exists(path.join(cwd, ".claude", "CLAUDE.md"))) mem("Project .claude/CLAUDE.md", "project", path.join(cwd, ".claude", "CLAUDE.md"));
    mem("CLAUDE.local.md (personal, not committed)", "local", path.join(cwd, "CLAUDE.local.md"));
    mem("AGENTS.md", "project", path.join(cwd, "AGENTS.md"));
    const memDir = path.join(HOME(), "projects", projectKey(cwd), "memory");
    out.memoryDir = memDir;
    for (const f of listMd(memDir, "memory")) mem(f.name === "MEMORY" ? "Auto memory index (MEMORY.md)" : `Auto memory: ${f.name}`, "memory", f.path);
  }
  out.memory = out.memory.filter((m) => m.exists || !/AGENTS\.md$/.test(m.path));

  for (const [scope, file] of Object.entries(settingsFiles(cwd))) {
    const j = readJson(file);
    out.settings[scope] = { path: file, exists: exists(file), keys: j ? Object.keys(j) : [], valid: !exists(file) || !!j };
    out.hooks[scope] = j?.hooks || {};
    out.permissions[scope] = j?.permissions || {};
    if (scope === "user") out.enabledPlugins = j?.enabledPlugins || {};
  }
  out.mcp = mcpList(cwd);
  return out;
}

// ---------- MCP ----------
function maskServer(cfg) {
  const c = { ...cfg };
  for (const k of ["env", "headers"]) if (c[k] && typeof c[k] === "object") c[k] = Object.fromEntries(Object.keys(c[k]).map((x) => [x, MASK]));
  return c;
}

function mcpRaw(cwd) {
  const cj = readJson(CLAUDE_JSON(), {});
  const list = [];
  for (const [name, config] of Object.entries(cj.mcpServers || {})) list.push({ name, scope: "user", config });
  if (cwd) {
    const proj = cj.projects?.[cwd] || {};
    for (const [name, config] of Object.entries(proj.mcpServers || {})) list.push({ name, scope: "local", config });
    const mcpJson = readJson(path.join(cwd, ".mcp.json"), {});
    for (const [name, config] of Object.entries(mcpJson.mcpServers || {})) {
      const approved = proj.enabledMcpjsonServers?.includes(name) ? "approved" : proj.disabledMcpjsonServers?.includes(name) ? "rejected" : "pending";
      list.push({ name, scope: "project", config, approval: approved });
    }
  }
  return list;
}
const mcpList = (cwd) => mcpRaw(cwd).map((s) => ({ ...s, config: maskServer(s.config) }));

// Giá trị env/header còn là MASK nghĩa là người dùng không sửa: lấy lại giá trị cũ.
function unmask(cfg, old) {
  const c = { ...cfg };
  for (const k of ["env", "headers"]) {
    if (!c[k] || typeof c[k] !== "object") continue;
    c[k] = Object.fromEntries(Object.entries(c[k]).map(([x, v]) => [x, v === MASK ? old?.[k]?.[x] ?? "" : v]));
  }
  return c;
}

function cli(args, cwd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(binary(), args, { cwd: cwd || os.homedir(), timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1" } }, (e, stdout, stderr) => {
      if (e) return reject(err(400, `${stderr || stdout || e.message}`.trim().slice(0, 2000)));
      resolve(String(stdout));
    });
  });
}

const checkScope = (scope, allowed) => {
  if (!allowed.includes(scope)) throw err(400, `Unknown scope: ${scope}`);
};

async function mcpSave({ cwd: cwdIn, scope, name, config, oldName, oldScope }) {
  const cwd = local(cwdIn);
  checkScope(scope, ["user", "local", "project"]);
  if (scope !== "user" && !cwd) throw err(400, "Open a local folder to use the project or local scope");
  if (!NAME_RE.test(name || "")) throw err(400, "Name: letters, digits, dot, dash or underscore");
  if (!config || typeof config !== "object") throw err(400, "Config must be a JSON object");
  const old = mcpRaw(cwd).find((s) => s.name === (oldName || name) && s.scope === (oldScope || scope));
  const full = unmask(config, old?.config);
  if (old) await cli(["mcp", "remove", "-s", old.scope, old.name], cwd);
  try {
    await cli(["mcp", "add-json", "-s", scope, name, JSON.stringify(full)], cwd);
  } catch (e) {
    if (old) await cli(["mcp", "add-json", "-s", old.scope, old.name, JSON.stringify(old.config)], cwd).catch(() => {});
    throw e;
  }
  return mcpList(cwd);
}

async function mcpRemove({ cwd: cwdIn, scope, name }) {
  const cwd = local(cwdIn);
  checkScope(scope, ["user", "local", "project"]);
  await cli(["mcp", "remove", "-s", scope, String(name)], cwd);
  return mcpList(cwd);
}

// ---------- Plugin ----------
const catalog = { at: 0, data: null };
async function plugins({ cwd: cwdIn, available = false } = {}) {
  const cwd = local(cwdIn);
  if (!available) return { installed: JSON.parse((await cli(["plugin", "list", "--json"], cwd)) || "[]"), marketplaces: readJson(path.join(HOME(), "plugins", "known_marketplaces.json"), {}) };
  if (!catalog.data || Date.now() - catalog.at > 10 * 60 * 1000) {
    catalog.data = JSON.parse(await cli(["plugin", "list", "--json", "--available"], cwd, 180000));
    catalog.at = Date.now();
  }
  return catalog.data;
}

async function pluginAction({ cwd: cwdIn, action, id, scope }) {
  const cwd = local(cwdIn);
  const args = {
    install: ["plugin", "install", id],
    uninstall: ["plugin", "uninstall", id],
    enable: ["plugin", "enable", id],
    disable: ["plugin", "disable", id],
    update: ["plugin", "update", id],
    "marketplace-add": ["plugin", "marketplace", "add", id],
    "marketplace-remove": ["plugin", "marketplace", "remove", id],
    "marketplace-update": ["plugin", "marketplace", "update", ...(id ? [id] : [])],
  }[action];
  if (!args) throw err(400, `Unknown plugin action: ${action}`);
  if (!action.startsWith("marketplace-update") && !String(id || "").trim()) throw err(400, "Plugin id is required");
  if (scope && !action.startsWith("marketplace")) {
    checkScope(scope, ["user", "project", "local"]);
    if (scope !== "user" && !cwd) throw err(400, "Open a local folder to use the project or local scope");
    args.push("-s", scope);
  }
  const out = await cli(args, cwd, 5 * 60 * 1000);
  catalog.at = 0;
  return { output: out.trim() };
}

// ---------- settings.json ----------
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o777;
    const bak = path.join(HOME(), "backups", "dash");
    fs.mkdirSync(bak, { recursive: true });
    fs.copyFileSync(file, path.join(bak, `${projectKey(file)}.bak`));
  } catch {}
  const tmp = `${file}.dash-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
}

// Đặt (hoặc xoá khi value = null) một khoá cấp cao nhất trong settings.json của một phạm vi.
function setSetting({ cwd: cwdIn, scope, key, value }) {
  const cwd = local(cwdIn);
  const file = settingsFiles(cwd)[scope];
  if (!file) throw err(400, scope === "user" ? `Unknown scope: ${scope}` : "Open a local folder to edit project settings");
  if (!key || typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw err(400, "Invalid key");
  const j = exists(file) ? readJson(file) : {};
  if (!j || typeof j !== "object") throw err(409, `${file} is not valid JSON; fix it in the editor first`);
  const empty = value == null || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);
  if (empty) delete j[key];
  else j[key] = value;
  writeJsonAtomic(file, j);
  return { path: file, value: j[key] ?? null };
}

// ---------- Tạo / xoá file cấu hình ----------
const TEMPLATES = {
  skill: (n) => `---\nname: ${n}\ndescription: What this skill does and when Claude should use it.\n---\n\n# ${n}\n\nInstructions for Claude.\n`,
  agent: (n) => `---\nname: ${n}\ndescription: When Claude should delegate to this agent.\ntools: Read, Grep, Glob, Bash\n---\n\nYou are ${n}. Describe the role, the steps and the output.\n`,
  command: (n) => `---\ndescription: What /${n} does\nargument-hint: [args]\n---\n\nPrompt for /${n}. Use $ARGUMENTS for the arguments.\n`,
  rule: (n) => `# ${n}\n\n- Rule text.\n`,
  outputStyle: (n) => `---\nname: ${n}\ndescription: How this style changes Claude's answers.\n---\n\nInstructions for the style.\n`,
};

function create({ cwd: cwdIn, kind, scope, name }) {
  const cwd = local(cwdIn);
  if (kind === "memory" || kind === "settings") {
    const p = String(name || "");
    const allowed = [
      ...Object.values(settingsFiles(cwd)),
      path.join(HOME(), "CLAUDE.md"),
      ...(cwd ? [path.join(cwd, "CLAUDE.md"), path.join(cwd, "CLAUDE.local.md")] : []),
    ];
    if (!allowed.includes(p)) throw err(400, "Not a Claude config file");
    if (!exists(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, kind === "settings" ? "{}\n" : "");
    }
    return { path: p };
  }
  if (!KINDS[kind]) throw err(400, `Unknown kind: ${kind}`);
  checkScope(scope, ["user", "project"]);
  if (scope === "project" && !cwd) throw err(400, "Open a local folder to add project items");
  if (!NAME_RE.test(name || "")) throw err(400, "Name: letters, digits, dot, dash or underscore");
  const base = path.join(scope === "user" ? HOME() : path.join(cwd, ".claude"), KINDS[kind]);
  const p = kind === "skill" ? path.join(base, name, "SKILL.md") : path.join(base, `${name}.md`);
  if (exists(kind === "skill" ? path.dirname(p) : p)) throw err(409, `${name} already exists`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, TEMPLATES[kind](name));
  return { path: p };
}

// Chỉ chấp nhận file nằm trong thư mục cấu hình của user / dự án / memory; plugin thì không (quản lý qua CLI).
function trash({ cwd: cwdIn, path: target }) {
  const cwd = local(cwdIn);
  const p = path.resolve(String(target || ""));
  const bases = [];
  for (const { dir } of roots(cwd)) for (const sub of Object.values(KINDS)) bases.push(path.join(dir, sub));
  if (cwd) bases.push(path.join(HOME(), "projects", projectKey(cwd), "memory"));
  const base = bases.find((b) => p.startsWith(b + path.sep));
  if (!base) throw err(400, "Only skills, agents, commands, rules, output styles and memory files can be removed here");
  // Skill là cả thư mục chứa SKILL.md
  const victim = base.endsWith(`${path.sep}skills`) ? path.join(base, path.relative(base, p).split(path.sep)[0]) : p;
  let st;
  try {
    st = fs.lstatSync(victim);
  } catch {
    throw err(404, "Not found");
  }
  if (st.isSymbolicLink()) {
    fs.unlinkSync(victim); // chỉ gỡ liên kết, không đụng thư mục gốc
    return { removed: victim };
  }
  const dest = path.join(HOME(), "backups", "dash-trash", `${new Date().toISOString().replace(/[:.]/g, "-")}-${path.basename(victim)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(victim, dest, { recursive: true });
  fs.rmSync(victim, { recursive: true, force: true });
  return { removed: victim, backup: dest };
}

// ---------- Lịch sử chat (mọi thư mục) ----------
const inScope = (dir, cwd, scope) => scope === "all" || !cwd || dir === cwd || (scope === "tree" && dir?.startsWith(cwd.endsWith("/") ? cwd : cwd + "/"));

async function sessions({ cwd = "", scope = "all" } = {}) {
  const { listSessions } = await loadSdk();
  const items = await listSessions().catch(() => []);
  return items
    .filter((x) => inScope(x.cwd, cwd, scope))
    .sort((a, b) => b.lastModified - a.lastModified)
    .map((x) => ({ sessionId: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || x.sessionId, firstPrompt: x.firstPrompt || "", cwd: x.cwd || "", gitBranch: x.gitBranch || "", tag: x.tag || "", lastModified: x.lastModified, createdAt: x.createdAt, fileSize: x.fileSize }));
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s);
function blockText(b) {
  if (typeof b === "string") return { kind: "text", text: b };
  if (b.type === "text") return { kind: "text", text: b.text || "" };
  if (b.type === "tool_use") {
    const i = b.input || {};
    return { kind: "tool", name: b.name, hint: String(i.description || i.command || i.file_path || i.pattern || i.url || i.prompt || "").split("\n")[0].slice(0, 140), text: clip(JSON.stringify(i, null, 1), 3000) };
  }
  if (b.type === "tool_result") {
    const c = Array.isArray(b.content) ? b.content.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n") : String(b.content ?? "");
    return { kind: "result", text: clip(c, 3000), error: !!b.is_error };
  }
  if (b.type === "image") return { kind: "text", text: "[image]" };
  return null; // thinking, redacted…
}

async function messages(sessionId, cwd) {
  const { getSessionMessages } = await loadSdk();
  const msgs = await getSessionMessages(sessionId, cwd ? { dir: cwd } : {});
  // Kết quả công cụ (message "user" không có chữ) và các bước liên tiếp của Claude gộp thành một lượt của Claude.
  const out = [];
  for (const m of msgs) {
    if (m.type !== "user" && m.type !== "assistant") continue;
    const c = m.message?.content;
    const blocks = (Array.isArray(c) ? c : [c]).filter((x) => x != null).map(blockText).filter((b) => b && (b.text || b.kind !== "text"));
    if (!blocks.length) continue;
    const role = m.type === "user" && blocks.every((b) => b.kind === "result") ? "assistant" : m.type;
    const last = out[out.length - 1];
    if (role === "assistant" && last?.role === "assistant") last.blocks.push(...blocks);
    else out.push({ role, at: m.timestamp || "", blocks });
  }
  return out;
}

async function rename(sessionId, cwd, title) {
  const { renameSession } = await loadSdk();
  await renameSession(sessionId, String(title || "").trim(), cwd ? { dir: cwd } : {});
  return { ok: true };
}

async function remove(sessionId, cwd, activeIds = []) {
  if (activeIds.includes(sessionId)) throw err(409, "This conversation is open in Dash. Close it first.");
  const { deleteSession } = await loadSdk();
  await deleteSession(sessionId, cwd ? { dir: cwd } : {});
  return { ok: true };
}

// Prompt đã gõ trong Claude Code CLI (~/.claude/history.jsonl), theo thư mục.
function prompts({ cwd: cwdIn = "", scope = "folder", limit = 500 } = {}) {
  const cwd = local(cwdIn);
  let text = "";
  try {
    text = fs.readFileSync(path.join(HOME(), "history.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    try {
      const j = JSON.parse(lines[i]);
      if (!j.display || !inScope(j.project, cwd, scope)) continue;
      const pasted = Object.values(j.pastedContents || {}).map((x) => x.content).filter(Boolean);
      out.push({ text: j.display, pasted, project: j.project || "", at: j.timestamp || 0, sessionId: j.sessionId || "" });
    } catch {}
  }
  return out;
}

module.exports = {
  setBinary: (fn) => (binary = fn),
  inventory,
  sessions,
  messages,
  rename,
  remove,
  prompts,
  create,
  trash,
  setSetting,
  mcpSave,
  mcpRemove,
  plugins,
  pluginAction,
};
