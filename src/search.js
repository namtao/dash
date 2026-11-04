// Tìm / thay thế nội dung trong thư mục (như Search của VS Code). Dùng công cụ có sẵn trên máy chạy lệnh:
// rg (tôn trọng .gitignore) → git grep (trong repo) → grep -r. Thư mục ssh://… chạy cùng lệnh đó trên máy từ xa.
// Công cụ chỉ tìm dòng khớp; vị trí từng kết quả và phép thay thế tính bằng RegExp của JS cho mọi trường hợp.
const path = require("path");
const { spawn } = require("child_process");
const files = require("./files");
const remote = require("./remote");
const ssh = require("./ssh-profiles");

const q = ssh.shellQuote;
const MAX_LINES = 10000; // số dòng khớp tối đa đọc từ công cụ
const MAX_MATCHES = 20000;
// grep không đọc .gitignore: bỏ các thư mục nặng thường gặp
const HEAVY_DIRS = ["node_modules", "__pycache__", ".venv", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", ".cache"];

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function buildRegex({ query, regex, caseSensitive, wholeWord }) {
  let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) src = `(?<!\\w)(?:${src})(?!\\w)`;
  try {
    return new RegExp(src, caseSensitive ? "gm" : "gim");
  } catch (e) {
    throw bad(`Invalid regular expression: ${e.message.replace(/^Invalid regular expression: \/.*\/\w*: /, "")}`);
  }
}

// "a, b" → ["a", "b"]; "./src" → "src"; "src/" → "src/**"
const globs = (s) =>
  String(s || "")
    .split(",")
    .map((g) => g.trim().replace(/^\.\//, "").replace(/\/$/, "/**"))
    .filter(Boolean);

function rgCmd(o, inc, exc) {
  const a = ["rg", "--null", "--line-number", "--no-heading", "--with-filename", "--color=never", "--no-messages", "--hidden", "-g", "!.git"];
  a.push(o.caseSensitive ? "-s" : "-i");
  if (!o.regex) a.push("-F");
  if (o.wholeWord) a.push("-w");
  if (o.noIgnore) a.push("--no-ignore");
  else a.push("-g", "!node_modules");
  for (const g of inc) a.push("-g", g);
  for (const g of exc) a.push("-g", `!${g}`);
  a.push("-e", o.query);
  return a.map(q).join(" ");
}

function gitGrepCmd(o, inc, exc) {
  const spec = (g, magic) => {
    const p = g.includes("/") ? g : `**/${g}`;
    return [`:(${magic})${p}`, `:(${magic})${p}/**`];
  };
  const a = ["git", "grep", "-n", "-z", "-I", "--untracked", o.regex ? "-E" : "-F"];
  if (!o.caseSensitive) a.push("-i");
  if (o.wholeWord) a.push("-w");
  if (o.noIgnore) a.push("--no-exclude-standard");
  a.push("-e", o.query, "--");
  for (const g of inc) a.push(...spec(g, "glob"));
  for (const g of exc) a.push(...spec(g, "exclude,glob"));
  if (!o.noIgnore) a.push(":(exclude,glob)**/node_modules/**");
  return a.map(q).join(" ");
}

// --include / --exclude của grep chỉ so với tên file, nên chỉ lấy phần cuối của glob
function grepCmd(o, inc, exc) {
  const base = (g) => g.split("/").filter((x) => x && x !== "**").pop();
  const a = ["grep", "-rnIs", "--null", o.regex ? "-E" : "-F", "--exclude-dir=.git"];
  if (!o.caseSensitive) a.push("-i");
  if (o.wholeWord) a.push("-w");
  if (!o.noIgnore) for (const d of HEAVY_DIRS) a.push(`--exclude-dir=${d}`);
  for (const g of inc.map(base).filter(Boolean)) a.push(`--include=${g}`);
  for (const g of exc.map(base).filter(Boolean)) a.push(`--exclude=${g}`, `--exclude-dir=${g}`);
  a.push("-e", o.query, ".");
  return a.map(q).join(" ");
}

function script(o) {
  const inc = globs(o.include);
  const exc = globs(o.exclude);
  return (
    `{ if command -v rg >/dev/null 2>&1; then ${rgCmd(o, inc, exc)}; ` +
    `elif command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then ${gitGrepCmd(o, inc, exc)}; ` +
    `else ${grepCmd(o, inc, exc)}; fi; } | head -n ${MAX_LINES + 1}`
  );
}

// Chạy lệnh trong thư mục (máy này hoặc qua ssh); đọc từng dòng; dừng khi trình duyệt huỷ yêu cầu
function run(dir, cmd, onLine, signal) {
  return new Promise((resolve, reject) => {
    let child;
    if (remote.isRemote(dir)) {
      const { profile, dir: d } = remote.parse(dir);
      child = spawn("ssh", ssh.execArgs(profile, `cd ${q(d)} && ${cmd}`), { stdio: ["ignore", "pipe", "pipe"] });
    } else child = spawn("sh", ["-c", cmd], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let rest = "";
    let err = "";
    let lines = 0;
    const stop = () => child.kill();
    const timer = setTimeout(stop, 60000);
    signal?.once("close", stop);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop();
      for (const line of parts) if (line) (lines++, onLine(line));
    });
    child.stderr.on("data", (d) => (err += d).length > 4000 && (err = err.slice(-4000)));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      signal?.off("close", stop);
      if (rest) (lines++, onLine(rest));
      // qua "| head" không còn mã thoát của công cụ: không có kết quả mà có báo lỗi thì coi là lỗi (vd. regex sai)
      const msg = err.trim().split("\n").filter(Boolean).pop();
      if (!lines && msg) return reject(bad(msg.replace(/^(rg|grep|fatal): /, "")));
      resolve(lines);
    });
  });
}

