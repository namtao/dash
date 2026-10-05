// Quản lý tiến trình: mỗi lệnh chạy trong process group riêng, log ghi ra file.
// Lệnh "chạy ngầm" vẫn sống khi tắt dashboard và được nhận lại (adopt) ở lần chạy sau;
// lệnh thường bị tắt cùng dashboard. PID được đối chiếu với starttime trong /proc để tránh PID bị tái sử dụng.
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const store = require("./store");
const pyenv = require("./python-env");

const LOG_DIR = path.join(store.ROOT, "logs");
const STATE_PATH = path.join(store.ROOT, ".dash-state.json");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const TASK_ID = "_task";

const runs = new Map(); // key -> run

const keyOf = (projectId, cmdId) => `${projectId}/${cmdId}`;

function procStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return null;
  }
}

function isAlive(run) {
  return Boolean(run?.pid && run.exitedAt == null && procStartTime(run.pid) === run.startTime);
}

function saveState() {
  const data = {};
  for (const [key, r] of runs) {
    if (isAlive(r)) data[key] = { pid: r.pid, startTime: r.startTime, startedAt: r.startedAt, background: r.background, display: r.display, label: r.label };
  }
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

function loadState() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {}
  for (const [key, r] of Object.entries(data)) {
    const run = { key, ...r, adopted: true, exitedAt: null, logFile: logPath(key) };
    if (isAlive(run)) runs.set(key, run);
  }
  saveState();
}

function logPath(key) {
  const [projectId, cmdId] = key.split("/");
  return path.join(LOG_DIR, projectId, `${cmdId}.log`);
}

function appendLog(file, text) {
  try {
    fs.appendFileSync(file, text);
  } catch {}
}

function prepareLog(key) {
  const file = logPath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {}
  return file;
}

function stamp() {
  return new Date().toLocaleString("en-GB", { hour12: false });
}

// spec: { key, logKey?, label, cmd (chuỗi shell) | argv (mảng), cwd, background, onExit }
async function launch(project, spec) {
  const existing = runs.get(spec.key);
  if (isAlive(existing)) throw Object.assign(new Error("Command is already running"), { status: 409 });
  const cwd = path.resolve(project.path, spec.cwd || ".");
  if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
  const env = await pyenv.processEnv(project);
  const [file, args] = spec.argv ? [spec.argv[0], spec.argv.slice(1)] : ["/bin/bash", ["-c", spec.cmd]];
  const display = spec.argv ? spec.argv.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(" ") : spec.cmd;
  const logFile = prepareLog(spec.logKey || spec.key);
  appendLog(logFile, `\n━━━ ${stamp()} · ${cwd}\n$ ${display}\n`);

  const fd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  const run = {
    key: spec.key,
    label: spec.label,
    display,
    background: Boolean(spec.background),
    pid: child.pid,
    startTime: child.pid ? procStartTime(child.pid) : null,
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    logFile,
    child,
    restarts: existing?.restarts || [],
  };
  runs.set(spec.key, run);
  run.done = new Promise((resolve) => {
    child.on("error", (err) => {
      appendLog(logFile, `!!! Failed to start: ${err.message}\n`);
      finish(run, 127, null);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      finish(run, code, signal);
      resolve(run.exitCode);
      spec.onExit?.(run);
    });
  });
  if (run.background) child.unref();
  saveState();
  return run;
}

function finish(run, code, signal) {
  if (run.exitedAt != null) return;
  run.exitedAt = Date.now();
  run.exitCode = code ?? (signal ? 128 : null);
  run.signal = signal;
  appendLog(run.logFile, `━━━ ${stamp()} · exit ${signal ? `(signal ${signal})` : `code ${code}`}\n`);
  saveState();
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function terminate(run, timeoutMs = 10000) {
  if (!isAlive(run)) return;
  run.stopping = true;
  killGroup(run.pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (procStartTime(run.pid) !== run.startTime) break;
  }
  if (procStartTime(run.pid) === run.startTime) {
    appendLog(run.logFile, `!!! Still alive after ${timeoutMs / 1000}s, sending SIGKILL\n`);
    killGroup(run.pid, "SIGKILL");
  }
  // Tiến trình nhận lại (adopted) không có sự kiện exit: tự đánh dấu kết thúc
  if (!run.child) finish(run, null, "SIGTERM");
}

function scheduleAutoRestart(projectId, cmdId, run) {
  if (run.stopping || run.exitCode === 0) return;
  let project, cmd;
  try {
    project = store.getProject(projectId);
    cmd = store.getCommand(project, cmdId);
  } catch {
    return;
  }
  if (!cmd.autoRestart) return;
  const now = Date.now();
  run.restarts = run.restarts.filter((t) => now - t < 60000);
  if (run.restarts.length >= 5) {
    appendLog(run.logFile, "!!! Crashed 5 times in 60s, giving up auto-restart\n");
    return;
  }
  run.restarts.push(now);
  appendLog(run.logFile, "↻ Auto-restarting in 3s…\n");
  run.restartTimer = setTimeout(() => startCommand(projectId, cmdId).catch(() => {}), 3000);
}

async function startCommand(projectId, cmdId) {
  const project = store.getProject(projectId);
  const cmd = store.getCommand(project, cmdId);
  return launch(project, {
    key: keyOf(projectId, cmdId),
    label: cmd.name,
    cmd: cmd.cmd,
    cwd: cmd.cwd,
    background: cmd.background,
    onExit: (run) => scheduleAutoRestart(projectId, cmdId, run),
  });
}

async function stopCommand(projectId, cmdId) {
  const project = store.getProject(projectId);
  const cmd = store.getCommand(project, cmdId);
  const key = keyOf(projectId, cmdId);
  const run = runs.get(key);
  if (run?.restartTimer) clearTimeout(run.restartTimer);
  if (run) run.stopping = true;
  if (cmd.stopCmd) {
    const stopRun = await launch(project, { key: keyOf(projectId, `${cmdId}.stop`), logKey: key, label: `${cmd.name} (stop)`, cmd: cmd.stopCmd, cwd: cmd.cwd });
    await stopRun.done;
  }
  if (run) await terminate(run);
}

async function restartCommand(projectId, cmdId) {
  await stopCommand(projectId, cmdId);
  return startCommand(projectId, cmdId);
}

// Tác vụ phụ của dự án (tạo env, cài thư viện, lệnh nhanh): mỗi dự án chạy 1 tác vụ một lúc.
async function startTask(projectId, label, spec) {
  const project = store.getProject(projectId);
  return launch(project, { ...spec, key: keyOf(projectId, TASK_ID), label, background: false });
}

async function stopTask(projectId) {
  const run = runs.get(keyOf(projectId, TASK_ID));
  if (run) await terminate(run);
}

function psStats() {
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "pgid=,rss=,pcpu="], { timeout: 5000 }, (err, stdout) => {
      const byGroup = new Map();
      if (!err) {
        for (const line of String(stdout).split("\n")) {
          const [pgid, rss, cpu] = line.trim().split(/\s+/).map(Number);
          if (!pgid) continue;
          const g = byGroup.get(pgid) || { rss: 0, cpu: 0, procs: 0 };
          g.rss += rss || 0;
          g.cpu += cpu || 0;
          g.procs += 1;
          byGroup.set(pgid, g);
        }
      }
      resolve(byGroup);
    });
  });
}

