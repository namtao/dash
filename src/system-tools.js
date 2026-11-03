// Tiện ích hệ thống: cổng đang lắng nghe, trạng thái git, mở thư mục bằng trình quản lý file, tắt tiến trình theo PID.
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const pyenv = require("./python-env");

const LINUX = process.platform === "linux";
const MAC = process.platform === "darwin";

// [{ port, address, pid, process }] — Linux dùng `ss`, macOS dùng `lsof` (chỉ thấy tiến trình của user hiện tại, như `ss` không có root)
async function listeningPorts() {
  const out = [];
  const add = (local, pid, proc) => {
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!port || out.some((p) => p.port === port && p.pid === pid)) return;
    out.push({ port, address: local.slice(0, local.lastIndexOf(":")), process: proc, pid });
  };
  if (LINUX) {
    const r = await pyenv.run("ss", ["-ltnpH"]);
    for (const line of r.stdout.split("\n")) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const users = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
      add(cols[3], users ? Number(users[2]) : null, users?.[1] || null);
    }
  } else {
    // -F: mỗi dòng một trường; p = PID, c = tên lệnh, n = địa chỉ:cổng
    const r = await pyenv.run("lsof", ["-wnP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
    let pid = null;
    let proc = null;
    for (const line of r.stdout.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "c") proc = line.slice(1);
      else if (line[0] === "n") add(line.slice(1), pid, proc);
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

function processInfo(pid) {
  pid = String(Number(pid));
  try {
    if (!LINUX) {
      const cmdline = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8", timeout: 3000 }).trim();
      const cwd = execFileSync("lsof", ["-wa", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).split("\n").find((l) => l[0] === "n")?.slice(1) || "";
      return { cmdline, cwd };
    }
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    return { cmdline, cwd };
  } catch {
    return {};
  }
}

function killPid(pid, force) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Invalid PID");
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (e) {
    throw new Error(e.code === "EPERM" ? "Not allowed to kill this process (owned by another user/root)" : e.message);
  }
}

async function gitInfo(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) return null;
  const [branch, status, last] = await Promise.all([
    pyenv.run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]),
    pyenv.run("git", ["-C", dir, "status", "--porcelain", "-b"]),
    pyenv.run("git", ["-C", dir, "log", "-1", "--format=%h %s (%cr)"]),
  ]);
  const lines = status.stdout.split("\n").filter(Boolean);
  const head = lines[0] || "";
  return {
    branch: branch.stdout.trim(),
    changes: lines.length - 1,
    ahead: Number(head.match(/ahead (\d+)/)?.[1] || 0),
    behind: Number(head.match(/behind (\d+)/)?.[1] || 0),
    last: last.stdout.trim(),
  };
}

// Linux: Dash chạy bằng systemd user service, thường khởi động trước phiên đồ hoạ nên thiếu DISPLAY / WAYLAND_DISPLAY.
// Lấy các biến đó từ systemd (phiên desktop đã đưa vào) ngay lúc mở, để xdg-open mở được trình quản lý file.
const GUI_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION", "KDE_FULL_SESSION", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS"];
function guiEnv() {
  const env = { ...process.env };
  if (!LINUX) return env;
  try {
    const text = execFileSync("systemctl", ["--user", "show-environment"], { encoding: "utf8", timeout: 3000 });
    for (const line of text.split("\n")) {
      const i = line.indexOf("=");
      const key = line.slice(0, i);
      if (i > 0 && GUI_VARS.includes(key) && !env[key]) env[key] = line.slice(i + 1);
    }
  } catch {}
  return env;
}

// Mở bằng ứng dụng của desktop; báo lỗi nếu lệnh mở thoát lỗi ngay (không có màn hình, không có ứng dụng…)
// macOS dùng `open`, không cần DISPLAY.
const OPENER = MAC ? "open" : "xdg-open";
function detached(file, args, cwd) {
  const env = guiEnv();
  if (LINUX && !env.DISPLAY && !env.WAYLAND_DISPLAY) return Promise.reject(Object.assign(new Error("No graphical session found (DISPLAY / WAYLAND_DISPLAY is not set)"), { status: 400 }));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.stderr.destroy();
      child.unref();
      resolve();
    }, 2500);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`${file}: ${e.message}`), { status: 400 }));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code) reject(Object.assign(new Error(`${file} failed: ${err.trim().split("\n").pop() || `exit code ${code}`}`), { status: 400 }));
      else resolve();
    });
  });
}

const TOOLS = ["python3", "conda", "uv", "node", "npm", "yarn", "pnpm", "bun", "docker", "git", "psql", "pg_dump", "mysqldump", "claude"];

function systemInfo() {
  return { tools: Object.fromEntries(TOOLS.map((t) => [t, Boolean(pyenv.which(t))])) };
}

// Terminal và editor đều có sẵn trong Dash; chỉ còn mở thư mục bằng trình quản lý file của máy.
function open(what, dir) {
  if (!fs.existsSync(dir)) throw new Error("Folder not found");
  if (what === "folder") return detached(OPENER, [dir], dir);
  throw new Error("Not supported");
}

function openUrl(url) {
  if (!/^https?:\/\//.test(url)) throw new Error("Invalid URL");
  return detached(OPENER, [url], process.cwd());
}

module.exports = { listeningPorts, processInfo, killPid, gitInfo, open, openUrl, systemInfo };
