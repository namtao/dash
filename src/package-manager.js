// Quản lý thư viện: Python (pip / uv pip trong môi trường ảo) và Node (npm, yarn, pnpm, bun).
// Tìm kiếm: npm registry search API; PyPI dùng danh sách tên từ Simple API (cache 7 ngày) + JSON API.
const fs = require("fs");
const path = require("path");
const store = require("./store");
const pyenv = require("./python-env");

const CACHE_DIR = path.join(store.ROOT, ".cache");
const PYPI_INDEX = path.join(CACHE_DIR, "pypi-names.json");
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "env", "__pycache__", "dist", "build", ".next", ".cache", "logs"]);
const SPEC_RE = /^[A-Za-z0-9@][A-Za-z0-9@._/\-\[\],<>=!~^*+:]*$/;
const NAME_RE = /^@?[A-Za-z0-9][A-Za-z0-9@._/\-]*$/;

const exists = (...p) => fs.existsSync(path.join(...p));

function nodeManager(dir) {
  if (exists(dir, "pnpm-lock.yaml")) return "pnpm";
  if (exists(dir, "yarn.lock")) return "yarn";
  if (exists(dir, "bun.lockb") || exists(dir, "bun.lock")) return "bun";
  return "npm";
}

function pythonFiles(dir) {
  return fs.readdirSync(dir).filter((f) => /^requirements.*\.txt$/.test(f) || f === "pyproject.toml" || f === "setup.py");
}

// Các bộ thư viện trong dự án: thư mục gốc và thư mục con cấp 1 (vd backend/, frontend/).
function manifests(project) {
  const out = [];
  const dirs = ["."];
  try {
    for (const d of fs.readdirSync(project.path, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name)) dirs.push(d.name);
    }
  } catch {
    return out;
  }
  for (const rel of dirs) {
    const dir = path.join(project.path, rel);
    let py = [];
    try {
      py = pythonFiles(dir);
    } catch {}
    if (py.length) out.push({ id: `python:${rel}`, kind: "python", dir: rel, manager: project.env?.type === "uv" ? "uv" : "pip", files: py });
    if (exists(dir, "package.json")) out.push({ id: `node:${rel}`, kind: "node", dir: rel, manager: nodeManager(dir), files: ["package.json"] });
  }
  if (!out.some((m) => m.kind === "python") && project.env?.type !== "none") {
    out.unshift({ id: "python:.", kind: "python", dir: ".", manager: project.env.type === "uv" ? "uv" : "pip", files: [] });
  }
  return out;
}

function findManifest(project, id) {
  const m = manifests(project).find((x) => x.id === id);
  if (!m) throw Object.assign(new Error("Manifest not found (requirements.txt / package.json)"), { status: 404 });
  return m;
}

async function pythonTool(project) {
  const prefix = await pyenv.envPrefix(project);
  if (!prefix) throw new Error("This project has no Python env yet (create one in the Env tab)");
  const py = path.join(prefix, "bin/python");
  const usePip = fs.existsSync(path.join(prefix, "bin/pip"));
  if (!usePip && !pyenv.which("uv")) throw new Error("The env has no pip and uv is not installed");
  // argv cho "pip <args>" theo đúng công cụ của môi trường
  const pip = (args) => (usePip ? [py, "-m", "pip", ...args, "--disable-pip-version-check"] : ["uv", "pip", ...args, "--python", py]);
  pip.usePip = usePip;
  return pip;
}

const normName = (n) => String(n).toLowerCase().replace(/[-_.]+/g, "-");

function declaredPython(dir) {
  const names = new Set();
  for (const f of ["requirements.txt"]) {
    try {
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        const m = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
        if (m && !line.trim().startsWith("#")) names.add(normName(m[1]));
      }
    } catch {}
  }
  try {
    const toml = fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8");
    const block = toml.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
    for (const m of (block?.[1] || "").matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.add(normName(m[1]));
  } catch {}
  return names;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function list(project, manifestId) {
  const m = findManifest(project, manifestId);
  const dir = path.join(project.path, m.dir);
  if (m.kind === "python") {
    const pip = await pythonTool(project);
    const argv = pip(["list", "--format=json"]);
    const r = await pyenv.run(argv[0], argv.slice(1), { cwd: dir, timeout: 60000 });
    if (!r.ok) throw new Error(r.stderr.trim() || "Could not list packages");
    const declared = declaredPython(dir);
    return JSON.parse(r.stdout).map((p) => ({ name: p.name, version: p.version, direct: declared.has(normName(p.name)) }));
  }
  const pkg = readJson(path.join(dir, "package.json")) || {};
  const rows = [];
  for (const [field, dev] of [["dependencies", false], ["devDependencies", true]]) {
    for (const [name, wanted] of Object.entries(pkg[field] || {})) {
      const installed = readJson(path.join(dir, "node_modules", name, "package.json"));
      rows.push({ name, wanted, version: installed?.version || null, dev, direct: true });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]).catch(() => null);
      }
    })
  );
  return out;
}

async function getJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeout || 15000), headers: opts.headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// { name: latestVersion }
async function outdated(project, manifestId) {
  const m = findManifest(project, manifestId);
  const dir = path.join(project.path, m.dir);
  if (m.kind === "python") {
    const pip = await pythonTool(project);
    const argv = pip(["list", "--outdated", "--format=json"]);
    const r = await pyenv.run(argv[0], argv.slice(1), { cwd: dir, timeout: 180000 });
    if (!r.ok) throw new Error(r.stderr.trim() || "Could not check for outdated packages");
    return Object.fromEntries(JSON.parse(r.stdout).map((p) => [p.name, p.latest_version]));
  }
  const rows = await list(project, manifestId);
  const latest = await mapLimit(rows, 8, (row) => getJson(`https://registry.npmjs.org/${row.name.replace("/", "%2F")}/latest`));
  const out = {};
  rows.forEach((row, i) => {
    if (latest[i]?.version && latest[i].version !== row.version) out[row.name] = latest[i].version;
  });
  return out;
}

