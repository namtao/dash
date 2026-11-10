#!/usr/bin/env node
// Dash: workspace local (dự án, terminal, git, Claude, database). Cài: npm install. Chạy: node server.js
// (mặc định http://127.0.0.1:8899). Dữ liệu thời gian thực (terminal, Claude) đi qua WebSocket /ws.
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const store = require("./src/store");
const runner = require("./src/process-runner");
const pyenv = require("./src/python-env");
const packages = require("./src/package-manager");
const detector = require("./src/project-detect");
const system = require("./src/system-tools");
const terminals = require("./src/terminals");
const history = require("./src/history");
const files = require("./src/files");
const search = require("./src/search");
const git = require("./src/git");
const sshProfiles = require("./src/ssh-profiles");
const claude = require("./src/claude");
const db = require("./src/db");
const dbBackup = require("./src/db/backup");
const remote = require("./src/remote");
const sshForward = require("./src/ssh-forward");
const localAi = require("./src/local-ai");
const claudeUpdate = require("./src/claude-update");
const claudeManager = require("./src/claude-manager");
const codeTools = require("./src/code-tools");
const cryptoPrices = require("./src/crypto-prices");
const auth = require("./src/auth");
const peerGuard = require("./src/peer-guard");
const tailscale = require("./src/tailscale");
const { WebSocketServer } = require("ws");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".csv": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};
// Thư viện giao diện phục vụ thẳng từ node_modules (chỉ những thư mục này)
const VENDOR = {
  monaco: path.join(__dirname, "node_modules/monaco-editor/min"),
  xterm: path.join(__dirname, "node_modules/@xterm/xterm"),
  "xterm-fit": path.join(__dirname, "node_modules/@xterm/addon-fit/lib"),
  "xterm-links": path.join(__dirname, "node_modules/@xterm/addon-web-links/lib"),
  "xterm-search": path.join(__dirname, "node_modules/@xterm/addon-search/lib"),
  "xterm-unicode": path.join(__dirname, "node_modules/@xterm/addon-unicode11/lib"),
  "xterm-webgl": path.join(__dirname, "node_modules/@xterm/addon-webgl/lib"),
  "sql-formatter": path.join(__dirname, "node_modules/sql-formatter/dist"),
  marked: path.join(__dirname, "node_modules/marked/lib"),
  dompurify: path.join(__dirname, "node_modules/dompurify/dist"),
  mammoth: path.join(__dirname, "node_modules/mammoth"),
  exceljs: path.join(__dirname, "node_modules/exceljs/dist"),
  prettier: path.join(__dirname, "node_modules/prettier"),
};

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, handler });
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw httpError(413, "Payload too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

// Tác vụ dự án (env, thư viện, lệnh nhanh) chạy nền; hàm after (nếu có) chạy khi thành công.
async function startTask(projectId, label, spec, after) {
  const run = await runner.startTask(projectId, label, spec);
  if (after) {
    run.done.then((code) => {
      if (code !== 0) return;
      try {
        fs.appendFileSync(run.logFile, `✓ ${after()}\n`);
      } catch (e) {
        fs.appendFileSync(run.logFile, `!!! ${e.message}\n`);
      }
    });
  }
  return { started: true, key: run.key };
}

// ---------- Cấu hình ----------
route("GET", "/api/config", () => store.publicConfig());
route("PUT", "/api/config", async (req) => {
  store.replaceAll(await readBody(req));
  return store.publicConfig();
});
route("PUT", "/api/workspace", async (req) => store.updateSection("workspace", { ...store.load().workspace, ...(await readBody(req)) }));
route("PUT", "/api/settings", async (req) => store.updateSettings(await readBody(req)));
// Xuất toàn bộ cấu hình (không kèm mật khẩu / khoá API) thành file JSON tải về; không lưu hay gửi đi đâu
route("GET", "/api/export", (req, p, url, res) => {
  const name = `dash-config-${new Date().toISOString().slice(0, 10)}.json`;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
  res.end(JSON.stringify(store.exportConfig(), null, 2) + "\n");
});
route("POST", "/api/import", async (req) => {
  const b = await readBody(req);
  return store.importConfig(b.data, b.mode === "replace" ? "replace" : "merge");
});
route("GET", "/api/system", () => ({ ...system.systemInfo(), configPath: store.CONFIG_PATH, listening: { host: listenHost, port: listenPort } }));

// ---------- Dự án ----------
route("POST", "/api/projects", async (req) => store.upsertProject(await readBody(req)));
route("PUT", "/api/projects/:id", async (req, { id }) => {
  store.getProject(id);
  return store.upsertProject(await readBody(req), id);
});
route("DELETE", "/api/projects/:id", async (req, { id }) => {
  const project = store.getProject(id);
  const running = project.commands.filter((c) => runner.isRunning(runner.keyOf(id, c.id)));
  if (running.length) throw httpError(409, `Stop the running commands first: ${running.map((c) => c.name).join(", ")}`);
  store.deleteProject(id);
  runner.forgetProject(id);
  return { ok: true };
});

route("GET", "/api/status", async () => {
  const [runs, ports] = await Promise.all([runner.snapshot(), system.listeningPorts()]);
  return { runs, ports: ports.map((p) => p.port), at: Date.now() };
});

route("GET", "/api/projects/:id/info", async (req, { id }) => {
  const project = store.getProject(id);
  if (remote.isRemote(project.path)) {
    const exists = await remote.exists(project.path);
    return { remote: true, exists, git: exists ? await git.summary(project.path).catch(() => null) : null, env: { exists: false }, manifests: [] };
  }
  const [git, env] = await Promise.all([system.gitInfo(project.path), pyenv.status(project)]);
  return { exists: fs.existsSync(project.path), git, env, manifests: packages.manifests(project) };
});

// ---------- Lệnh ----------
for (const action of ["start", "stop", "restart"]) {
  route("POST", `/api/projects/:id/commands/:cmd/${action}`, async (req, { id, cmd }) => {
    const fn = { start: runner.startCommand, stop: runner.stopCommand, restart: runner.restartCommand }[action];
    await fn(id, cmd);
    return { ok: true };
  });
}

route("POST", "/api/projects/:id/shell", async (req, { id }) => {
  const { cmd, cwd } = await readBody(req);
  if (!String(cmd || "").trim()) throw httpError(400, "Command is empty");
  return startTask(id, `$ ${cmd}`, { cmd: String(cmd), cwd: String(cwd || ""), pty: true });
});
route("POST", "/api/projects/:id/task/stop", async (req, { id }) => {
  await runner.stopTask(id);
  return { ok: true };
});

// ---------- Môi trường ảo ----------
route("POST", "/api/projects/:id/env/:action", async (req, { id, action }) => {
  const project = store.getProject(id);
  const settings = store.load().settings;
  let result;
  if (action === "create") result = await startTask(id, "Create env", { argv: pyenv.createArgv(project, settings) });
  else if (action === "remove") result = await startTask(id, "Delete env", { argv: pyenv.removeArgv(project) });
  else throw httpError(404, "Not supported");
  runner.waitFor(result.key).then(pyenv.invalidateConda);
  return result;
});
route("GET", "/api/conda-envs", async () => pyenv.condaEnvs(true));
// Env có thể chọn cho dự án (venv trong thư mục dự án + env conda) và env đang chọn
route("GET", "/api/projects/:id/python-envs", async (req, { id }) => {
  const project = store.getProject(id);
  if (remote.isRemote(project.path)) return { remote: true, env: project.env, status: { exists: false }, venvs: [], conda: [] };
  const [status, conda] = await Promise.all([pyenv.status(project), pyenv.condaEnvs()]);
  return { env: project.env, status, venvs: pyenv.scanVenvs(project.path), conda };
});

// ---------- Thư viện ----------
route("GET", "/api/projects/:id/packages", async (req, { id }, url) => packages.list(store.getProject(id), url.searchParams.get("manifest")));
route("GET", "/api/projects/:id/packages/outdated", async (req, { id }, url) => packages.outdated(store.getProject(id), url.searchParams.get("manifest")));
route("POST", "/api/projects/:id/packages", async (req, { id }) => {
  const body = await readBody(req);
  const action = await packages.buildAction(store.getProject(id), body);
  return startTask(id, action.label, { argv: action.argv, cwd: action.cwd }, action.after);
});
route("GET", "/api/search", async (req, params, url) => packages.search(url.searchParams.get("registry"), url.searchParams.get("q")));

// ---------- Phát hiện / quét ----------
route("POST", "/api/detect", async (req) => detector.detect((await readBody(req)).path || ""));
route("GET", "/api/scan", async (req, params, url) => {
  const root = url.searchParams.get("root") || store.load().settings.projectsRoot;
  const known = new Set(store.load().projects.map((p) => p.path));
  return detector.scan(path.resolve(root), known);
});

// ---------- Hệ thống ----------
route("GET", "/api/ports", async () => {
  const ports = await system.listeningPorts();
  return ports.map((p) => ({ ...p, ...(p.pid ? system.processInfo(p.pid) : {}), self: p.pid === process.pid }));
});
route("POST", "/api/kill", async (req) => {
  const { pid, force } = await readBody(req);
  system.killPid(pid, force);
  return { ok: true };
});
route("POST", "/api/open", async (req) => {
  const { project: id, what, url } = await readBody(req);
  if (what === "url") await system.openUrl(url);
  else await system.open(what, store.getProject(id).path);
  return { ok: true };
});
route("POST", "/api/stop-all", async () => {
  await runner.stopAll();
  return { ok: true };
});

// ---------- Terminal ----------
route("GET", "/api/terminals", (req, p, url) => terminals.list(url.searchParams.get("ws") || ""));
route("POST", "/api/terminals", async (req) => {
  const body = await readBody(req);
  if (body.ssh) {
    const p = store.load().ssh.find((x) => x.id === body.ssh);
    if (!p) throw httpError(404, "SSH profile not found");
    return terminals.create({ ...body, cwd: undefined, argv: sshProfiles.argv(p), title: p.label, sshId: p.id });
  }
  // Thư mục trên máy SSH: mở ssh và cd tới thư mục đó
  if (remote.isRemote(body.cwd)) {
    const { profile, dir } = remote.parse(body.cwd);
    return terminals.create({ ...body, cwd: undefined, argv: sshProfiles.argv(profile, dir), title: profile.label, sshId: profile.id });
  }
  return terminals.create(body);
});
route("PUT", "/api/terminals/:id", async (req, { id }) => {
  terminals.rename(id, (await readBody(req)).title);
  return { ok: true };
});
route("DELETE", "/api/terminals/:id", (req, { id }) => {
  terminals.kill(id);
  return { ok: true };
});

// ---------- Lịch sử lệnh ----------
route("GET", "/api/history", (req, params, url) =>
  history.query({
    cwd: url.searchParams.get("cwd") || "",
    scope: url.searchParams.get("scope") || "tree",
    q: url.searchParams.get("q") || "",
    unique: url.searchParams.get("unique") !== "0",
    limit: Math.min(2000, Number(url.searchParams.get("limit")) || 300),
  })
);
route("GET", "/api/history/folders", () => history.folders());
route("DELETE", "/api/history", async (req) => {
  const { cmd, cwd } = await readBody(req);
  return { removed: history.remove(cmd, cwd) };
});

// ---------- File ----------
route("GET", "/api/files/list", (req, p, url) => files.list(url.searchParams.get("path"), { showHidden: url.searchParams.get("hidden") !== "0" }));
route("GET", "/api/files/read", (req, p, url) => files.read(url.searchParams.get("path")));
async function sendRaw(res, file, csp) {
  const buf = await files.raw(file);
  const ext = path.extname(file).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": buf.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (csp) headers["Content-Security-Policy"] = csp;
  res.writeHead(200, headers);
  res.end(buf);
}
route("GET", "/api/files/raw", async (req, p, url, res) => {
  const file = url.searchParams.get("path");
  // File của người dùng không được chạy script trong origin của Dash (trừ PDF: trình xem PDF không chạy trong sandbox)
  await sendRaw(res, file, path.extname(file).toLowerCase() === ".pdf" ? "" : "sandbox; default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'");
});
// Xem trước trang HTML: đường dẫn nằm trong URL (không phải query) để CSS / JS / ảnh / link tương đối của trang tự trỏ
// đúng file. /api/files/view/local/<abs> hoặc /api/files/view/ssh/<profile id>/<abs>. Trang chạy trong sandbox không có
// allow-same-origin (origin rỗng) nên script của nó không chạm được vào Dash; không gửi CORS để origin rỗng không đọc được file.
route("GET", "/api/files/view/.+", async (req, p, url, res) => {
  const m = url.pathname.match(/^\/api\/files\/view\/(?:local|ssh\/([^/]+))(\/.*)$/);
  if (!m) throw httpError(404, "Not found");
  const rest = decodeURIComponent(m[2]);
  await sendRaw(res, m[1] ? `ssh://${decodeURIComponent(m[1])}${rest}` : rest, "sandbox allow-scripts allow-forms allow-popups");
});
route("GET", "/api/files/tree", (req, p, url) => files.tree(url.searchParams.get("path")));
route("GET", "/api/files/index", (req, p, url) => files.index(url.searchParams.get("root")));
// Tìm trong thư mục (POST vì có nhiều tuỳ chọn); trình duyệt huỷ yêu cầu thì dừng luôn công cụ đang chạy
route("POST", "/api/files/search", async (req, p, url, res) => {
  const b = await readBody(req);
  return search.search(b.root, b, res);
});
route("POST", "/api/files/replace", async (req) => {
  const b = await readBody(req);
  return search.replace(b.root, b);
});
route("PUT", "/api/files/write", async (req) => {
  const b = await readBody(req);
  return files.write(b.path, b.content, { mtime: b.mtime, force: b.force });
});
route("POST", "/api/files/create", async (req) => {
  const b = await readBody(req);
  return files.create(b.path, b.dir);
});
route("POST", "/api/files/rename", async (req) => {
  const b = await readBody(req);
  return files.rename(b.from, b.to);
});
route("POST", "/api/files/delete", async (req) => files.remove((await readBody(req)).path));
route("GET", "/api/files/home", () => ({ home: require("os").homedir(), projectsRoot: store.load().settings.projectsRoot }));

// ---------- Git ----------
route("GET", "/api/git/status", (req, p, url) => git.status(url.searchParams.get("dir")));
route("GET", "/api/git/diff", (req, p, url) => git.diffPair(url.searchParams.get("dir"), url.searchParams.get("path"), url.searchParams.get("mode") || "working", url.searchParams.get("commit") || ""));
route("GET", "/api/git/log", (req, p, url) => git.log(url.searchParams.get("dir"), url.searchParams.get("limit")));
route("GET", "/api/git/commit", (req, p, url) => git.commitFiles(url.searchParams.get("dir"), url.searchParams.get("hash")));
route("GET", "/api/git/branches", (req, p, url) => git.branches(url.searchParams.get("dir")));
route("POST", "/api/git/:action", async (req, { action }) => {
  const b = await readBody(req);
  if (action === "stage") return git.stage(b.dir, b.paths);
  if (action === "unstage") return git.unstage(b.dir, b.paths);
  if (action === "discard") return git.discard(b.dir, b.paths);
  if (action === "commit") return git.commit(b.dir, b.message, { amend: b.amend, all: b.all });
  if (action === "checkout") return git.checkout(b.dir, b.branch, b.create);
  if (["pull", "push", "fetch"].includes(action)) return git.sync(b.dir, action);
  throw httpError(404, "Unknown git action");
});

// ---------- SSH ----------
route("PUT", "/api/ssh", async (req) => store.updateSection("ssh", (await readBody(req)).profiles));
route("GET", "/api/ssh/forwards", () => sshForward.list());
route("POST", "/api/ssh/:id/forwards", async (req, { id }) => sshForward.start(id, await readBody(req)));
route("DELETE", "/api/ssh/forwards/:fid", (req, { fid }) => {
  sshForward.stop(fid);
  return { ok: true };
});

// ---------- Câu lệnh hay dùng ----------
route("PUT", "/api/snippets", async (req) => store.updateSection("snippets", (await readBody(req)).snippets));
// Giá coin ở thanh trạng thái; PUT đổi sàn / thị trường / danh sách coin rồi trả về giá mới
route("GET", "/api/crypto", (req, p, url) => cryptoPrices.prices(url.searchParams.get("force") === "1"));
route("PUT", "/api/crypto", async (req) => {
  store.updateSection("crypto", { ...store.load().crypto, ...(await readBody(req)) });
  return cryptoPrices.prices();
});

// ---------- AI local ----------
route("PUT", "/api/ai", async (req) => {
  store.updateSection("ai", { ...store.load().ai, ...(await readBody(req)) });
  return store.publicConfig().ai;
});
route("GET", "/api/ai/models", () => localAi.models());
route("POST", "/api/ai/chat", async (req, p, url, res) => localAi.chatStream((await readBody(req)).messages || [], req, res));
route("POST", "/api/ai/commit", async (req) => {
  const { diff, staged } = await git.diffForMessage((await readBody(req)).dir);
  return { message: await localAi.commitMessage(diff), staged };
});

// ---------- Format / báo lỗi ----------
route("POST", "/api/code/format", async (req) => {
  const b = await readBody(req);
  return codeTools.format(String(b.lang || ""), String(b.content ?? ""), String(b.path || ""));
});
route("POST", "/api/code/lint", async (req) => {
  const b = await readBody(req);
  return codeTools.lint(String(b.lang || ""), String(b.content ?? ""), String(b.path || ""));
});

// ---------- Claude ----------
route("GET", "/api/claude/usage", (req, p, url) => claude.usage(url.searchParams.get("force") === "1"));
route("GET", "/api/claude/sessions", (req, p, url) => claude.list(url.searchParams.get("ws") || ""));
route("GET", "/api/claude/history", (req, p, url) => claude.history(url.searchParams.get("cwd") || require("os").homedir()));
route("GET", "/api/claude/models", () => claude.models());
route("GET", "/api/claude/version", () => claudeUpdate.status());
route("POST", "/api/claude/update", () => claudeUpdate.update());
route("POST", "/api/claude/sessions", async (req) => claude.start(await readBody(req)));
route("GET", "/api/claude/sessions/:id", (req, { id }) => claude.transcript(id));
route("POST", "/api/claude/sessions/:id/send", async (req, { id }) => {
  claude.send(id, (await readBody(req)).content);
  return { ok: true };
});
route("POST", "/api/claude/sessions/:id/answer", async (req, { id }) => {
  const b = await readBody(req);
  claude.answer(id, b.requestId, b);
  return { ok: true };
});
route("POST", "/api/claude/sessions/:id/interrupt", async (req, { id }) => {
  await claude.interrupt(id);
  return { ok: true };
});
route("PUT", "/api/claude/sessions/:id", async (req, { id }) => claude.configure(id, await readBody(req)));

// ---------- Quản lý Claude Code (lịch sử mọi thư mục, skills, hooks, MCP, plugin…) ----------
const q = (url, k) => url.searchParams.get(k) || "";
route("GET", "/api/claude/manage/sessions", (req, p, url) => claudeManager.sessions({ cwd: q(url, "cwd"), scope: q(url, "scope") || "all" }));
route("GET", "/api/claude/manage/sessions/:sid", (req, { sid }, url) => claudeManager.messages(sid, q(url, "cwd")));
route("PUT", "/api/claude/manage/sessions/:sid", async (req, { sid }) => {
  const b = await readBody(req);
  return claudeManager.rename(sid, b.cwd, b.title);
});
route("DELETE", "/api/claude/manage/sessions/:sid", (req, { sid }, url) => claudeManager.remove(sid, q(url, "cwd"), claude.list().map((s) => s.sessionId).filter(Boolean)));
route("GET", "/api/claude/manage/prompts", (req, p, url) => claudeManager.prompts({ cwd: q(url, "cwd"), scope: q(url, "scope") || "folder" }));
route("GET", "/api/claude/manage/config", (req, p, url) => claudeManager.inventory(q(url, "cwd")));
route("POST", "/api/claude/manage/item", async (req) => claudeManager.create(await readBody(req)));
route("POST", "/api/claude/manage/trash", async (req) => claudeManager.trash(await readBody(req)));
route("PUT", "/api/claude/manage/setting", async (req) => claudeManager.setSetting(await readBody(req)));
route("PUT", "/api/claude/manage/mcp", async (req) => claudeManager.mcpSave(await readBody(req)));
route("POST", "/api/claude/manage/mcp/remove", async (req) => claudeManager.mcpRemove(await readBody(req)));
route("GET", "/api/claude/manage/plugins", (req, p, url) => claudeManager.plugins({ cwd: q(url, "cwd"), available: q(url, "available") === "1" }));
route("POST", "/api/claude/manage/plugins", async (req) => claudeManager.pluginAction(await readBody(req)));
route("DELETE", "/api/claude/sessions/:id", (req, { id }) => {
  claude.close(id);
  return { ok: true };
});

// ---------- Database ----------
route("PUT", "/api/databases", async (req) => {
  const list = (await readBody(req)).connections;
  store.updateSection("databases", list);
  for (const c of store.load().databases) db.drop(c.id);
  return store.publicConfig().databases;
});
route("POST", "/api/databases/test", async (req) => {
  const b = await readBody(req);
  const old = store.load().databases.find((d) => d.id === b.id);
  return db.test({ ...b, password: b.password || old?.password || "", port: Number(b.port) || undefined });
});
route("POST", "/api/databases/:id/disconnect", (req, { id }) => {
  db.drop(id);
  return { ok: true };
});
route("GET", "/api/databases/:id/databases", (req, { id }) => db.databases(id));
route("GET", "/api/databases/:id/schema", (req, { id }, url) => db.schema(id, url.searchParams.get("db") || "", url.searchParams.get("force") === "1"));
route("POST", "/api/databases/:id/query", async (req, { id }) => {
  const b = await readBody(req);
  return db.run(id, b.db || "", String(b.sql || ""));
});
route("POST", "/api/databases/:id/save", async (req, { id }) => {
  const b = await readBody(req);
  return db.save(id, b.db || "", b.changes || {});
});
for (const action of ["backup", "restore"]) route("POST", `/api/databases/:id/${action}`, async (req, { id }) => dbBackup.start(id, action, await readBody(req)));
route("GET", "/api/backups", () => dbBackup.listBackups());
route("POST", "/api/jobs/stop", async (req) => {
  const { key } = await readBody(req);
  if (!runner.validKey(key)) throw httpError(400, "Invalid key");
  await runner.stopKey(key);
  return { ok: true };
});

// ---------- Log ----------
route("DELETE", "/api/logs", async (req, params, url) => {
  const key = url.searchParams.get("key");
  if (!runner.validKey(key)) throw httpError(400, "Invalid log key");
  runner.clearLog(key);
  return { ok: true };
});

// ---------- Đăng nhập từ xa ----------
route("GET", "/api/auth/state", (req) => auth.state(req));
route("POST", "/api/auth/login", async (req, params, url, res) => auth.login(req, res, await readBody(req)));
route("POST", "/api/auth/logout", (req, params, url, res) => auth.logout(req, res, req.who));
route("GET", "/api/auth/devices", (req) => auth.devices(req.who));
// Xoá thiết bị và đổi mật khẩu chỉ làm được ở máy này (127.0.0.1); thiết bị từ xa chỉ tự đăng xuất chính nó
route("DELETE", "/api/auth/devices/:id", (req, { id }) => (localOnly(req), { removed: auth.revoke((s) => s.id === id) }));
// Đăng xuất mọi thiết bị khác (trên máy này: tất cả)
// Đăng xuất mọi thiết bị khác (thiết bị từ xa vẫn giữ chỗ)
route("DELETE", "/api/auth/devices", (req) => (localOnly(req), { signedOut: auth.endSessions((s) => s.id !== req.who.id, "signed out from this machine") }));
route("POST", "/api/auth/active", (req) => auth.touchActive(req.who));
route("PUT", "/api/auth/password", async (req) => (localOnly(req), auth.setPassword(req.who, await readBody(req))));
// Bật / tắt nghe trên IP Tailscale: phiên đã đăng nhập và ngồi tại máy này (tắt từ xa là tự cắt kết nối của mình)
const localOnly = (req) => {
  if (!auth.isLocal(req)) throw httpError(403, "Only on the Dash machine");
};
const tsState = async () => ({ ...(await tailscale.status()), on: auth.tailscaleOn(), listening: tsListen.addr });
route("GET", "/api/tailscale", tsState);
route("POST", "/api/tailscale", async (req) => {
  localOnly(req);
  auth.setTailscale(true);
  await syncTailscale();
  if (!tsListen.addr) throw httpError(400, tsListen.error || "Tailscale is not running, so it has no address yet");
  return tsState();
});
route("DELETE", "/api/tailscale", async (req) => {
  localOnly(req);
  auth.setTailscale(false);
  await syncTailscale();
  return tsState();
});

// ---------- HTTP ----------

// Chặn DNS rebinding (Host lạ) và request chéo trang (thiếu header X-Dash ở request ghi).
function guard(req) {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  const allowed = ["127.0.0.1", "localhost", "[::1]", store.load().settings.host, tsListen.addr];
  if (!allowed.includes(host)) throw httpError(403, "Host not allowed");
  if (req.method !== "GET" && req.headers["x-dash"] !== "1") throw httpError(403, "Missing X-Dash header");
}

// Mở từ xa mà chưa đăng nhập: chỉ được vào trang đăng nhập; trang khác chuyển về /login.html, API trả 401.
const PUBLIC_PATHS = new Set(["/login.html", "/icon.svg", "/manifest.webmanifest", "/api/auth/state", "/api/auth/login"]);
function authorize(req, res, url) {
  req.who = auth.identify(req);
  if (req.who || PUBLIC_PATHS.has(url.pathname)) return true;
  if (url.pathname.startsWith("/api/")) throw httpError(401, "Sign in required");
  res.writeHead(302, { Location: `/login.html?next=${encodeURIComponent(url.pathname + url.search)}`, "Cache-Control": "no-store" });
  res.end();
  return false;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function serveStatic(res, pathname) {
  let base = PUBLIC_DIR;
  // "/" là khung chứa tab dự án; mỗi tab nạp workbench index.html?w=<dự án>
  let rel = pathname === "/" ? "shell.html" : pathname;
  const vm = pathname.match(/^\/vendor\/([\w-]+)\/(.+)$/);
  if (vm && VENDOR[vm[1]]) {
    base = VENDOR[vm[1]];
    rel = vm[2];
  }
  const file = path.normalize(path.join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  // Không cho trang khác nhúng Dash vào iframe (clickjacking: bấm hộ vào terminal / nút chạy lệnh)
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": base === PUBLIC_DIR && !pathname.startsWith("/icons/") ? "no-cache" : "max-age=604800",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "frame-ancestors 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  });
  fs.createReadStream(file).pipe(res);
}

const streams = new Set(); // luồng SSE log đang mở
const handleRequest = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    guard(req);
    if (!authorize(req, res, url)) return;
    if (url.pathname === "/api/logs/stream") {
      const key = url.searchParams.get("key");
      if (!runner.validKey(key)) throw httpError(400, "Invalid log key");
      // Nhớ luồng log theo phiên để đóng khi thiết bị đăng xuất / bị xoá
      streams.add(res);
      res.sessionId = req.who.id;
      res.on("close", () => streams.delete(res));
      return runner.streamLog(key, req, res);
    }
    if (url.pathname === "/api/logs/download") {
      const key = url.searchParams.get("key");
      if (!runner.validKey(key) || !fs.existsSync(runner.logPath(key))) throw httpError(404, "No log yet");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${key.replace("/", "_")}.log"` });
      return fs.createReadStream(runner.logPath(key)).pipe(res);
    }
    if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler(req, params, url, res);
      // handler tự ghi response (tải file, stream) thì không gửi JSON nữa
      if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
      return;
    }
    throw httpError(404, "Unknown API");
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
  }
};
const server = http.createServer(handleRequest);

