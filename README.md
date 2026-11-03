# Dash

A local workspace for the projects on this machine, meant to replace a separate terminal emulator and editor for daily work. It provides:

- real terminals running your own shell, with SSH profiles, port forwarding, saved commands and per-folder command history;
- a file explorer and editor that also opens folders on SSH machines, with viewers for images, PDF, CSV, Word, Excel and Markdown;
- Source Control with side-by-side git diffs and commit messages written by a local AI;
- Claude Code chat that shows your 5-hour and weekly usage limits and keeps Claude Code up to date;
- a chat with a local AI model (Ollama, LM Studio or any OpenAI-compatible server);
- a database client for PostgreSQL, MySQL/MariaDB, SQL Server and SQLite, with backup and restore;
- the project dashboard: commands, processes, logs, Python envs and packages, for local and SSH projects.

It works on phones too: the side bar and Claude open as overlays and the activity bar moves to the bottom.

The layout follows VS Code, and the dark theme is One Dark Pro Darker.

## Install and run

```bash
npm install
node server.js                     # http://127.0.0.1:8899
PORT=9000 node server.js
```

Dash runs on Linux and macOS and requires Node ≥ 22.5 (for `node:sqlite`). `npm install` builds `node-pty`: on Linux install `gcc`, `make` and `python3`; on macOS run `xcode-select --install` once. Windows is not supported (Dash relies on POSIX process groups, `bash` and `ssh` ControlMaster). On first run Dash creates an empty `projects.json`. Add projects with **＋** or **Scan** in the Projects view.

### Run with the system (systemd on Linux, launchd on macOS)

```bash
npm run service:install            # writes ~/.config/systemd/user/dash.service, enables and starts it
systemctl --user status dash
journalctl --user -u dash -f       # server log
systemctl --user restart dash
npm run service:uninstall
```

On macOS the same script writes `~/Library/LaunchAgents/local.dash.plist` and loads it with `launchctl`. The server log goes to `logs/dash-service.log`; restart with `launchctl kickstart -k gui/$(id -u)/local.dash`.

The service starts when you log in and restarts itself if it crashes. It uses the `PATH` of the shell where you ran the install script, so project commands can find conda, uv, npm and other tools. On Linux, to start Dash at boot without logging in, run `loginctl enable-linger $USER` once.

If Dash is already running elsewhere, for example in tmux, stop that copy first. Otherwise the port is taken and the install script only prints the command to start the service.

Stopping Dash stops foreground commands and closes all terminals. **Background** commands keep running and are adopted again the next time Dash starts; their stats line shows `adopted`. The service uses `KillMode=process` (systemd) or `AbandonProcessGroup` (launchd), so a restart does not kill them.

Install Dash as an app from the browser menu (**Install** / **Open as window**) to get its own window and free a few shortcuts that browser tabs reserve.

## Layout

| Area | Contents |
|------|----------|
| Title bar | Project tabs, current folder (click to switch: project, recent folder or any path), Go to file / commands, toggles for side bar, panel and Claude, theme |
| Activity bar (left) | Projects, Explorer, Source Control, Terminals, SSH, Saved commands, Database, Claude, Local AI, Settings |
| Editor tabs | Overview / project details, files, diffs, SQL queries, Settings. Tabs reopen after a reload, can be reordered by dragging and closed with a middle click. Unsaved tabs show ● and ask before closing. |
| Panel (bottom) | Terminal, Problems, History, Output (backup/restore logs). Hidden when the page opens; it appears when you open a terminal. |
| Claude (right) | Claude Code conversations |
| Status bar | Git branch; problems in the open file; coin prices; Claude 5h / week usage; read-only flag and size of the open file; number of terminals |

The **current folder** is shared within a window: Explorer, Source Control, History, new terminals and new Claude conversations all use it.