function nodeArgv(manager, action, spec, dev) {
  const devFlag = { npm: "--save-dev", yarn: "-D", pnpm: "-D", bun: "-d" }[manager];
  const add = manager === "npm" ? "install" : "add";
  const remove = { npm: "uninstall", yarn: "remove", pnpm: "remove", bun: "remove" }[manager];
  if (action === "add") return [manager, add, ...(dev ? [devFlag] : []), spec];
  if (action === "upgrade") return [manager, add, ...(dev ? [devFlag] : []), `${spec}@latest`];
  if (action === "remove") return [manager, remove, spec];
  if (action === "install") return [manager, "install"];
  throw new Error("Invalid action");
}

// Trả về { label, argv, cwd, after } để chạy như tác vụ của dự án.
async function buildAction(project, { manifest: manifestId, action, spec, dev, saveRequirements }) {
  const m = findManifest(project, manifestId);
  const cwd = m.dir;
  if (action !== "install") {
    const re = action === "add" ? SPEC_RE : NAME_RE;
    if (!spec || spec.length > 200 || !re.test(spec)) throw new Error("Invalid package name/version");
  }
  const verb = { add: "Install", remove: "Uninstall", upgrade: "Upgrade", install: "Install" }[action];
  if (m.kind === "node") return { label: `${verb} ${spec || "packages"} (${m.manager})`, argv: nodeArgv(m.manager, action, spec, dev), cwd };

  const pip = await pythonTool(project);
  const dir = path.join(project.path, m.dir);
  let args;
  if (action === "add") args = ["install", spec];
  else if (action === "upgrade") args = ["install", "-U", spec];
  else if (action === "remove") args = pip.usePip ? ["uninstall", "-y", spec] : ["uninstall", spec];
  else if (action === "install") {
    if (exists(dir, "requirements.txt")) args = ["install", "-r", "requirements.txt"];
    else if (exists(dir, "pyproject.toml") || exists(dir, "setup.py")) args = ["install", "-e", "."];
    else throw new Error("No requirements.txt or pyproject.toml to install from");
  } else throw new Error("Invalid action");
  const reqFile = path.join(dir, "requirements.txt");
  const after = saveRequirements && (action === "add" || action === "remove") ? () => syncRequirements(reqFile, action, spec) : null;
  return { label: `${verb} ${spec || "packages"} (${m.manager})`, argv: pip(args), cwd, after };
}

// Ghi/xoá dòng tương ứng trong requirements.txt sau khi cài/gỡ thành công.
function syncRequirements(file, action, spec) {
  const name = normName(spec.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0] || spec);
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {}
  const lineName = (l) => normName(l.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1] || "");
  if (action === "remove") lines = lines.filter((l) => l.trim().startsWith("#") || lineName(l) !== name);
  else {
    lines = lines.filter((l) => l.trim().startsWith("#") || lineName(l) !== name || !l.trim());
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(spec);
  }
  fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
  return `requirements.txt: ${action === "remove" ? "removed" : "added"} ${spec}`;
}

// ---------- Tìm kiếm ----------

let pypiNames = null;

async function loadPypiNames() {
  if (pypiNames) return pypiNames;
  try {
    const st = fs.statSync(PYPI_INDEX);
    if (Date.now() - st.mtimeMs < 7 * 86400000) return (pypiNames = JSON.parse(fs.readFileSync(PYPI_INDEX, "utf8")));
  } catch {}
  const data = await getJson("https://pypi.org/simple/", { timeout: 120000, headers: { Accept: "application/vnd.pypi.simple.v1+json" } });
  pypiNames = data.projects.map((p) => p.name);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(PYPI_INDEX, JSON.stringify(pypiNames));
  return pypiNames;
}

async function searchPypi(q) {
  const needle = normName(q);
  let candidates = [];
  try {
    const names = await loadPypiNames();
    const scored = [];
    for (const name of names) {
      const n = normName(name);
      const rank = n === needle ? 0 : n.startsWith(needle) ? 1 : n.includes(needle) ? 2 : -1;
      if (rank >= 0) scored.push([rank, n.length, name]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    candidates = scored.slice(0, 15).map((s) => s[2]);
  } catch {
    candidates = [q]; // không tải được danh sách: chỉ tra đúng tên
  }
  const infos = await mapLimit(candidates, 8, (name) => getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`));
  return infos.filter(Boolean).map(({ info }) => ({
    name: info.name,
    version: info.version,
    description: info.summary || "",
    homepage: info.home_page || info.project_urls?.Homepage || `https://pypi.org/project/${info.name}/`,
  }));
}

async function searchNpm(q) {
  const data = await getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=20`);
  return data.objects.map(({ package: p, downloads }) => ({
    name: p.name,
    version: p.version,
    description: p.description || "",
    homepage: p.links?.homepage || p.links?.npm || `https://www.npmjs.com/package/${p.name}`,
    downloads: downloads?.weekly ?? null,
  }));
}

function search(registry, q) {
  q = String(q || "").trim();
  if (!q) return [];
  return registry === "npm" ? searchNpm(q) : searchPypi(q);
}

module.exports = { manifests, list, outdated, buildAction, search };