// ---------- WebSocket: terminal + Claude ----------
// Trình duyệt không gửi header tuỳ ý khi mở WebSocket, nên ngoài kiểm tra Host còn đòi Origin cùng máy.
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
function handleUpgrade(req, socket, head) {
  let who;
  try {
    guard({ method: "GET", headers: req.headers });
    const origin = req.headers.origin ? new URL(req.headers.origin) : null;
    if (!origin || origin.host !== req.headers.host) throw httpError(403, "Bad origin");
    if (new URL(req.url, "http://x").pathname !== "/ws") throw httpError(404, "Not found");
    who = auth.identify(req);
    if (!who) throw httpError(401, "Sign in required");
  } catch {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.sessionId = who.id;
    ws.ipServer = socket.ipServer || null;
    wss.emit("connection", ws);
  });
}
server.on("upgrade", handleUpgrade);

// Nghe thêm trên IP Tailscale (http://100.x:<cổng>) khi đã bật truy cập từ xa. Mạng Tailscale tự mã hoá (WireGuard);
// request từ IP này không phải loopback nên luôn phải đăng nhập. Tailscale chưa chạy lúc Dash khởi động thì thử lại mỗi phút.
const tsListen = { server: null, http: null, addr: "", error: "" };
// Chạy nối tiếp: bộ hẹn giờ và nút Turn on/off gọi cùng lúc thì không mở hai server trên một cổng
let tsQueue = Promise.resolve();
const syncTailscale = () => (tsQueue = tsQueue.then(syncTailscaleNow, syncTailscaleNow));
async function syncTailscaleNow() {
  const want = auth.tailscaleOn() ? await tailscale.ip() : "";
  if (tsListen.addr === want && (want ? tsListen.server : true)) return;
  if (tsListen.server) {
    const { server: old, http: oldHttp } = tsListen;
    Object.assign(tsListen, { server: null, http: null, addr: "" });
    // Cắt mọi kết nối đang mở qua IP này (WebSocket, SSE, keep-alive) trước, nếu không close() chờ mãi
    wss.clients.forEach((ws) => ws.ipServer === oldHttp && ws.terminate());
    oldHttp.closeAllConnections();
    await new Promise((r) => old.close(r));
  }
  if (!want) return;
  // Chỉ máy thuộc chính tailnet này mới vào được. Hệ điều hành nhận gói gửi tới IP 100.x từ mọi card mạng (weak host),
  // và máy tailnet khác được share vào cũng có IP 100.x, nên kiểm IP nguồn với danh sách máy của tailnet trước khi
  // giao kết nối cho HTTP (IP giả không bắt tay TCP được vì gói trả lời đi qua Tailscale).
  const httpSrv = http.createServer(handleRequest);
  httpSrv.on("upgrade", (req, socket, head) => {
    socket.ipServer = httpSrv;
    handleUpgrade(req, socket, head);
  });
  const srv = net.createServer({ pauseOnConnect: true }, async (socket) => {
    socket.on("error", () => {});
    if (!(await tailscale.isMember(socket.remoteAddress))) {
      console.warn(`[auth] ${new Date().toISOString()} refused ${socket.remoteAddress}: not a device of this tailnet`);
      return socket.destroy();
    }
    if (socket.destroyed) return;
    httpSrv.emit("connection", socket);
    socket.resume();
  });
  await new Promise((resolve) => {
    srv.once("error", (e) => {
      tsListen.error = `Cannot listen on ${want}:${listenPort}: ${e.message}`;
      console.error(tsListen.error);
      resolve();
    });
    srv.listen(listenPort, want, () => {
      Object.assign(tsListen, { server: srv, http: httpSrv, addr: want, error: "" });
      console.log(`Dash (Tailscale): http://${want}:${listenPort}`);
      resolve();
    });
  });
}
setInterval(() => syncTailscale().catch(() => {}), 60000).unref();
// Thiết bị đăng xuất / bị xoá: đóng luôn WebSocket và luồng log đang mở của nó
auth.onRevoke((ids) => {
  wss.clients.forEach((ws) => ids.has(ws.sessionId) && ws.close(4401, "Signed out"));
  streams.forEach((res) => ids.has(res.sessionId) && res.end());
});

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (msg) => wss.clients.forEach((ws) => send(ws, msg));