**One tab per project.** The title bar holds project tabs, like VS Code windows inside one page. **Overview** is always first. Clicking a project opens its tab, or switches to it if it is already open, so a project never opens twice. Each project tab is its own workbench (`/index.html?w=<project id>` in a frame), with separate editor tabs, layout, current folder, terminals and Claude conversations. Switching tabs keeps everything running. Closing a project tab (✕ or middle click) asks first and then closes that project's terminals and Claude conversations. Use Ctrl+Shift+PageDown / PageUp to move between project tabs and Ctrl+Alt+P to pick a project. The open tabs are restored when you reload `/`.

## Features

### Terminal
- Each terminal is a PTY running your shell (`zsh -l` by default), so your prompt, plugins, aliases, autosuggestions, colors and atuin work as usual.
- Terminals keep running when the page reloads and are reattached with their recent output, as in tmux.
- Tabs on the right of the panel. Split right or down, rename (double-click or F2), kill.
- Copy on select, right click copies the selection or pastes when nothing is selected, and Ctrl+Shift+C / Ctrl+Shift+V copy and paste. Pasting a dangerous command (`rm -rf`, `git reset --hard`, `docker system prune`…) asks first. These match WezTerm and can be switched off in Settings.
- Find in the scrollback (Ctrl+Shift+F), font size (Ctrl+= / Ctrl+- / Ctrl+0), clickable links.

### Command history per folder
- Dash loads a small hook with your zsh or bash config (`shell-integration/`). The hook reports every command, its exit code and the folder it ran in.
- The **History** panel shows commands for this folder, this folder plus its subfolders, or every folder, with search and a "unique" toggle.
- Click a command to type it into the terminal, or click ▶ to run it. **Alt+R** opens a quick picker for the current folder, and **Alt+Shift+R** opens one for all folders.
- Commands that start with a space are not recorded. History is stored in `.dash-history.jsonl`.

### SSH
- Profiles have a label, host, user, port, an optional identity file, a remote folder to open and extra ssh arguments. They are saved in `projects.json`.
- Each profile shows a ROOT / LAN / VPN / CLOUD / WAN tag, as WezTerm does.
- Double-click a profile or press **Alt+S** to connect in a new terminal tab.
- **Open folder** shows a folder of that machine in the Explorer (`ssh://<profile>/path`). Files open, save, rename and delete over SSH, and new terminals start in that folder. Source Control runs git on that machine over SSH (pull/push use its git credentials); Claude works on local folders only.
- **Port forwarding** runs `ssh -N -L 127.0.0.1:<local>:<host>:<remote>`. Forwards can be saved in the profile and started or stopped with one click; running forwards are listed under the profile, and they stop when Dash stops.
- Passwords are not stored. Terminals can ask for one, but folders, remote projects and port forwards need a key or ssh-agent (they run ssh with `BatchMode=yes`).

### Saved commands
- Like WezTerm's quick commands: each command has a name, group, operating system, description and one or more lines.
- Click a command to type it into the terminal, or ▶ to run it. **Alt+Q** opens a quick picker. Add, edit, duplicate and delete them in the Saved commands view.

