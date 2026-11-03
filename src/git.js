// Git cho màn Source Control: trạng thái, nội dung hai phía để so sánh (diff editor), stage/unstage,
// bỏ thay đổi, commit, pull/push, lịch sử commit. Thư mục ssh://<id>/... chạy git trên máy đó qua ssh
// (cùng ControlMaster với Explorer); push/pull dùng khoá git của máy từ xa.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const remote = require("./remote");
const sshProfiles = require("./ssh-profiles");

function git(cwd, args, { input, allowFail = false, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const done = (err, stdout, stderr) => {
      if (err && !allowFail) return reject(Object.assign(new Error(String(stderr || err.message).trim()), { status: 400 }));
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    };
    const opts = { timeout, maxBuffer: 64 * 1024 * 1024 };
    let child;
    if (remote.isRemote(cwd)) {
      const { profile, dir } = remote.parse(cwd);
      const q = sshProfiles.shellQuote;
      const cmd = `cd ${q(dir)} && LC_ALL=C GIT_TERMINAL_PROMPT=0 git ${args.map(q).join(" ")}`;
      child = execFile("ssh", sshProfiles.execArgs(profile, cmd), opts, done);
    } else child = execFile("git", args, { ...opts, cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } }, done);
    if (input != null) child.stdin.end(input);
  });
}

// Gốc repo; với thư mục từ xa trả về dạng ssh://<id>/gốc để các bước sau vẫn chạy trên máy đó
async function root(dir) {
  const r = await git(dir, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (!r.ok) {
    // lỗi ssh (mất kết nối, sai khoá) khác với "không phải repo"
    if (remote.isRemote(dir) && !/not a git repository/i.test(r.stderr)) throw Object.assign(new Error(r.stderr.trim().split("\n").pop() || "SSH error"), { status: 400 });
    throw Object.assign(new Error("Not a git repository"), { status: 404 });
  }
  const top = r.stdout.trim();
  return remote.isRemote(dir) ? `ssh://${remote.parse(dir).id}${top}` : top;
}

// Đường dẫn trên đĩa (bỏ tiền tố ssh://<id>) để tính đường dẫn tương đối trong repo
const diskPath = (p) => String(p).replace(/^ssh:\/\/[^/]+/, "");
const relTo = (top, p) => (remote.isRemote(p) || path.isAbsolute(p) ? path.posix.relative(diskPath(top), diskPath(p)) : p);
const inRepo = (top, rel) => (remote.isRemote(top) ? `${top}/${rel}` : path.join(top, rel));

const LABELS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict", T: "type changed", "?": "untracked" };

async function status(dir) {
  const top = await root(dir);
  const [st, head] = await Promise.all([
    // --ignored=matching: thư mục bị ignore chỉ hiện một dòng (không liệt kê từng file bên trong)
    git(top, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all", "--ignored=matching"]),
    git(top, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true }),
  ]);
  const parts = st.stdout.split("\0");
  const out = { root: top, branch: "", upstream: "", ahead: 0, behind: 0, hasHead: head.ok, head: head.ok ? head.stdout.trim() : "", staged: [], changes: [], conflicts: [], ignored: [] };
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith("## ")) {
      const m = rec.slice(3).match(/^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/);
      out.branch = m?.[1] || rec.slice(3);
      out.upstream = m?.[2] || "";
      out.ahead = Number(rec.match(/ahead (\d+)/)?.[1] || 0);
      out.behind = Number(rec.match(/behind (\d+)/)?.[1] || 0);
      continue;
    }
    const x = rec[0];
    const y = rec[1];
    const file = rec.slice(3);
    let orig = null;
    if (x === "R" || x === "C") orig = parts[++i];
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      out.conflicts.push({ path: file, status: "U", label: "conflict" });
      continue;
    }
    if (x === "!") {
      out.ignored.push(file.replace(/\/$/, ""));
      continue;
    }
    if (x === "?") {
      out.changes.push({ path: file, status: "U", label: "untracked", untracked: true });
      continue;
    }
    if (x !== " ") out.staged.push({ path: file, orig, status: x, label: LABELS[x] || x });
    if (y !== " ") out.changes.push({ path: file, status: y, label: LABELS[y] || y });
  }
  return out;
}

async function show(top, spec) {
  const r = await git(top, ["show", spec], { allowFail: true });
  return r.ok ? r.stdout : "";
}

async function readWorking(top, file) {
  if (remote.isRemote(top)) {
    const r = await remote.read(inRepo(top, file)).catch(() => null);
    return !r ? "" : r.binary || r.tooLarge ? null : r.content;
  }
  try {
    const buf = fs.readFileSync(path.join(top, file));
    return buf.includes(0) ? null : buf.toString("utf8");
  } catch {
    return "";
  }
}

// Nội dung bên trái (gốc) và bên phải (đã sửa) của một file.
// mode: "working" (index ↔ thư mục làm việc), "staged" (HEAD ↔ index), "commit" (commit^ ↔ commit).
async function diffPair(dir, file, mode = "working", commit = "") {
  const top = await root(dir);
  const rel = relTo(top, file);
  let original;
  let modified;
  if (mode === "staged") {
    original = await show(top, `HEAD:${rel}`);
    modified = await show(top, `:${rel}`);
  } else if (mode === "commit") {
    if (!/^[0-9a-f]{4,40}$/i.test(commit)) throw Object.assign(new Error("Invalid commit"), { status: 400 });
    original = await show(top, `${commit}^:${rel}`);
    modified = await show(top, `${commit}:${rel}`);
  } else {
    const idx = await git(top, ["show", `:${rel}`], { allowFail: true });
    original = idx.ok ? idx.stdout : await show(top, `HEAD:${rel}`);
    modified = await readWorking(top, rel);
  }
  return { root: top, path: rel, original, modified, binary: modified === null };
}