wss.on("connection", (ws) => {
  ws.attached = new Set();
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (m.t === "term.attach") {
        ws.attached.add(m.id);
        send(ws, { t: "term.replay", id: m.id, data: terminals.replay(m.id) });
      } else if (m.t === "term.detach") ws.attached.delete(m.id);
      else if (m.t === "term.input") terminals.write(m.id, m.data);
      else if (m.t === "term.resize") terminals.resize(m.id, m.cols, m.rows);
    } catch (e) {
      send(ws, { t: "error", message: e.message, id: m.id });
    }
  });
});

terminals.on((event, p) => {
  if (event === "data") {
    const msg = JSON.stringify({ t: "term.data", id: p.id, data: p.data });
    wss.clients.forEach((ws) => ws.attached.has(p.id) && ws.readyState === 1 && ws.send(msg));
  } else broadcast({ t: `term.${event}`, ...p });
});
claude.on((p) => broadcast({ t: "claude", ...p }));
sshForward.on((f) => broadcast({ t: "forward", ...f }));

const { host, port } = store.load().settings;
const listenPort = Number(process.env.PORT) || port;
// Cổng chính chỉ nghe loopback. Máy khác vào qua listener IP Tailscale (chỉ nhận máy trong tailnet, 1 thiết bị, tự
// đăng xuất); nghe 0.0.0.0 / IP LAN sẽ bỏ qua các lớp đó, nên không cho.
const wantHost = process.env.HOST || host;
const listenHost = ["127.0.0.1", "::1", "localhost"].includes(wantHost) ? wantHost : "127.0.0.1";
if (listenHost !== wantHost) console.warn(`Dash only listens on loopback; ignoring host ${wantHost}. Use Settings → Remote access (Tailscale) for other devices.`);