### Explorer and editor
- Folder tree with git status colors, new / rename / delete, open a terminal here, copy path.
- File and folder icons come from **Atom Material Icons** (the `a-file-icon-vscode` VS Code icon theme, MIT license), copied into `public/icons/atom/`. Run `node scripts/sync-icons.js` to refresh them from the installed VS Code extension.
- **Ctrl+P** opens a file by name.
- Files open in Monaco (the VS Code editor). **Auto save** is on by default (1 s after you stop typing; change it in Settings). Ctrl+S saves too. If the file changed on disk since you opened it, Dash asks before overwriting, and auto save pauses for that file.
- **Viewers**: images, PDF, CSV/TSV (as a table), Word `.docx` and Excel `.xlsx` (one tab per sheet). CSV and SVG can also be edited as text. Markdown files have a live **Preview** beside the editor (Ctrl+Shift+V). HTML from Markdown and Word files is sanitized.
- **Format** (Shift+Alt+F): built in for JSON, CSS, HTML, JavaScript and TypeScript; prettier for YAML, Markdown, GraphQL, SCSS and Less; sql-formatter for SQL; and, when installed, ruff or black (Python), shfmt (shell), gofmt, rustfmt, clang-format, stylua and taplo.
- **Problems**: JavaScript and TypeScript are type-checked as in VS Code (undefined names, wrong types, wrong arguments; missing modules are ignored because the editor does not read `node_modules`), and JSON, CSS and HTML are validated. Python is checked for syntax errors, undefined names and unused imports with the standard library (`src/python-check.py`); shell with `bash -n`, YAML with prettier's parser, Go with `gofmt -e`. When ruff, shellcheck or yamllint are installed (e.g. `sudo pacman -S ruff shellcheck yamllint`), Dash uses them instead for many more rules. Errors are underlined in the editor, and the **Problems** tab in the bottom panel (Ctrl+Shift+M, or click the ⊗ ⚠ counter in the status bar) lists them for every open file; click one to jump to its line and column. F8 jumps to the next problem.
- **Read-only**: the lock in the editor bar, the status bar or the Explorer menu makes a file read-only, as the VS Code "read-only" extensions do. Dash remembers it per file.
- The status bar shows the size of the open file.
- **Generate file tree** (Explorer menu on a folder) produces a text tree you can copy, leaving out `.git`, `node_modules` and similar folders.

### Source Control
- Changes, staged changes and conflicts, each with stage, unstage and discard actions.
- Commit (Ctrl+Enter in the message box), commit all, amend, commit & push, pull, push, fetch, switch or create a branch, and the commit history with the files of each commit.
- Clicking a file opens a side-by-side diff (or inline) with next/previous change. In the working-tree diff the right side is editable, and Ctrl+S saves it to the file.
- The ✦ button in the message box (Ctrl+Alt+M) asks the local AI for a Conventional Commits message, from the staged changes or, when nothing is staged, from all changes.

### Claude Code
- Uses your installed `claude` CLI and its login through the Claude Agent SDK, with your CLAUDE.md, settings, skills and MCP servers.
- Several conversations at once. Resume past conversations of the current folder.
- Choose the model and the permission mode (ask before edits, accept edits, plan, auto, bypass).
- Replies stream in. Tool calls and thinking are collapsed to one line; click a line to see the command (IN), its output (OUT) or the diff. Edit and Write can open their diff in the diff editor. Long code wraps.
- Permission requests can be allowed, always allowed or denied (with a note to Claude). Claude's multiple-choice questions appear as a form.
- In the input: @ mentions files, / lists commands, pasted images are attached, ↑ recalls earlier prompts, and Esc stops Claude. Dash can tell Claude which file is open in the editor.
- **Updates**: with "Update Claude Code automatically" on (the default), Dash runs `claude update` a few minutes after it starts and then once a day. Settings → Claude Code updates shows the version and has an **Update now** button.
- **Usage limits**: the status bar and the top of the Claude panel show 5-hour and weekly utilization with their reset times. Dash reads them from the same endpoint as Claude Code's `/usage` command, using the OAuth token in `~/.claude/.credentials.json`. Reading them sends no prompt and uses no tokens. The server caches the result for `usageRefreshSec` seconds (default 60), and live values from running conversations update it in between. The token never reaches the browser.

### Coin prices
- The status bar shows the price in USDT and the change since 00:00 UTC for the coins you track, next to the Claude usage limits (green when up, red when down; hover for the list and the update time).
- Click it to add, rename or remove coins, and to pick the exchange (Binance, OKX, Bitget), the market (USDT perpetual futures or spot) and the refresh interval (default 15 seconds). A symbol the exchange does not list shows "Not listed".
- The server fetches the exchanges' public APIs (no API key) and caches the result, so many project tabs share one request. Saved in `projects.json` under `crypto`.

### Local AI
- Chat with a model on your machine in the Local AI view, right below Claude in the activity bar (Ctrl+Alt+I).
- Configure it like Cline's "OpenAI Compatible" provider in Settings → Local AI: base URL (Ollama `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`…), model ID and an optional API key. Dash calls the server from the backend, so the key never reaches the browser.

