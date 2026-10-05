#!/usr/bin/env node
// Dash: dashboard quản lý dự án local. Chỉ dùng module có sẵn của Node, không cần npm install.
// Chạy: node server.js  (mặc định http://127.0.0.1:8899)
const http = require("http");
const fs = require("fs");
const path = require("path");
const store = require("./src/store");
const runner = require("./src/process-runner");
const pyenv = require("./src/python-env");
const packages = require("./src/package-manager");
const detector = require("./src/project-detect");
const system = require("./src/system-tools");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

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
route("GET", "/api/config", () => store.load());
route("PUT", "/api/config", async (req) => store.replaceAll(await readBody(req)));
route("PUT", "/api/settings", async (req) => store.updateSettings(await readBody(req)));
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
  return startTask(id, `$ ${cmd}`, { cmd: String(cmd), cwd: String(cwd || "") });
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
  if (what === "url") system.openUrl(url);
  else system.open(what, store.getProject(id).path, store.load().settings);
  return { ok: true };
});
route("POST", "/api/stop-all", async () => {
  await runner.stopAll();
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
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
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
      return sendJson(res, 200, (await r.handler(req, params, url)) ?? { ok: true });
    }
    throw httpError(404, "Unknown API");
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
  }
});

const { host, port } = store.load().settings;
const listenPort = Number(process.env.PORT) || port;
const listenHost = process.env.HOST || host;

runner.loadState();
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${listenPort} is in use. Check: ss -ltnp | grep :${listenPort}  (Dash may already be running)`);
    process.exit(1);
  }
  throw err;
});
server.listen(listenPort, listenHost, () => {
  console.log(`Dash: http://${listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost}:${listenPort}  ·  config: ${store.CONFIG_PATH}`);
  runner.autostart();
});

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log("Stopping foreground commands…");
    server.close();
    await runner.shutdown();
    process.exit(0);
  });
}
