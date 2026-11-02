// Terminal thật trong trình duyệt: mỗi terminal là một PTY (node-pty) chạy shell của người dùng.
// PTY sống độc lập với tab trình duyệt (tải lại trang vẫn gắn lại được, như tmux); phần output gần nhất
// được giữ lại để phát lại khi gắn lại. Shell được nạp kèm hook (shell-integration/) báo lệnh vừa gõ,
// mã thoát và thư mục hiện tại qua chuỗi OSC 633, nhờ đó Dash ghi lịch sử lệnh theo thư mục.
const fs = require("fs");
const os = require("os");
const path = require("path");
const pty = require("node-pty");
const store = require("./store");
const history = require("./history");

const SHIM_DIR = path.join(store.ROOT, "shell-integration");
const REPLAY_BYTES = 512 * 1024;
const terms = new Map(); // id -> term
let seq = 0;
const listeners = new Set(); // (event, payload) => void

function emit(event, payload) {
  for (const fn of listeners) fn(event, payload);
}

function shellArgv(shell) {
  const name = path.basename(shell);
  if (name === "zsh") return { file: shell, args: ["-l"], env: { ZDOTDIR: path.join(SHIM_DIR, "zsh"), DASH_USER_ZDOTDIR: process.env.ZDOTDIR || os.homedir() } };
  if (name === "bash") return { file: shell, args: ["--rcfile", path.join(SHIM_DIR, "bashrc"), "-i"], env: {} };
  return { file: shell, args: ["-l"], env: {} };
}

function baseEnv(extra) {
  const env = { ...process.env, ...extra, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "dash", TERM_PROGRAM_VERSION: "1" };
  // Biến của chính Dash không nên lọt vào shell
  for (const k of ["PORT", "HOST", "DASH_CONFIG", "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID"]) delete env[k];
  return env;
}

function unescapeOsc(s) {
  return s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\\/g, "\\");
}

// Đọc chuỗi OSC 633 (E = lệnh, D = mã thoát, P;Cwd= = thư mục) trong output của shell.
function scanOsc(t, data) {
  const text = t.oscTail + data;
  const re = /\x1b\]633;([A-Z])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;
  let m;
  let last = 0;
  while ((m = re.exec(text))) {
    last = re.lastIndex;
    const [, kind, arg = ""] = m;
    if (kind === "E") t.pending = { cmd: unescapeOsc(arg), cwd: t.cwd };
    else if (kind === "D") {
      if (t.pending) {
        const cmd = t.pending.cmd;
        // Bỏ qua lệnh bắt đầu bằng dấu cách (quy ước HIST_IGNORE_SPACE)
        if (!/^\s/.test(cmd)) {
          const e = history.record({ cmd, cwd: t.pending.cwd, exit: Number(arg) });
          if (e) emit("history", { id: t.id, entry: e });
        }
        t.pending = null;
      }
    } else if (kind === "P" && arg.startsWith("Cwd=")) {
      const cwd = unescapeOsc(arg.slice(4));
      if (cwd !== t.cwd) {
        t.cwd = cwd;
        emit("cwd", { id: t.id, ws: t.ws, cwd });
      }
    }
  }
  // Giữ phần đuôi có thể là chuỗi OSC chưa trọn để ghép với lần đọc sau
  const rest = text.slice(last);
  const open = rest.lastIndexOf("\x1b]633;");
  t.oscTail = open >= 0 && rest.length - open < 8192 ? rest.slice(open) : "";
}

function info(t) {
  return { id: t.id, ws: t.ws, title: t.title, kind: t.kind, cwd: t.cwd, pid: t.proc.pid, createdAt: t.createdAt, exited: t.exited, exitCode: t.exitCode, sshId: t.sshId || null };
}

// opts: { cwd, title, argv?: [file, ...args] (vd. ssh), sshId, cols, rows, ws (cửa sổ sở hữu: "main" hoặc id dự án) }
function create(opts = {}) {
  const ws = store.load().workspace;
  let cwd = opts.cwd && fs.existsSync(opts.cwd) ? path.resolve(opts.cwd) : os.homedir();
  try {
    if (!fs.statSync(cwd).isDirectory()) cwd = path.dirname(cwd);
  } catch {}
  let file, args, env;
  if (opts.argv?.length) {
    [file, ...args] = opts.argv;
    env = baseEnv({});
  } else {
    const sh = shellArgv(ws.shell);
    ({ file, args } = sh);
    env = baseEnv(sh.env);
  }
  const cols = Math.max(20, Number(opts.cols) || 120);
  const rows = Math.max(5, Number(opts.rows) || 30);
  const proc = pty.spawn(file, args, { name: "xterm-256color", cwd, env, cols, rows });
  const id = `t${++seq}`;
  const t = {
    id,
    proc,
    kind: opts.argv?.length ? (opts.sshId ? "ssh" : "cmd") : "shell",
    title: opts.title || (opts.argv?.length ? opts.argv.join(" ") : path.basename(cwd) || "~"),
    sshId: opts.sshId,
    ws: String(opts.ws || "main"),
    cwd,
    createdAt: Date.now(),
    exited: false,
    exitCode: null,
    buffer: "",
    oscTail: "",
    pending: null,
    cols,
    rows,
  };
  terms.set(id, t);
  proc.onData((data) => {
    t.buffer += data;
    if (t.buffer.length > REPLAY_BYTES * 1.25) t.buffer = t.buffer.slice(-REPLAY_BYTES);
    if (t.kind === "shell") scanOsc(t, data);
    emit("data", { id, data });
  });
  proc.onExit(({ exitCode }) => {
    t.exited = true;
    t.exitCode = exitCode;
    emit("exit", { id, ws: t.ws, exitCode });
  });
  emit("created", info(t));
  return info(t);
}

function get(id) {
  const t = terms.get(id);
  if (!t) throw Object.assign(new Error("Terminal not found"), { status: 404 });
  return t;
}

const list = (ws) => [...terms.values()].filter((t) => !ws || t.ws === ws).map(info);
const replay = (id) => get(id).buffer;

function write(id, data) {
  const t = terms.get(id);
  if (t && !t.exited) t.proc.write(data);
}

function resize(id, cols, rows) {
  const t = terms.get(id);
  cols = Math.max(2, Math.floor(cols));
  rows = Math.max(1, Math.floor(rows));
  if (!t || t.exited || (t.cols === cols && t.rows === rows)) return;
  t.cols = cols;
  t.rows = rows;
  try {
    t.proc.resize(cols, rows);
  } catch {}
}

function rename(id, title) {
  const t = get(id);
  t.title = String(title || "").trim() || t.title;
  emit("renamed", info(t));
}

function kill(id) {
  const t = terms.get(id);
  if (!t) return;
  if (!t.exited) {
    try {
      t.proc.kill("SIGHUP");
    } catch {}
  }
  terms.delete(id);
  emit("closed", { id, ws: t.ws });
}

function killAll() {
  for (const id of [...terms.keys()]) kill(id);
}

module.exports = { create, list, replay, write, resize, rename, kill, killAll, get, on: (fn) => listeners.add(fn), off: (fn) => listeners.delete(fn) };
