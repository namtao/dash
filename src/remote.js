// Thư mục trên máy SSH (đường dẫn ssh://<id hồ sơ>/đường/dẫn): liệt kê, đọc, ghi, tạo, đổi tên, xoá file
// bằng lệnh ssh không tương tác. Chỉ dùng lệnh POSIX phổ biến (ls, cat, stat, find) để chạy được trên đa số máy.
const path = require("path");
const { execFile } = require("child_process");
const store = require("./store");
const ssh = require("./ssh-profiles");

const q = ssh.shellQuote;
const isRemote = (p) => typeof p === "string" && p.startsWith("ssh://");

function parse(p) {
  const m = String(p || "").match(store.REMOTE_RE);
  if (!m) throw Object.assign(new Error("Invalid remote path"), { status: 400 });
  const profile = store.load().ssh.find((x) => x.id === m[1]);
  if (!profile) throw Object.assign(new Error(`SSH profile "${m[1]}" not found`), { status: 404 });
  return { profile, id: m[1], dir: path.posix.resolve(m[2]) };
}
const url = (id, dir) => `ssh://${id}${dir}`;

function exec(profile, command, { input, encoding = "utf8", timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", ssh.execArgs(profile, command), { timeout, maxBuffer: 64 * 1024 * 1024, encoding: encoding === "buffer" ? "buffer" : "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).trim().split("\n").pop() || err.message;
        return reject(Object.assign(new Error(`${profile.label}: ${msg}`), { status: err.code === 17 ? 409 : 400, code: err.code }));
      }
      resolve(stdout);
    });
    if (input != null) child.stdin.end(input);
  });
}

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const DIM = new Set([".git", "node_modules", "__pycache__", ".venv", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", ".cache"]);

async function list(p, { showHidden = true } = {}) {
  const { profile, id, dir } = parse(p);
  // ls -p đánh dấu thư mục bằng "/"; -L để symlink tới thư mục cũng hiện là thư mục
  const out = await exec(profile, `LC_ALL=C ls -1ApL -- ${q(dir)}`);
  const items = out
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ name: line.replace(/\/$/, ""), dir: line.endsWith("/"), link: false }))
    .filter((it) => showHidden || !it.name.startsWith("."))
    .map((it) => ({ ...it, dim: DIM.has(it.name) }));
  items.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { path: url(id, dir), items };
}

async function stat(profile, file) {
  const out = await exec(profile, `stat -c '%s %Y %F' -- ${q(file)} 2>/dev/null || stat -f '%z %m %HT' -- ${q(file)}`);
  const [size, mtime, ...kind] = out.trim().split(" ");
  return { size: Number(size), mtime: Number(mtime) * 1000, isDir: /directory/i.test(kind.join(" ")) };
}

async function read(p) {
  const { profile, id, dir: file } = parse(p);
  const st = await stat(profile, file);
  if (st.isDir) throw Object.assign(new Error("This is a folder"), { status: 400 });
  const base = { path: url(id, file), size: st.size, mtime: st.mtime };
  if (st.size > MAX_EDIT_BYTES) return { ...base, tooLarge: true };
  const buf = await exec(profile, `cat -- ${q(file)}`, { encoding: "buffer" });
  if (buf.subarray(0, 8000).includes(0)) return { ...base, binary: true };
  return { ...base, content: buf.toString("utf8") };
}

async function raw(p) {
  const { profile, dir: file } = parse(p);
  return exec(profile, `cat -- ${q(file)}`, { encoding: "buffer", timeout: 120000 });
}

async function write(p, content, { mtime, force } = {}) {
  const { profile, id, dir: file } = parse(p);
  if (mtime && !force) {
    const st = await stat(profile, file).catch(() => null);
    // máy từ xa chỉ cho mtime theo giây
    if (st && Math.abs(st.mtime - Math.floor(mtime / 1000) * 1000) > 1000) throw Object.assign(new Error("File changed on disk since it was opened"), { status: 409 });
  }
  await exec(profile, `mkdir -p -- ${q(path.posix.dirname(file))} && cat > ${q(file)}`, { input: String(content ?? "") });
  const st = await stat(profile, file);
  return { path: url(id, file), size: st.size, mtime: st.mtime };
}

async function create(p, isDir) {
  const { profile, id, dir: target } = parse(p);
  const make = isDir ? `mkdir -p -- ${q(target)}` : `mkdir -p -- ${q(path.posix.dirname(target))} && : > ${q(target)}`;
  await exec(profile, `if [ -e ${q(target)} ]; then echo 'Already exists' >&2; exit 17; fi; ${make}`);
  return { path: url(id, target) };
}

async function rename(from, to) {
  const a = parse(from);
  const b = parse(to);
  if (a.id !== b.id) throw Object.assign(new Error("Cannot move between machines"), { status: 400 });
  await exec(a.profile, `if [ -e ${q(b.dir)} ]; then echo 'Target already exists' >&2; exit 17; fi; mv -- ${q(a.dir)} ${q(b.dir)}`);
  return { path: url(b.id, b.dir) };
}

async function remove(p) {
  const { profile, dir: target } = parse(p);
  if (target === "/" || /^\/(home|root|usr|etc|var)\/?$/.test(target)) throw Object.assign(new Error("Refusing to delete this folder"), { status: 400 });
  await exec(profile, `rm -r -- ${q(target)}`);
  return { ok: true };
}

async function index(p, limit = 20000) {
  const { profile, id, dir } = parse(p);
  const prune = [...DIM, "dist", "build"].map((d) => `-name ${q(d)}`).join(" -o ");
  const out = await exec(profile, `cd -- ${q(dir)} && find . \\( ${prune} \\) -prune -o -type f -print 2>/dev/null | head -n ${limit}`, { timeout: 60000 });
  const files = out.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
  return { root: url(id, dir), files, truncated: files.length >= limit };
}

async function exists(p) {
  try {
    const { profile, dir } = parse(p);
    await exec(profile, `test -d ${q(dir)}`);
    return true;
  } catch {
    return false;
  }
}

module.exports = { isRemote, parse, exec, list, read, raw, write, create, rename, remove, index, exists };
