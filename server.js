#!/usr/bin/env node
// Dash: workspace local (dự án, terminal, git, Claude, database). Cài: npm install. Chạy: node server.js
// (mặc định http://127.0.0.1:8899). Dữ liệu thời gian thực (terminal, Claude) đi qua WebSocket /ws.
const http = require("http");
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
const git = require("./src/git");
const sshProfiles = require("./src/ssh-profiles");
const claude = require("./src/claude");
const db = require("./src/db");
const dbBackup = require("./src/db/backup");
const remote = require("./src/remote");
const sshForward = require("./src/ssh-forward");
const localAi = require("./src/local-ai");
const claudeUpdate = require("./src/claude-update");
const codeTools = require("./src/code-tools");
const cryptoPrices = require("./src/crypto-prices");
const { WebSocketServer } = require("ws");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
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
  if (remote.isRemote(project.path)) return { remote: true, exists: await remote.exists(project.path), git: null, env: { exists: false }, manifests: [] };
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
route("GET", "/api/files/raw", async (req, p, url, res) => {
  const file = url.searchParams.get("path");
  const buf = await files.raw(file);
  const ext = path.extname(file).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": buf.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  // File của người dùng không được chạy script trong origin của Dash (trừ PDF: trình xem PDF không chạy trong sandbox)
  if (ext !== ".pdf") headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'";
  res.writeHead(200, headers);
  res.end(buf);
});
route("GET", "/api/files/tree", (req, p, url) => files.tree(url.searchParams.get("path")));
route("GET", "/api/files/index", (req, p, url) => files.index(url.searchParams.get("root")));
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

// ---------- HTTP ----------

// Chặn DNS rebinding (Host lạ) và request chéo trang (thiếu header X-Dash ở request ghi).
function guard(req) {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  const allowed = ["127.0.0.1", "localhost", "[::1]", store.load().settings.host];
  if (!allowed.includes(host)) throw httpError(403, "Host not allowed");
  if (req.method !== "GET" && req.headers["x-dash"] !== "1") throw httpError(403, "Missing X-Dash header");
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
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": base === PUBLIC_DIR && !pathname.startsWith("/icons/") ? "no-cache" : "max-age=604800" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    guard(req);
    if (url.pathname === "/api/logs/stream") {
      const key = url.searchParams.get("key");
      if (!runner.validKey(key)) throw httpError(400, "Invalid log key");
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
});

// ---------- WebSocket: terminal + Claude ----------
// Trình duyệt không gửi header tuỳ ý khi mở WebSocket, nên ngoài kiểm tra Host còn đòi Origin cùng máy.
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  try {
    guard({ method: "GET", headers: req.headers });
    const origin = req.headers.origin ? new URL(req.headers.origin) : null;
    if (!origin || origin.host !== req.headers.host) throw httpError(403, "Bad origin");
    if (new URL(req.url, "http://x").pathname !== "/ws") throw httpError(404, "Not found");
  } catch {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
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
const listenHost = process.env.HOST || host;

runner.loadState();
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const check = process.platform === "linux" ? `ss -ltnp | grep :${listenPort}` : `lsof -nP -iTCP:${listenPort} -sTCP:LISTEN`;
    console.error(`Port ${listenPort} is in use. Check: ${check}  (Dash may already be running)`);
    process.exit(1);
  }
  throw err;
});
server.listen(listenPort, listenHost, () => {
  console.log(`Dash: http://${listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost}:${listenPort}  ·  config: ${store.CONFIG_PATH}`);
  if (!process.env.DASH_NO_AUTOSTART) runner.autostart();
  claudeUpdate.schedule(claude.claudeBinary);
});

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log("Stopping foreground commands…");
    server.close();
    terminals.killAll();
    sshForward.stopAll();
    await runner.shutdown();
    process.exit(0);
  });
}