### Database
- Dash connects only when you open a connection in the tree, pick a database or run a query. Right-click a connection to **Disconnect**.
- Connections to PostgreSQL, MySQL/MariaDB, SQL Server and SQLite (`node:sqlite`). The tree shows databases, schemas, tables, views and columns, with 🔑 marking primary keys.
- SQL editor with One Dark colors and completion for keywords, functions, tables, columns and `alias.column`. Format with Shift+Alt+F. **Ctrl+Enter** runs the statement under the cursor or the selection, and **Ctrl+Shift+Enter** runs everything. Plain SELECTs are limited to `sqlRowLimit` rows.
- **Editable results**: double-clicking a table, or running a SELECT from one table that includes its primary key, gives an editable grid.
  - Edit a cell by double-clicking it or by typing. Add, duplicate or delete rows, or set NULL.
  - Changes are only highlighted until you press **Ctrl+S** or **Save**. Dash then writes them in one transaction by primary key and rolls everything back if a row no longer matches.
  - Running another query, switching connection or closing the tab with unsaved changes asks first.
- Copy a value, or a row as JSON, CSV or INSERT. Export the result as CSV.
- **Backup** and **Restore** are separate dialogs and run in the background; their log appears in the Output panel.
  - PostgreSQL: backup with `pg_dump` in custom or plain format. Restore with `pg_restore`, or `psql` for `.sql` files. Restore can first close connections, drop and recreate the database, and uses `--no-owner --no-privileges` and parallel jobs. Restoring requires typing the database name.
  - MySQL: `mysqldump`, then `mysql` to restore.
  - SQL Server: `BACKUP DATABASE` / `RESTORE DATABASE` with the file moved to the server's data folder. The file path is on the SQL Server host.
  - SQLite: `VACUUM INTO` to back up. Restore keeps the old file as `.before-restore`.
- Default backup folder: `~/Backups/dash`.
- Passwords are kept in `projects.json` (file mode 600). Command-line tools receive them through environment variables, and they are never sent to the browser.

### Projects (dashboard)
- **Commands**: each project has any number of commands (dev server, build, test, docker…). A command can set a working subfolder, port, URL, its own stop command, background mode, autostart and auto-restart on failure (at most 5 times per 60s).
- **Processes**: each command runs in its own process group, so Stop also stops child processes. Dash shows PID, uptime, CPU, memory and port status.
- **Logs**: live view with the program's ANSI colors, download and clear. Logs are stored in `logs/<project>/<command>.log` and rotate at 5 MB.
- **Quick shell**: runs a command in the project's folder and env inside a PTY, so `ls`, `git` and test runners print in color. The `$ command` line is highlighted like zsh.
- **Env, Packages, Project detection, Ports**: conda / venv / uv, pip / uv / npm / yarn / pnpm / bun, framework detection and the listening-ports table.
- **Python env picker**: the 🐍 item in the status bar (or *Select Python environment…* in the command palette) lists the venvs found in the project (up to two folders deep) and your conda envs. The chosen env is used by project commands, and every new bash or zsh terminal opened inside the project folder activates it after loading your rc file. Other shells get the env's `bin/` first on PATH. The terminal list shows the env each bash / zsh terminal is in, and it updates when you activate or deactivate an env by hand.
- Projects with running commands are listed first.
- **SSH projects**: in Add project, pick an SSH profile and enter the path on that machine. Commands run there through `ssh -tt`, Terminal opens an SSH shell in the folder, and Files opens the remote folder.
- Project buttons: **Terminal** (opens a Dash terminal in the project folder), **Files** (Explorer), **Claude**, and **Folder** (system file manager).

