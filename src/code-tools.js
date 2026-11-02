// Format và báo lỗi cho ngôn ngữ mà editor (Monaco + prettier trong trình duyệt) không tự làm được,
// bằng công cụ có sẵn trên máy (ruff/black, shfmt, gofmt, rustfmt, clang-format, shellcheck, yamllint…).
// Công cụ nào chưa cài thì bỏ qua; nội dung đi qua stdin nên không cần lưu file trước.
const path = require("path");
const { execFile } = require("child_process");
const pyenv = require("./python-env");

function pipe(file, args, input, { cwd, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      if (err && !okCodes.includes(code)) return reject(Object.assign(new Error(String(stderr || err.message).trim().split("\n").slice(0, 6).join("\n")), { status: 400 }));
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
    child.stdin.end(input);
  });
}

// lang (id ngôn ngữ của Monaco) -> danh sách formatter thử lần lượt
const FORMATTERS = {
  python: [
    ["ruff", (f) => ["format", "--stdin-filename", f, "-"]],
    ["black", () => ["-q", "-"]],
  ],
  shell: [["shfmt", () => ["-i", "2", "-"]]],
  go: [["gofmt", () => []]],
  rust: [["rustfmt", () => ["--emit", "stdout", "--edition", "2021"]]],
  c: [["clang-format", (f) => [`--assume-filename=${f}`]]],
  cpp: [["clang-format", (f) => [`--assume-filename=${f}`]]],
  java: [["clang-format", (f) => [`--assume-filename=${f}`]]],
  lua: [["stylua", () => ["-"]]],
  ini: [["taplo", () => ["fmt", "-"]]],
};

const local = (file) => (file && !file.startsWith("ssh://") ? path.dirname(file) : undefined);

function available(lang) {
  return (FORMATTERS[lang] || []).filter(([bin]) => pyenv.which(bin)).map(([bin]) => bin);
}

async function format(lang, content, file = "") {
  const list = (FORMATTERS[lang] || []).filter(([bin]) => pyenv.which(bin));
  if (!list.length) {
    const names = (FORMATTERS[lang] || []).map(([b]) => b);
    throw Object.assign(new Error(names.length ? `No formatter installed for ${lang} (install ${names.join(" or ")})` : `No formatter for ${lang}`), { status: 404 });
  }
  const [bin, args] = list[0];
  const r = await pipe(bin, args(file ? path.basename(file) : `file`), content, { cwd: local(file) });
  return { content: r.stdout, tool: bin };
}

// Kết quả: [{ line, column, endLine, endColumn, severity: "error"|"warning"|"info", message, source }]
// Không có linter nào được cài thì vẫn báo lỗi bằng công cụ luôn có sẵn (python3, bash, gofmt)
// Không có ruff: kiểm tra bằng thư viện chuẩn của Python (cú pháp, tên chưa định nghĩa, import không dùng)
const PY_CHECK = path.join(__dirname, "python-check.py");
async function pythonCheck(content, file) {
  const py = pyenv.which("python3") ? "python3" : "python";
  const r = await pipe(py, [PY_CHECK, file ? path.basename(file) : "file.py"], content);
  return JSON.parse(r.stdout || "[]").map((d) => ({ ...d, source: "python" }));
}

async function bashSyntax(content) {
  const r = await pipe("bash", ["-n"], content, { okCodes: [0, 1, 2] });
  return r.stderr
    .split("\n")
    .map((l) => l.match(/line (\d+): (.*)$/))
    .filter(Boolean)
    .map((m) => ({ line: Number(m[1]), column: 1, endLine: Number(m[1]), endColumn: 200, severity: "error", message: m[2], source: "bash -n" }));
}

const LINTERS = {
  async go(content) {
    if (!pyenv.which("gofmt")) return null;
    const r = await pipe("gofmt", ["-e"], content, { okCodes: [0, 2] });
    return r.stderr
      .split("\n")
      .map((l) => l.match(/^<standard input>:(\d+):(\d+): (.*)$/))
      .filter(Boolean)
      .map((m) => ({ line: Number(m[1]), column: Number(m[2]), endLine: Number(m[1]), endColumn: Number(m[2]) + 1, severity: "error", message: m[3], source: "gofmt" }));
  },
  async python(content, file) {
    if (!pyenv.which("ruff")) return pythonCheck(content, file);
    const r = await pipe("ruff", ["check", "--output-format", "json", "--stdin-filename", file ? path.basename(file) : "file.py", "-"], content, { cwd: local(file), okCodes: [0, 1] });
    return JSON.parse(r.stdout || "[]").map((d) => ({
      line: d.location.row,
      column: d.location.column,
      endLine: d.end_location?.row || d.location.row,
      endColumn: d.end_location?.column || d.location.column + 1,
      severity: d.code ? (/^(E9|F)/.test(d.code) ? "error" : "warning") : "error",
      message: `${d.message}${d.code ? ` (${d.code})` : ""}`,
      source: "ruff",
    }));
  },
  async shell(content) {
    if (!pyenv.which("shellcheck")) return /^#!.*\b(zsh|fish)\b/.test(content) ? [] : bashSyntax(content);
    const r = await pipe("shellcheck", ["-f", "json", "-s", /^#!.*\bsh\b/.test(content) ? "sh" : "bash", "-"], content, { okCodes: [0, 1] });
    return JSON.parse(r.stdout || "[]").map((d) => ({ line: d.line, column: d.column, endLine: d.endLine, endColumn: d.endColumn, severity: d.level === "error" ? "error" : d.level === "warning" ? "warning" : "info", message: `${d.message} (SC${d.code})`, source: "shellcheck" }));
  },
  async yaml(content) {
    if (!pyenv.which("yamllint")) return null;
    const r = await pipe("yamllint", ["-f", "parsable", "-"], content, { okCodes: [0, 1, 2] });
    return r.stdout
      .split("\n")
      .map((l) => l.match(/^[^:]*:(\d+):(\d+): \[(\w+)\] (.*)$/))
      .filter(Boolean)
      .map((m) => ({ line: Number(m[1]), column: Number(m[2]), endLine: Number(m[1]), endColumn: Number(m[2]) + 1, severity: m[3] === "error" ? "error" : "warning", message: m[4], source: "yamllint" }));
  },
};

async function lint(lang, content, file = "") {
  const fn = LINTERS[lang];
  if (!fn) return { markers: [], tool: null };
  const markers = await fn(content, file).catch((e) => [{ line: 1, column: 1, endLine: 1, endColumn: 2, severity: "info", message: e.message, source: "lint" }]);
  return { markers: markers || [], tool: markers ? lang : null };
}

module.exports = { format, lint, available };
