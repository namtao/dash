# Dash

A local dashboard for managing the projects on this machine: run commands, processes (start/stop/restart, background), live logs, Python envs (conda / venv / uv) and packages (pip, uv, npm, yarn, pnpm, bun). Everything is configured in the UI and saved to a single JSON file.

It uses only built-in Node modules, so there is no `npm install`.

## Run

```bash
node server.js          # http://127.0.0.1:8899
PORT=9000 node server.js
```

Requires Node ≥ 20 and Linux (it uses `/proc`, `ss` and `ps`). On first run Dash creates an empty `projects.json`; add projects with **+ Add project** or **Scan**.

Stop Dash with Ctrl+C. Foreground commands are stopped with it. **Background** commands keep running and are re-adopted the next time Dash starts (their stats line shows `adopted`).

## Layout

One page. The left sidebar lists projects. The top of the right side always shows the stats and the **Running** table. Below that is the project grid, or, when a project is selected in the sidebar, that project's details (Commands, Env, Packages, Config). The ☾/☀ button in the top bar switches between light and dark themes; the choice is remembered per browser.

## Features

- **Commands**: each project has any number of commands (dev server, build, test, docker…). A command can set a working subfolder, port, URL, its own stop command (e.g. `docker compose down`), background mode, autostart when Dash starts, and auto-restart on failure (at most 5 times per 60s). Commands can be reordered with ↑/↓.
- **Processes**: every command runs in its own process group, so Stop also stops child processes (SIGTERM, then SIGKILL after 10s). Shows PID, uptime, CPU, memory and port status.
- **Logs**: live view with error/warning highlighting, download and clear. Logs live in `logs/<project>/<command>.log` and rotate at 5 MB.
- **Quick shell**: run any command in the project's folder and env (↑/↓ for history).
- **Env**: choose conda / venv / uv, create it, install packages from `requirements.txt` or `pyproject.toml`, delete it. Project commands run with the env's `bin/` first on PATH, so no `activate` is needed.
- **Packages**: list installed packages, check outdated, search PyPI/npm, install, uninstall, upgrade. For Python, installs/uninstalls can update `requirements.txt`. Projects with `backend/` and `frontend/` get a separate manifest for each.
- **Project detection**: Flask, FastAPI, Django, Streamlit, React/Vite, Next.js, Vue, Svelte, Angular, Express, NestJS, Docker Compose, Go, Rust, CMake, static sites. Dash suggests run commands and an env.
- **Ports**: lists listening ports, the owning process and matching project, and can kill the process holding a port.
- **Settings** (top bar): projects folder, Python used to create venvs, editor command, default terminal (a table of known terminals with editable command templates and install status), and Dash's host and port. **Edit JSON (advanced)** opens the raw config editor.
- Open a project in VS Code, the terminal or the file manager; see the git branch, number of changes and ahead/behind.

## `projects.json`

You normally don't edit this by hand: everything below can be changed in the UI and Dash writes the file. It is **not committed** (it is in `.gitignore`). Use `DASH_CONFIG=/path/to/file.json` to move it.

```jsonc
{
  "settings": {
    "host": "127.0.0.1",                    // listen on this machine only
    "port": 8899,
    "python": "python3",                    // interpreter used to create venvs
    "projectsRoot": "/home/me/Projects",    // default folder for Scan
    "editor": "code {dir}",
    "terminal": "wezterm start --cwd {dir}" // empty = auto-detect
  },
  "projects": [
    {
      "id": "shop",
      "name": "shop",
      "path": "/home/me/Projects/shop",
      "description": "",
      "tags": ["fastapi", "vite"],
      "url": "http://localhost:5173",
      "env": { "type": "venv", "path": "backend/.venv", "python": "3.12" }, // or {"type":"conda","name":"..."} / {"type":"uv","path":".venv"} / {"type":"none"}
      "envVars": { "DEBUG": "1" },
      "commands": [
        {
          "id": "api",
          "name": "API",
          "cmd": "uvicorn app.main:app --reload --port 8000",
          "cwd": "backend",
          "background": true,      // keeps running when Dash exits
          "port": 8000,
          "url": "http://localhost:8000/docs",
          "stopCmd": "",           // runs when Stop is clicked (e.g. "docker compose down")
          "autostart": false,
          "autoRestart": false
        }
      ]
    }
  ]
}
```

Other local files, also not committed: `.dash-state.json` (PIDs of running processes), `logs/`, and `.cache/` (the PyPI package name index used for search, refreshed every 7 days).

## Security

Dash can run arbitrary commands, so by default it only listens on `127.0.0.1`. The server rejects requests with an unknown Host header (DNS rebinding), and every state-changing request must carry the `X-Dash: 1` header (cross-site requests). Don't set `host` to `0.0.0.0` on an untrusted network.

## Structure

```text
server.js               HTTP server, API, SSE logs
src/store.js            read/write and normalize projects.json
src/process-runner.js   start/stop/adopt processes, logs, auto-restart
src/python-env.js       conda / venv / uv
src/package-manager.js  list, search, install, uninstall, upgrade packages
src/project-detect.js   framework detection, command suggestions
src/system-tools.js     ports, git, open editor/terminal
public/                 UI (plain HTML/CSS/JS)
```