### Settings and shortcuts
Settings is an editor tab (Ctrl+,). It covers the shell, font, cursor, scrollback, copy/paste behavior, editor font, tab size, word wrap and auto save, the Claude default model, permission mode, effort, usage refresh and automatic updates, the local AI server, and the database row limit and backup folder. **Projects & server** (projects folder, Python for venvs, host, port) and **Edit JSON** are linked there.

**Export** downloads every setting as one JSON file (projects, commands, SSH profiles and forwards, database connections, saved commands, workspace options, shortcuts and local AI settings) with passwords and API keys left out. **Import** reads such a file and either merges it (adds only the items you do not have) or replaces everything; passwords and the API key you already saved are kept. Nothing is uploaded anywhere. When the file comes from a machine with another home folder (for example `/home/me` on Linux and `/Users/me` on macOS), local paths are moved to this machine's home folder; paths on SSH hosts stay as they are. A shell that does not exist on the new machine falls back to the default (`zsh`, then `$SHELL`, then `bash`). Database passwords, the AI key and Python environments must be set up again on the new machine.

In **Keyboard shortcuts** (Ctrl+Shift+H), click a shortcut and press new keys. Several shortcuts per command are allowed, and conflicts are reported. The defaults below follow WezTerm where possible:

| Action | Keys |
|--------|------|
| Command palette / Go to file | Ctrl+Shift+P / Ctrl+P |
| Open folder | Ctrl+Alt+O |
| Toggle side bar / panel / maximize panel | Ctrl+B / Ctrl+J / Ctrl+Alt+Enter |
| New terminal | Alt+T, Ctrl+Shift+` |
| Toggle / focus terminal | Ctrl+` |
| Split right / down | Alt+Enter, Ctrl+Shift+S / Alt+Shift+Enter, Ctrl+Shift+D |
| Kill pane | Alt+W |
| Next / previous terminal tab, tab 1–8 | Alt+Right / Alt+Left, Alt+1…8 |
| Focus next / previous pane | Ctrl+Alt+Arrows |
| SSH connect | Alt+S |
| Find in terminal, clear | Ctrl+Shift+F, Ctrl+Shift+K |
| Font size | Ctrl+= / Ctrl+- / Ctrl+0 |
| History picker (folder / all) / History panel | Alt+R / Alt+Shift+R / Alt+H |
| Explorer / Source Control / Database / SSH | Ctrl+Shift+E / Ctrl+Shift+G / Ctrl+Shift+Y / Ctrl+Shift+U |
| Claude panel / focus input / new conversation | Ctrl+Alt+B, Ctrl+Shift+L / Ctrl+Escape / Ctrl+Alt+N |
| Save, close tab, next/prev tab | Ctrl+S, Alt+Shift+W, Ctrl+PageDown / Ctrl+PageUp |
| Next / previous project tab, pick project | Ctrl+Shift+PageDown / Ctrl+Shift+PageUp, Ctrl+Alt+P |
| New SQL query | Ctrl+Alt+Q |
| Saved commands picker | Alt+Q |
| Local AI chat / AI commit message | Ctrl+Alt+I / Ctrl+Alt+M |
| Markdown preview, Problems panel, next problem | Ctrl+Shift+V, Ctrl+Shift+M, F8 |

When a terminal has focus, the shell keeps Ctrl+P, Ctrl+B, Ctrl+J, Ctrl+K and Ctrl+S, so those workbench shortcuts work only outside the terminal. Browsers do not let pages use Ctrl+T, Ctrl+W, Ctrl+N or Ctrl+Tab.

## `projects.json`

You normally don't edit this file by hand, because Dash writes everything you change in the UI. It is **not committed** (it is in `.gitignore`) and is written with mode 600. Set `DASH_CONFIG=/path/to/file.json` to keep it elsewhere.

