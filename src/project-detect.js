// Nhận diện loại dự án trong một thư mục và gợi ý lệnh chạy, môi trường ảo.
const fs = require("fs");
const path = require("path");
const pyenv = require("./python-env");

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const has = (dir, f) => fs.existsSync(path.join(dir, f));

function guessPort(text, fallback) {
  const m = text.match(/port\s*[=:]\s*(?:int\([^)]*?,\s*)?["']?(\d{4,5})/i);
  return m ? Number(m[1]) : fallback;
}

function detectPython(dir, rel, base) {
  const files = ["requirements.txt", "pyproject.toml", "setup.py", "manage.py", "app.py", "main.py", "server.py"].filter((f) => has(dir, f));
  if (!files.length) return null;
  const deps = (read(path.join(dir, "requirements.txt")) + read(path.join(dir, "pyproject.toml"))).toLowerCase();
  const cwd = rel === "." ? "" : rel;
  const out = { kind: "python", frameworks: [], commands: [] };
  const entry = ["app.py", "main.py", "server.py", "app/main.py", "src/main.py"].find((f) => has(dir, f));
  const entryText = entry ? read(path.join(dir, entry)) : "";
  const mod = entry ? entry.replace(/\.py$/, "").replace("/", ".") : "app";

  if (has(dir, "manage.py") || deps.includes("django")) {
    out.frameworks.push("Django");
    out.commands.push({ name: `Django dev${base}`, cmd: "python manage.py runserver 8000", cwd, background: true, port: 8000 });
    out.commands.push({ name: `Migrate${base}`, cmd: "python manage.py migrate", cwd });
  } else if (deps.includes("fastapi") || /FastAPI\(/.test(entryText)) {
    out.frameworks.push("FastAPI");
    const appVar = entryText.match(/^(\w+)\s*=\s*FastAPI\(/m)?.[1] || "app";
    const port = guessPort(entryText, 8000);
    out.commands.push({ name: `Uvicorn dev${base}`, cmd: `uvicorn ${mod}:${appVar} --reload --port ${port}`, cwd, background: true, port });
  } else if (deps.includes("flask") || /Flask\(/.test(entryText)) {
    out.frameworks.push("Flask");
    const port = guessPort(entryText, 5000);
    const cmd = /__main__/.test(entryText) ? `python ${entry}` : `flask --app ${mod} run --debug --port ${port}`;
    out.commands.push({ name: `Flask dev${base}`, cmd, cwd, background: true, port });
  } else if (deps.includes("streamlit")) {
    out.frameworks.push("Streamlit");
    out.commands.push({ name: `Streamlit${base}`, cmd: `streamlit run ${entry || "app.py"} --server.port 8501`, cwd, background: true, port: 8501 });
  } else if (entry) {
    out.commands.push({ name: `Run ${entry}${base}`, cmd: `python ${entry}`, cwd, background: /__main__/.test(entryText) && /\.run\(|serve|loop/.test(entryText) });
  }
  if (deps.includes("gunicorn") && !out.frameworks.includes("FastAPI")) out.frameworks.push("Gunicorn");
  if (has(dir, "requirements.txt")) out.commands.push({ name: `Install packages${base}`, cmd: "pip install -r requirements.txt", cwd });
  else if (has(dir, "pyproject.toml")) out.commands.push({ name: `Install packages${base}`, cmd: "pip install -e .", cwd });
  if (deps.includes("pytest") || fs.existsSync(path.join(dir, "tests"))) out.commands.push({ name: `Test${base}`, cmd: "python -m pytest -q", cwd });
  return out;
}

const NODE_FRAMEWORKS = [
  ["next", "Next.js", 3000],
  ["nuxt", "Nuxt", 3000],
  ["@sveltejs/kit", "SvelteKit", 5173],
  ["@angular/core", "Angular", 4200],
  ["react-scripts", "Create React App", 3000],
  ["vite", "Vite", 5173],
  ["react", "React", null],
  ["vue", "Vue", null],
  ["svelte", "Svelte", null],
  ["@nestjs/core", "NestJS", 3000],
  ["express", "Express", 3000],
  ["fastify", "Fastify", 3000],
  ["electron", "Electron", null],
];

function detectNode(dir, rel, base) {
  if (!has(dir, "package.json")) return null;
  let pkg = {};
  try {
    pkg = JSON.parse(read(path.join(dir, "package.json")));
  } catch {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const manager = has(dir, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : has(dir, "bun.lockb") || has(dir, "bun.lock") ? "bun" : "npm";
  const runPrefix = manager === "npm" ? "npm run" : manager;
  const out = { kind: "node", manager, frameworks: [], commands: [] };
  let port = null;
  for (const [dep, label, p] of NODE_FRAMEWORKS) {
    if (deps[dep]) {
      out.frameworks.push(label);
      port = port || p;
    }
  }
  const cwd = rel === "." ? "" : rel;
  const scripts = pkg.scripts || {};
  out.commands.push({ name: `Install packages${base}`, cmd: `${manager} install`, cwd });
  for (const name of ["dev", "start", "serve", "preview", "build", "test", "lint"]) {
    if (!scripts[name]) continue;
    const long = ["dev", "start", "serve", "preview"].includes(name);
    const p = long ? guessPort(scripts[name], name === "preview" && out.frameworks.includes("Vite") ? 4173 : port) : null;
    out.commands.push({ name: `${name}${base}`, cmd: `${runPrefix} ${name}`, cwd, background: long, port: p, url: p ? `http://localhost:${p}` : "" });
  }
  return out;
}

function detectOther(dir, rel, base) {
  const cwd = rel === "." ? "" : rel;
  const out = { frameworks: [], commands: [] };
  const compose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].find((f) => has(dir, f));
  if (compose) {
    out.frameworks.push("Docker Compose");
    out.commands.push({ name: `Docker up${base}`, cmd: "docker compose up -d", cwd, stopCmd: "docker compose down" });
    out.commands.push({ name: `Docker logs${base}`, cmd: "docker compose logs -f --tail 200", cwd, background: true });
  }
  if (has(dir, "go.mod")) {
    out.frameworks.push("Go");
    out.commands.push({ name: `Go run${base}`, cmd: "go run .", cwd, background: true });
  }
  if (has(dir, "Cargo.toml")) {
    out.frameworks.push("Rust");
    out.commands.push({ name: `Cargo run${base}`, cmd: "cargo run", cwd, background: true });
  }
  if (has(dir, "CMakeLists.txt")) {
    out.frameworks.push("CMake");
    out.commands.push({ name: `CMake build${base}`, cmd: "cmake -B build && cmake --build build -j", cwd });
  }
  if (!out.commands.length && rel === "." && has(dir, "index.html")) {
    out.frameworks.push("Static");
    out.commands.push({ name: "Static server", cmd: "python3 -m http.server 8000", cwd, background: true, port: 8000, url: "http://localhost:8000" });
  }
  return out;
}

async function suggestEnv(dir, name) {
  for (const v of [".venv", "venv", "env"]) {
    if (has(dir, `${v}/pyvenv.cfg`)) return { type: "venv", path: v };
  }
  for (const sub of ["backend", "server", "api"]) {
    if (has(dir, `${sub}/.venv/pyvenv.cfg`)) return { type: "venv", path: `${sub}/.venv` };
  }
  const conda = await pyenv.condaEnvs();
  const hit = conda.find((e) => e.name === `.env-${name}` || e.name === name);
  if (hit) return { type: "conda", name: hit.name };
  return { type: pyenv.which("uv") ? "uv" : "venv", path: ".venv" };
}

async function detect(dir) {
  dir = path.resolve(dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("Folder not found");
  const name = path.basename(dir);
  const result = { name, path: dir, frameworks: [], kinds: [], commands: [], env: { type: "none" } };
  const subdirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !["node_modules", "venv", "env", "dist", "build", "logs", "docs", "plans"].includes(d.name))
    .map((d) => d.name);
  for (const rel of [".", ...subdirs]) {
    const full = path.join(dir, rel);
    const base = rel === "." ? "" : ` (${rel})`;
    const parts = [detectPython(full, rel, base), detectNode(full, rel, base), rel === "." ? detectOther(full, rel, base) : null].filter(Boolean);
    for (const part of parts) {
      if (part.kind && !result.kinds.includes(part.kind)) result.kinds.push(part.kind);
      result.frameworks.push(...part.frameworks.filter((f) => !result.frameworks.includes(f)));
      result.commands.push(...part.commands);
    }
  }
  if (result.kinds.includes("python")) result.env = await suggestEnv(dir, name);
  const firstPort = result.commands.find((c) => c.port)?.port;
  if (firstPort) result.url = `http://localhost:${firstPort}`;
  result.tags = result.frameworks.slice(0, 4);
  return result;
}

// Quét các thư mục con của root, đánh dấu thư mục đã có trong cấu hình.
async function scan(root, knownPaths) {
  const out = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const full = path.join(root, d.name);
    try {
      const info = await detect(full);
      out.push({ name: d.name, path: full, frameworks: info.frameworks, kinds: info.kinds, commands: info.commands.length, added: knownPaths.has(full) });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { detect, scan };
