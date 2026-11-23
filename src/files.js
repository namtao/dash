// Duyệt và sửa file cho Explorer/editor. Dash chỉ nghe trên máy local và vốn đã chạy được lệnh tuỳ ý,
// nên không giới hạn thư mục; chỉ chặn file quá lớn và file nhị phân khi mở bằng editor.
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const remote = require("./remote");

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const HIDDEN_ALWAYS = new Set([".git", "node_modules", "__pycache__", ".venv", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", ".cache"]);

function abs(p) {
  const s = String(p || "").trim();
  if (!s) throw Object.assign(new Error("Path is required"), { status: 400 });
  if (remote.isRemote(s)) return s;
  const expanded = s === "~" ? os.homedir() : s.startsWith("~/") ? path.join(os.homedir(), s.slice(2)) : s;
  if (!path.isAbsolute(expanded)) throw Object.assign(new Error("Path must be absolute"), { status: 400 });
  return path.resolve(expanded);
}

async function list(dir, { showHidden = true } = {}) {
  dir = abs(dir);
  const items = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const d of items) {
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = (await fsp.stat(path.join(dir, d.name))).isDirectory();
      } catch {}
    }
    if (!showHidden && d.name.startsWith(".")) continue;
    out.push({ name: d.name, dir: isDir, link: d.isSymbolicLink(), dim: HIDDEN_ALWAYS.has(d.name) });
  }
  out.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { path: dir, items: out };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function read(file) {
  file = abs(file);
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw Object.assign(new Error("This is a folder"), { status: 400 });
  if (st.size > MAX_EDIT_BYTES) return { path: file, size: st.size, mtime: st.mtimeMs, tooLarge: true };
  const buf = await fsp.readFile(file);
  if (looksBinary(buf)) return { path: file, size: st.size, mtime: st.mtimeMs, binary: true };
  return { path: file, size: st.size, mtime: st.mtimeMs, content: buf.toString("utf8") };
}

// mtime: thời điểm file lúc mở; nếu file đã bị sửa ở nơi khác thì báo xung đột (trừ khi force).
async function write(file, content, { mtime, force } = {}) {
  file = abs(file);
  if (mtime && !force) {
    try {
      const st = await fsp.stat(file);
      if (Math.abs(st.mtimeMs - mtime) > 1) throw Object.assign(new Error("File changed on disk since it was opened"), { status: 409 });
    } catch (e) {
      if (e.status) throw e;
    }
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, String(content ?? ""));
  const st = await fsp.stat(file);
  return { path: file, size: st.size, mtime: st.mtimeMs };
}

async function create(target, isDir) {
  target = abs(target);
  if (fs.existsSync(target)) throw Object.assign(new Error("Already exists"), { status: 409 });
  if (isDir) await fsp.mkdir(target, { recursive: true });
  else {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "");
  }
  return { path: target };
}

async function rename(from, to) {
  from = abs(from);
  to = abs(to);
  if (fs.existsSync(to)) throw Object.assign(new Error("Target already exists"), { status: 409 });
  await fsp.rename(from, to);
  return { path: to };
}

async function remove(target) {
  target = abs(target);
  if (target === "/" || target === os.homedir()) throw Object.assign(new Error("Refusing to delete this folder"), { status: 400 });
  await fsp.rm(target, { recursive: true, force: false });
  return { ok: true };
}

// Danh sách file (đường dẫn tương đối) để mở nhanh bằng Ctrl+P; dùng git ls-files nếu là repo.
async function index(root, limit = 20000) {
  root = abs(root);
  const out = [];
  async function walk(dir, depth) {
    if (out.length >= limit || depth > 12) return;
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of items) {
      if (out.length >= limit) return;
      if (HIDDEN_ALWAYS.has(d.name) || d.name === "dist" || d.name === "build") continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full, depth + 1);
      else if (d.isFile()) out.push(path.relative(root, full));
    }
  }
  await walk(root, 0);
  return { root, files: out, truncated: out.length >= limit };
}

// File thô (ảnh, PDF, docx, xlsx…) cho trình xem; giới hạn 50 MB
const MAX_RAW_BYTES = 50 * 1024 * 1024;
async function raw(file) {
  file = abs(file);
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw Object.assign(new Error("This is a folder"), { status: 400 });
  if (st.size > MAX_RAW_BYTES) throw Object.assign(new Error("File is too large to preview"), { status: 413 });
  return fsp.readFile(file);
}

// Cây thư mục dạng chữ (như extension "file tree generator" của VS Code), bỏ qua thư mục nặng
async function tree(dir, { maxDepth = 6, maxEntries = 3000 } = {}) {
  dir = abs(dir);
  const lines = [`${path.basename(dir) || dir}/`];
  let count = 0;
  async function walk(d, prefix, depth) {
    if (depth > maxDepth) return;
    const { items } = await module.exports.list(d);
    const shown = items.filter((it) => !HIDDEN_ALWAYS.has(it.name) && it.name !== ".DS_Store");
    for (let i = 0; i < shown.length; i++) {
      if (++count > maxEntries) {
        if (count === maxEntries + 1) lines.push(`${prefix}└── …`);
        return;
      }
      const it = shown[i];
      const last = i === shown.length - 1;
      lines.push(`${prefix}${last ? "└── " : "├── "}${it.name}${it.dir ? "/" : ""}`);
      if (it.dir) await walk(remote.isRemote(d) ? `${d.replace(/\/+$/, "")}/${it.name}` : path.join(d, it.name), prefix + (last ? "    " : "│   "), depth + 1);
    }
  }
  await walk(dir, "", 1);
  return { root: dir, text: lines.join("\n"), truncated: count > maxEntries };
}

// Đường dẫn ssh://… đi qua module remote, còn lại là file trên máy này
const pick = (local, rem) => (p, ...args) => (remote.isRemote(String(p || "").trim()) ? rem(String(p).trim(), ...args) : local(p, ...args));
module.exports = {
  abs,
  list: pick(list, remote.list),
  read: pick(read, remote.read),
  raw: pick(raw, remote.raw),
  write: pick(write, remote.write),
  create: pick(create, remote.create),
  rename: pick(rename, remote.rename),
  remove: pick(remove, remote.remove),
  index: pick(index, remote.index),
  tree,
};