// Đoạn xem trước quanh một kết quả: bỏ thụt đầu dòng, cắt bớt dòng quá dài
function preview(text, start, len) {
  const indent = text.match(/^\s*/)[0].length;
  if (!len) start = indent;
  const from = Math.max(Math.min(indent, start), start - 40);
  const pre = (from > indent ? "…" : "") + text.slice(from, start);
  return { pre, match: text.slice(start, start + len).slice(0, 300), post: text.slice(start + len, start + len + 200) };
}

// Chuỗi thay thế của một kết quả: chế độ regex hiểu $1, $<tên>, $&, \n, \t như VS Code
function expand(repl, m, regex) {
  if (!regex) return repl;
  const named = m.groups || {};
  return repl
    .replace(/\\([nt\\])/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"))
    .replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (all, k, name) => {
      if (k === "$") return "$";
      if (k === "&") return m[0];
      if (name !== undefined) return named[name] ?? "";
      const i = Number(k);
      return i < m.length ? m[i] ?? "" : all;
    });
}

// Các kết quả trong một dòng (bỏ kết quả rỗng như "^" để không lặp vô hạn)
function matchesIn(re, line) {
  const out = [];
  re.lastIndex = 0;
  for (let m; (m = re.exec(line)); ) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    out.push(m);
  }
  return out;
}

async function search(dir, o, signal) {
  dir = files.abs(dir);
  const query = String(o.query || "");
  if (!query) return { root: dir, files: [], total: 0, truncated: false };
  const opts = { ...o, query, regex: Boolean(o.regex), caseSensitive: Boolean(o.caseSensitive), wholeWord: Boolean(o.wholeWord), noIgnore: Boolean(o.noIgnore) };
  const re = buildRegex(opts);
  const repl = typeof o.replace === "string" ? o.replace : null;
  const byFile = new Map();
  let total = 0;
  const lines = await run(
    dir,
    script(opts),
    (raw) => {
      if (total >= MAX_MATCHES) return;
      // rg / grep: "đường dẫn\0số dòng:nội dung"; git grep -z: "đường dẫn\0số dòng\0nội dung"
      const z = raw.indexOf("\0");
      const m = z > 0 && raw.slice(z + 1).match(/^(\d+)[:\0]/);
      if (!m) return;
      const file = raw.slice(0, z).replace(/^\.\//, "");
      const line = Number(m[1]);
      const text = raw.slice(z + 1 + m[0].length).replace(/\r$/, "");
      let list = byFile.get(file);
      if (!list) byFile.set(file, (list = []));
      const found = matchesIn(re, text);
      // cú pháp regex của công cụ khác JS đôi chút: vẫn hiện dòng nhưng không tô
      if (!found.length) {
        list.push({ line, col: 1, len: 0, ...preview(text, 0, 0) });
        total++;
      }
      for (const x of found) {
        if (total >= MAX_MATCHES) break;
        list.push({ line, col: x.index + 1, len: x[0].length, ...preview(text, x.index, x[0].length), ...(repl != null ? { sub: expand(repl, x, opts.regex) } : {}) });
        total++;
      }
    },
    signal
  );
  const out = [...byFile].map(([file, matches]) => ({ path: file, matches }));
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { root: dir, files: out, total, truncated: lines > MAX_LINES || total >= MAX_MATCHES };
}

const joinPath = (dir, rel) => (remote.isRemote(dir) ? `${dir.replace(/\/+$/, "")}/${rel}` : path.join(dir, rel));

// Thay đúng các kết quả người dùng đang thấy: targets = { "đường/dẫn/tương/đối": [[dòng, cột], …] }.
// Kết quả không còn ở vị trí cũ (file đã đổi sau khi tìm) thì bỏ qua.
async function replace(dir, o) {
  dir = files.abs(dir);
  const query = String(o.query || "");
  if (!query) throw bad("Search text is required");
  const regex = Boolean(o.regex);
  const re = buildRegex({ query, regex, caseSensitive: Boolean(o.caseSensitive), wholeWord: Boolean(o.wholeWord) });
  const repl = String(o.replace ?? "");
  const targets = o.targets && typeof o.targets === "object" ? o.targets : {};
  const changed = [];
  const errors = [];
  let count = 0;
  for (const [rel, list] of Object.entries(targets)) {
    const norm = path.posix.normalize(rel);
    if (!rel || norm === ".." || norm.startsWith("../") || path.isAbsolute(rel)) {
      errors.push(`${rel}: outside the search folder`);
      continue;
    }
    const want = new Set((Array.isArray(list) ? list : []).map((x) => `${Number(x?.[0])}:${Number(x?.[1])}`));
    if (!want.size) continue;
    const file = joinPath(dir, rel);
    try {
      const f = await files.read(file);
      if (f.binary || f.tooLarge) throw new Error(f.binary ? "binary file" : "file is too large");
      const lines = f.content.split("\n");
      let n = 0;
      lines.forEach((text, i) => {
        const cr = text.endsWith("\r") ? "\r" : "";
        const body = cr ? text.slice(0, -1) : text;
        let out = "";
        let last = 0;
        let hit = false;
        for (const m of matchesIn(re, body)) {
          if (!want.has(`${i + 1}:${m.index + 1}`)) continue;
          out += body.slice(last, m.index) + expand(repl, m, regex);
          last = m.index + m[0].length;
          hit = true;
          n++;
        }
        if (hit) lines[i] = out + body.slice(last) + cr;
      });
      if (!n) continue;
      await files.write(file, lines.join("\n"));
      changed.push(rel);
      count += n;
    } catch (e) {
      errors.push(`${rel}: ${e.message}`);
    }
  }
  return { changed, count, errors };
}

module.exports = { search, replace };