runner.loadState();
// Cổng chính nghe qua lớp net: chặn kết nối loopback từ Docker / máy ảo trước khi giao cho HTTP
const front = net.createServer({ pauseOnConnect: true }, async (socket) => {
  socket.on("error", () => {});
  if (!(await peerGuard.allowed(socket))) return socket.destroy();
  if (socket.destroyed) return;
  server.emit("connection", socket);
  socket.resume();
});
front.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const check = process.platform === "linux" ? `ss -ltnp | grep :${listenPort}` : `lsof -nP -iTCP:${listenPort} -sTCP:LISTEN`;
    console.error(`Port ${listenPort} is in use. Check: ${check}  (Dash may already be running)`);
    process.exit(1);
  }
  throw err;
});
front.listen(listenPort, listenHost, () => {
  console.log(`Dash: http://${listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost}:${listenPort}  ·  config: ${store.CONFIG_PATH}`);
  if (!process.env.DASH_NO_AUTOSTART) runner.autostart();
  claudeUpdate.schedule(claude.claudeBinary);
  claudeManager.setBinary(() => claude.claudeBinary() || "claude");
  syncTailscale().catch(() => {});
});

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log("Stopping foreground commands…");
    front.close();
    server.closeAllConnections();
    terminals.killAll();
    sshForward.stopAll();
    await runner.shutdown();
    process.exit(0);
  });
}