```jsonc
{
  "settings": { "host": "127.0.0.1", "port": 8899, "python": "python3", "projectsRoot": "/home/me/Projects" },
  "workspace": {
    "shell": "/usr/bin/zsh",
    "fontFamily": "\"JetBrainsMono Nerd Font\", \"JetBrains Mono\", monospace",
    "fontSize": 13, "copyOnSelect": true, "rightClickPaste": true, "confirmDangerousPaste": true,
    "claudeModel": "", "claudePermissionMode": "default", "usageRefreshSec": 60,
    "sqlRowLimit": 500, "backupDir": "/home/me/Backups/dash",
    "autoSave": true, "autoSaveDelay": 1000, "claudeAutoUpdate": true,
    "keybindings": { "terminal.new": "Alt+T" }   // only the shortcuts you changed
  },
  "ai": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:7b", "apiKey": "" },
  "crypto": { "exchange": "binance", "market": "futures", "refreshSec": 15, "coins": ["BTC", "ETH"] },
  "snippets": [{ "id": "disk", "name": "Disk usage", "group": "System", "os": "linux", "description": "", "command": "df -h" }],
  "ssh": [{ "id": "web", "label": "Web server", "host": "203.0.113.10", "port": 22, "user": "deploy", "forwards": [{ "local": 15432, "host": "localhost", "remote": 5432 }] }],
  "databases": [{ "id": "local", "name": "local", "type": "postgres", "host": "localhost", "port": 5432, "user": "postgres", "password": "…", "database": "app" }],
  "projects": [
    {
      "id": "shop", "name": "shop", "path": "/home/me/Projects/shop", "tags": ["fastapi"], "url": "http://localhost:5173",
      "env": { "type": "venv", "path": "backend/.venv", "python": "3.12" },
      "envVars": { "DEBUG": "1" },
      "commands": [{ "id": "api", "name": "API", "cmd": "uvicorn app.main:app --reload --port 8000", "cwd": "backend", "background": true, "port": 8000 }]
    }
  ]
}
```

Other local files that are not committed:

| File | Contents |
|------|----------|
| `.dash-state.json` | PIDs of running commands |
| `.dash-history.jsonl` | Terminal command history |
| `logs/` | Command logs, and backup/restore logs in `logs/dash-db/` |
| `.cache/` | PyPI name index |

## Security

Dash runs arbitrary commands and opens shells, so by default it only listens on `127.0.0.1`. The server rejects requests whose Host header it doesn't recognize, which blocks DNS rebinding. Every state-changing request must carry the `X-Dash: 1` header, and the WebSocket (terminals, Claude) only accepts connections whose Origin is the Dash page itself, which blocks cross-site requests. Don't set `host` to `0.0.0.0` on an untrusted network.

## Structure

```text
server.js                 HTTP API, static files, SSE logs, WebSocket (terminals, Claude)
src/store.js              read/write and normalize projects.json
src/process-runner.js     start/stop/adopt processes, logs, auto-restart, background jobs
src/terminals.js          PTY terminals, replay buffer, OSC 633 command/cwd tracking
src/history.js            per-folder command history
src/files.js, src/git.js  explorer and source control
src/ssh-profiles.js       ssh command lines (terminal, exec, forward)
src/remote.js             files on SSH machines (ssh://<profile>/path)
src/ssh-forward.js        port forwarding processes
src/local-ai.js           OpenAI-compatible local AI proxy (chat stream, commit messages)
src/code-tools.js         external formatters and linters
src/claude-update.js      `claude update` on a schedule
src/claude.js             Claude Agent SDK sessions and usage limits
src/crypto-prices.js      coin prices for the status bar (Binance, OKX, Bitget public APIs)
src/db/                   drivers (postgres, mysql, mssql, sqlite), query/save, backup/restore
src/python-env.js, src/package-manager.js, src/project-detect.js, src/system-tools.js
shell-integration/        zsh/bash hooks loaded into Dash terminals
scripts/install-service.sh  systemd user service (Linux) / LaunchAgent (macOS)
scripts/sync-icons.js     copy Atom Material Icons from the VS Code extension
CLAUDE.md                 rules and known pitfalls for working on this repo
public/                   UI: shell.html + js/shell.js (project tabs), index.html workbench: app.js (dashboard), js/ (modules), style.css, workbench.css
```
