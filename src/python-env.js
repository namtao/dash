// Môi trường ảo Python: conda, venv (python -m venv), uv (uv venv).
// Lệnh của dự án chạy với PATH đã chèn thư mục bin của môi trường, không cần "activate".
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const HOME = process.env.HOME || "";
let condaCache = { at: 0, envs: [] };

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 20000, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

function which(bin) {
  for (const dir of (process.env.PATH || "").split(":")) {
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

async function condaEnvs(force = false) {
  if (!force && Date.now() - condaCache.at < 30000) return condaCache.envs;
  if (!which("conda")) return [];
  const r = await run("conda", ["env", "list", "--json"]);
  let envs = [];
  try {
    envs = JSON.parse(r.stdout).envs.map((prefix) => ({ name: path.basename(prefix), prefix }));
  } catch {}
  condaCache = { at: Date.now(), envs };
  return envs;
}

async function condaPrefix(name) {
  if (!name) return null;
  const hit = (await condaEnvs()).find((e) => e.name === name || e.prefix === name);
  if (hit) return hit.prefix;
  // conda env list có thể chậm cập nhật: thử các vị trí mặc định
  for (const base of [path.join(HOME, ".conda/envs"), path.join(HOME, "anaconda3/envs"), path.join(HOME, "miniconda3/envs")]) {
    const p = path.join(base, name);
    if (fs.existsSync(path.join(p, "bin/python"))) return p;
  }
  return null;
}

// Thư mục gốc của môi trường (null nếu chưa tạo hoặc không dùng môi trường).
async function envPrefix(project) {
  const env = project.env || { type: "none" };
  if (env.type === "conda") return condaPrefix(env.name);
  if (env.type === "venv" || env.type === "uv") {
    const p = path.resolve(project.path, env.path || ".venv");
    return fs.existsSync(path.join(p, "bin/python")) ? p : null;
  }
  return null;
}

async function processEnv(project) {
  const env = { ...process.env, PYTHONUNBUFFERED: "1", ...project.envVars };
  const prefix = await envPrefix(project);
  if (prefix) {
    env.PATH = `${path.join(prefix, "bin")}:${env.PATH}`;
    if (project.env.type === "conda") {
      env.CONDA_PREFIX = prefix;
      env.CONDA_DEFAULT_ENV = path.basename(prefix);
    } else {
      env.VIRTUAL_ENV = prefix;
    }
    delete env.PYTHONHOME;
  }
  return env;
}

async function status(project) {
  const env = project.env || { type: "none" };
  if (env.type === "none") return { type: "none", exists: false };
  const prefix = await envPrefix(project);
  const out = {
    type: env.type,
    exists: Boolean(prefix),
    prefix,
    target: env.type === "conda" ? env.name : path.resolve(project.path, env.path || ".venv"),
  };
  if (prefix) {
    const r = await run(path.join(prefix, "bin/python"), ["--version"]);
    out.pythonVersion = (r.stdout || r.stderr).trim();
    out.hasPip = fs.existsSync(path.join(prefix, "bin/pip"));
  }
  return out;
}

// Lệnh tạo môi trường, trả về argv (không qua shell).
function createArgv(project, settings) {
  const env = project.env;
  const ver = env.python;
  if (env.type === "conda") {
    if (!env.name) throw new Error("Conda env name is not set");
    return ["conda", "create", "-y", "-n", env.name, `python${ver ? "=" + ver : ""}`, "pip"];
  }
  if (env.type === "venv") {
    const py = ver ? `python${ver}` : settings.python || "python3";
    return [py, "-m", "venv", path.resolve(project.path, env.path || ".venv")];
  }
  if (env.type === "uv") {
    const argv = ["uv", "venv", path.resolve(project.path, env.path || ".venv")];
    if (ver) argv.push("--python", ver);
    return argv;
  }
  throw new Error("No env type selected for this project");
}

function removeArgv(project) {
  const env = project.env;
  if (env.type === "conda") return ["conda", "env", "remove", "-y", "-n", env.name];
  if (env.type === "venv" || env.type === "uv") {
    const target = path.resolve(project.path, env.path || ".venv");
    // Chỉ xoá thư mục venv thật nằm trong dự án
    if (!target.startsWith(project.path + path.sep)) throw new Error("Only venvs inside the project folder can be deleted");
    if (!fs.existsSync(path.join(target, "pyvenv.cfg"))) throw new Error("Not a virtualenv folder (pyvenv.cfg missing)");
    return ["rm", "-rf", "--", target];
  }
  throw new Error("This project has no env");
}

// Các venv có sẵn trong dự án: thư mục chứa pyvenv.cfg, sâu tối đa 2 cấp (vd. .venv, backend/.venv).
const SCAN_SKIP = new Set(["node_modules", ".git", "__pycache__", ".cache", ".next", "dist", "build", "logs", ".mypy_cache", ".pytest_cache", ".ruff_cache"]);
function scanVenvs(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (!d.isDirectory() || SCAN_SKIP.has(d.name)) continue;
      const full = path.join(dir, d.name);
      let cfg = null;
      try {
        cfg = fs.readFileSync(path.join(full, "pyvenv.cfg"), "utf8");
      } catch {}
      if (cfg !== null) {
        if (!fs.existsSync(path.join(full, "bin/python"))) continue;
        const version = cfg.match(/^\s*version(?:_info)?\s*=\s*(\S+)/m)?.[1] || "";
        out.push({ path: path.relative(root, full), python: version, kind: /^\s*uv\s*=/m.test(cfg) ? "uv" : "venv" });
      } else if (depth < 2) walk(full, depth + 1);
    }
  };
  walk(root, 1);
  return out.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
}

// Biến môi trường để shell của terminal kích hoạt env của dự án sau khi nạp rc của người dùng
// (shell-integration/activate.sh). Shell khác bash/zsh không có hook: chèn thẳng bin/ vào PATH.
async function terminalEnv(project, shellName) {
  const prefix = await envPrefix(project);
  if (!prefix) return {};
  const conda = project.env.type === "conda";
  if (shellName === "bash" || shellName === "zsh") {
    const out = { DASH_PYENV: prefix, DASH_PYENV_KIND: conda ? "conda" : "venv" };
    const bin = conda && which("conda");
    if (bin) {
      // conda nằm ở <base>/bin/conda hoặc <base>/condabin/conda
      const sh = path.resolve(fs.realpathSync(bin), "../../etc/profile.d/conda.sh");
      if (fs.existsSync(sh)) out.DASH_CONDA_SH = sh;
    }
    return out;
  }
  const out = { PATH: `${path.join(prefix, "bin")}:${process.env.PATH}` };
  if (conda) Object.assign(out, { CONDA_PREFIX: prefix, CONDA_DEFAULT_ENV: path.basename(prefix) });
  else out.VIRTUAL_ENV = prefix;
  return out;
}

function invalidateConda() {
  condaCache.at = 0;
}

module.exports = { run, which, condaEnvs, envPrefix, processEnv, status, createArgv, removeArgv, invalidateConda, scanVenvs, terminalEnv };
