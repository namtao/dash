// Tiện ích hệ thống: cổng đang lắng nghe, trạng thái git, mở thư mục/editor/terminal, tắt tiến trình theo PID.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const pyenv = require("./python-env");

// [{ port, address, pid, process }]
async function listeningPorts() {
  const r = await pyenv.run("ss", ["-ltnpH"]);
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    const users = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (!port || out.some((p) => p.port === port && p.pid === (users ? Number(users[2]) : null))) continue;
    out.push({ port, address: local.slice(0, local.lastIndexOf(":")), process: users?.[1] || null, pid: users ? Number(users[2]) : null });
  }
  return out.sort((a, b) => a.port - b.port);
}

function processInfo(pid) {
  try {
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

function detached(file, args, cwd) {
  const child = spawn(file, args, { cwd, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function fillTemplate(template, dir) {
  // Tách theo khoảng trắng, thay {dir} sau khi tách để đường dẫn có dấu cách vẫn đúng
  return template.trim().split(/\s+/).map((part) => part.replaceAll("{dir}", dir));
}

// Mẫu lệnh mở terminal tại {dir}; thứ tự này cũng là thứ tự tự nhận diện
const TERMINALS = [
  { name: "wezterm", cmd: "wezterm start --cwd {dir}" },
  { name: "konsole", cmd: "konsole --workdir {dir}" },
  { name: "kitty", cmd: "kitty -d {dir}" },
  { name: "alacritty", cmd: "alacritty --working-directory {dir}" },
  { name: "ghostty", cmd: "ghostty --working-directory={dir}" },
  { name: "gnome-terminal", cmd: "gnome-terminal --working-directory={dir}" },
  { name: "xfce4-terminal", cmd: "xfce4-terminal --working-directory={dir}" },
  { name: "foot", cmd: "foot -D {dir}" },
  { name: "xterm", cmd: "xterm" },
];

function detectTerminal() {
  return TERMINALS.find((t) => pyenv.which(t.name)) || null;
}

const TOOLS = ["python3", "conda", "uv", "node", "npm", "yarn", "pnpm", "bun", "docker", "git", "code"];

function systemInfo() {
  const term = detectTerminal();
  return {
    terminal: term ? term.cmd : null,
    terminals: TERMINALS.map((t) => ({ ...t, installed: Boolean(pyenv.which(t.name)) })),
    tools: Object.fromEntries(TOOLS.map((t) => [t, Boolean(pyenv.which(t))])),
  };
}

function open(what, dir, settings) {
  if (!fs.existsSync(dir)) throw new Error("Folder not found");
  if (what === "folder") return detached("xdg-open", [dir], dir);
  if (what === "editor") {
    const [file, ...args] = fillTemplate(settings.editor || "code {dir}", dir);
    return detached(file, args, dir);
  }
  if (what === "terminal") {
    const template = settings.terminal || detectTerminal()?.cmd;
    if (!template) throw new Error("No terminal found, set one in Settings");
    const [file, ...args] = fillTemplate(template, dir);
    return detached(file, args, dir);
  }
  throw new Error("Not supported");
}

function openUrl(url) {
  if (!/^https?:\/\//.test(url)) throw new Error("Invalid URL");
  detached("xdg-open", [url], process.cwd());
}

module.exports = { listeningPorts, processInfo, killPid, gitInfo, open, openUrl, systemInfo };