const relPaths = (top, paths) => (Array.isArray(paths) ? paths : [paths]).map((p) => relTo(top, p)).filter(Boolean);

async function stage(dir, paths) {
  const top = await root(dir);
  await git(top, ["add", "-A", "--", ...relPaths(top, paths)]);
  return { ok: true };
}

async function unstage(dir, paths) {
  const top = await root(dir);
  const files = relPaths(top, paths);
  const head = await git(top, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true });
  if (head.ok) await git(top, ["reset", "-q", "HEAD", "--", ...files]);
  else await git(top, ["rm", "--cached", "-q", "-r", "--", ...files]);
  return { ok: true };
}

// Bỏ thay đổi chưa stage. File chưa track thì xoá khỏi đĩa.
async function discard(dir, paths) {
  const top = await root(dir);
  const st = await status(top);
  for (const rel of relPaths(top, paths)) {
    const untracked = st.changes.find((c) => c.path === rel && c.untracked);
    if (untracked && remote.isRemote(top)) await remote.remove(inRepo(top, rel));
    else if (untracked) fs.rmSync(path.join(top, rel), { recursive: true, force: true });
    else await git(top, ["checkout", "--", rel]);
  }
  return { ok: true };
}

// Diff để AI viết commit message: phần đã stage, nếu chưa stage gì thì toàn bộ thay đổi (kèm tên file mới)
async function diffForMessage(dir, limit = 16000) {
  const top = await root(dir);
  let staged = true;
  let diff = (await git(top, ["diff", "--cached", "--no-color", "--stat", "--patch"])).stdout;
  if (!diff.trim()) {
    staged = false;
    diff = (await git(top, ["diff", "--no-color", "--stat", "--patch"], { allowFail: true })).stdout;
    const untracked = (await git(top, ["ls-files", "--others", "--exclude-standard"])).stdout.trim();
    if (untracked) diff += `\nNew files:\n${untracked}\n`;
  }
  if (!diff.trim()) throw Object.assign(new Error("No changes to describe"), { status: 400 });
  return { staged, diff: diff.length > limit ? `${diff.slice(0, limit)}\n… (diff truncated)` : diff };
}

async function commit(dir, message, { amend = false, all = false } = {}) {
  const top = await root(dir);
  if (!String(message || "").trim() && !amend) throw Object.assign(new Error("Commit message is empty"), { status: 400 });
  if (all) await git(top, ["add", "-A"]);
  const args = ["commit", "-F", "-"];
  if (amend) args.push("--amend");
  if (amend && !String(message || "").trim()) args.splice(1, 2, "--no-edit");
  const r = await git(top, args, { input: String(message || "") });
  return { ok: true, output: (r.stdout + r.stderr).trim() };
}

async function sync(dir, action) {
  const top = await root(dir);
  const args = { pull: ["pull", "--ff-only"], push: ["push"], fetch: ["fetch", "--all", "--prune"] }[action];
  if (!args) throw Object.assign(new Error("Unknown action"), { status: 400 });
  if (action === "push") {
    const up = await git(top, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true });
    if (!up.ok) {
      const br = (await git(top, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      args.push("-u", "origin", br);
    }
  }
  const r = await git(top, args, { timeout: 120000 });
  return { ok: true, output: (r.stdout + r.stderr).trim() };
}

async function log(dir, limit = 100) {
  const top = await root(dir);
  const r = await git(top, ["log", `-n${Math.min(500, Number(limit) || 100)}`, "--date=iso-strict", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s%x1e"], { allowFail: true });
  return r.stdout
    .split("\x1e")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [hash, short, author, date, refs, subject] = s.split("\x1f");
      return { hash, short, author, date, refs, subject };
    });
}

async function commitFiles(dir, hash) {
  const top = await root(dir);
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw Object.assign(new Error("Invalid commit"), { status: 400 });
  const [msg, tree] = await Promise.all([git(top, ["log", "-1", "--format=%B", hash]), git(top, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--root", "--no-renames", hash])]);
  const message = msg.stdout.trim();
  const parts = tree.stdout.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1] });
  return { hash, message, files };
}

async function branches(dir) {
  const top = await root(dir);
  const r = await git(top, ["branch", "-a", "--format=%(refname:short)%x1f%(HEAD)"]);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, head] = l.split("\x1f");
      return { name, current: head === "*" };
    });
}

async function checkout(dir, branch, create = false) {
  const top = await root(dir);
  if (!/^[\w./-]+$/.test(branch || "")) throw Object.assign(new Error("Invalid branch name"), { status: 400 });
  const r = await git(top, create ? ["checkout", "-b", branch] : ["checkout", branch.replace(/^origin\//, "")]);
  return { ok: true, output: (r.stdout + r.stderr).trim() };
}

// Tóm tắt cho trang dự án (cùng dạng system-tools.gitInfo): nhánh, số thay đổi, ahead/behind, commit cuối
async function summary(dir) {
  const st = await status(dir);
  const [last] = await log(st.root, 1);
  return { branch: st.branch, changes: st.staged.length + st.changes.length + st.conflicts.length, ahead: st.ahead, behind: st.behind, last: last ? `${last.short} ${last.subject}` : "" };
}

module.exports = {
  summary,
  diffForMessage, status, diffPair, stage, unstage, discard, commit, sync, log, commitFiles, branches, checkout, root };
