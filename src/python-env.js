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

function invalidateConda() {
  condaCache.at = 0;
}

module.exports = { run, which, condaEnvs, envPrefix, processEnv, status, createArgv, removeArgv, invalidateConda };