async function snapshot() {
  const stats = await psStats();
  const out = {};
  for (const [key, r] of runs) {
    const alive = isAlive(r);
    if (!alive && r.exitedAt == null) finish(r, null, null); // tiến trình adopted đã tự thoát
    const g = alive ? stats.get(r.pid) : null;
    out[key] = {
      running: alive,
      label: r.label,
      display: r.display,
      pid: r.pid,
      background: r.background,
      adopted: Boolean(r.adopted),
      startedAt: r.startedAt,
      exitedAt: r.exitedAt,
      exitCode: r.exitCode,
      signal: r.signal || null,
      restarting: Boolean(r.restartTimer && !alive && r.restarts?.length),
      rssKB: g?.rss || 0,
      cpu: g ? Math.round(g.cpu * 10) / 10 : 0,
      procs: g?.procs || 0,
    };
  }
  return out;
}

function clearLog(key) {
  try {
    fs.truncateSync(logPath(key), 0);
  } catch {}
}

function validKey(key) {
  return /^[a-z0-9-]+\/[a-z0-9._-]+$/.test(key || "") && !key.includes("..");
}

// Server-Sent Events: gửi phần cuối log rồi theo dõi phần ghi thêm.
function streamLog(key, req, res) {
  const file = logPath(key);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let offset = 0;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const readFrom = (start, end) => {
    if (end <= start) return "";
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  };
  const tick = () => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    if (size < offset) {
      offset = 0;
      send("reset", "");
    }
    if (size > offset) {
      const start = offset === 0 ? Math.max(0, size - 128 * 1024) : offset;
      send("data", readFrom(start, Math.min(size, start + 1024 * 1024)));
      offset = Math.min(size, start + 1024 * 1024);
    }
  };
  send("reset", "");
  tick();
  const timer = setInterval(tick, 400);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(timer);
    clearInterval(ping);
  });
}

async function autostart() {
  for (const p of store.load().projects) {
    for (const c of p.commands) {
      if (c.autostart && !isAlive(runs.get(keyOf(p.id, c.id)))) {
        startCommand(p.id, c.id).catch((e) => console.error(`autostart ${p.id}/${c.id}: ${e.message}`));
      }
    }
  }
}

// Khi tắt dashboard: dừng lệnh thường (kể cả tác vụ), giữ lệnh chạy ngầm.
async function shutdown() {
  const pending = [];
  for (const r of runs.values()) {
    if (r.restartTimer) clearTimeout(r.restartTimer);
    if (!r.background && isAlive(r)) pending.push(terminate(r, 5000));
  }
  await Promise.all(pending);
  saveState();
}

async function stopAll() {
  const keys = [...runs.keys()].filter((k) => isAlive(runs.get(k)));
  await Promise.all(
    keys.map((k) => {
      const [p, c] = k.split("/");
      return c === TASK_ID || c.endsWith(".stop") ? terminate(runs.get(k)) : stopCommand(p, c).catch(() => terminate(runs.get(k)));
    })
  );
}

function forgetProject(projectId) {
  for (const key of runs.keys()) if (key.startsWith(`${projectId}/`) && !isAlive(runs.get(key))) runs.delete(key);
}

function isRunning(key) {
  return isAlive(runs.get(key));
}

function waitFor(key) {
  return runs.get(key)?.done || Promise.resolve(null);
}

module.exports = {
  TASK_ID,
  keyOf,
  loadState,
  startCommand,
  stopCommand,
  restartCommand,
  startTask,
  stopTask,
  snapshot,
  streamLog,
  clearLog,
  validKey,
  logPath,
  autostart,
  shutdown,
  stopAll,
  forgetProject,
  isRunning,
  waitFor,
};
