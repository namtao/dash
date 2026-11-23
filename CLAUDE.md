# Dash — rules for working in this repo

Dash is a local workspace (terminals, editor, git, Claude Code, databases, project dashboard) served by
`node server.js`. Plain Node + vanilla browser JS, no build step. See README.md for features and layout.

## Must follow

- **Open source repo.** Never commit personal data: real hosts/IPs, usernames, emails, home paths,
  passwords, tokens, company names. Use placeholders (`203.0.113.10`, `deploy`, `/home/me/...`).
  Before committing run: `git ls-files | xargs grep -nIE "<your-name>|@gmail|/home/<you>|100\.[0-9]+\."`.
- **Never commit** `projects.json`, `.dash-state.json`, `.dash-history.jsonl`, `logs/`, `.cache/`,
  `plans/`, exported `dash-config-*.json`. They are in `.gitignore`; keep it that way.
- **Secrets stay on the server.** DB passwords and the local-AI API key live only in `projects.json`
  (mode 600). `store.publicConfig()` and `store.exportConfig()` strip them; any new secret field must be
  stripped in both and preserved on save when the browser sends it empty.
- **Every state-changing request** needs the `X-Dash: 1` header (the `api()` helper adds it). New routes
  go through `route()` in `server.js`; a handler may write `res` itself (downloads, SSE) and return nothing.
- **No native browser dialogs.** Use `confirmDialog()` / `askDialog()` (app.js), `W.prompt()`,
  `W.confirm3()`. Toasts use the `#toasts` popover so they stay above open modals.
- **HTML from files is untrusted.** Markdown, docx and anything rendered as HTML goes through DOMPurify
  (`sanitize()` in explorer.js). `/api/files/raw` sends a `sandbox` CSP (except PDF). Dash can run shell
  commands, so script injection into its origin is remote code execution.
- **UI text is English.** Code comments follow the existing Vietnamese style.
- **Keep it vanilla.** No bundler, no framework. Browser libraries are served from `node_modules` via the
  `VENDOR` map in `server.js` and loaded lazily with `W.loadScript()`.
- **No runtime downloads of tools.** Formatters / linters run only if installed on the machine (ruff,
  shellcheck, yamllint…); otherwise use built-in fallbacks (`src/python-check.py`, `bash -n`, Monaco).
  Do not fetch them with `uvx` / `npx` from inside Dash.
- **Linux and macOS.** No `/proc`, `ss`, `xdg-open`, `systemctl` or GNU-only flags without a branch on
  `process.platform` (macOS: `ps`, `lsof`, `open`, launchd). Local paths come from `os.homedir()`, never a
  hard-coded `/home/...`.
- Run `npm run check` (syntax check of all JS) before finishing any change.

## Architecture notes

- `/` is `shell.html` (project tabs); each tab is an iframe of `index.html?w=<project id>` with its own
  workbench. Per-window browser state uses `store.get/set` keys listed in `SCOPED` (core.js).
- Remote folders and projects use paths `ssh://<ssh profile id>/abs/path`. `src/files.js` routes them to
  `src/remote.js` (ssh exec with ControlMaster, `BatchMode=yes`, so key/agent auth only). `src/git.js` runs
  git over the same ssh for remote dirs (`root()` returns `ssh://<id>/top`). Claude only works on local
  folders; guard new features with `W.isRemote()` / `remote.isRemote()`.
- Remote project commands run through `ssh -tt` in `process-runner.js`; Env / Packages / Auto-detect are
  hidden for remote projects.
- Port forwards (`src/ssh-forward.js`) are child `ssh -N -L` processes stopped on shutdown.
- Local AI (`src/local-ai.js`) proxies an OpenAI-compatible server (Ollama, LM Studio…); chat streams as SSE.

## Common mistakes (seen before)

- **Monaco class collisions.** Monaco widgets use classes like `.main`, `.tree`, `.icon`. Global CSS for
  those names broke the suggestion list (items invisible). Scope app CSS (`main.main`, `.view-body .tree`,
  `.icon:not(.monaco-editor *)`) and never add bare global rules for generic class names.
- **UMD libraries + Monaco's AMD loader.** After Monaco loads, `define.amd` exists and UMD bundles register
  as AMD modules instead of globals. Always load browser libraries with `W.loadScript()`, which hides
  `define.amd` while loading.
- **The systemd service lacks the desktop session env.** `xdg-open` needs `DISPLAY`/`WAYLAND_DISPLAY`;
  `system-tools.js` reads them from `systemctl --user show-environment` at call time. Do the same for any
  new GUI launcher, and report the error instead of spawning with `stdio: "ignore"` and hoping.
- **The running service caches `projects.json`.** Editing the file while Dash runs is overwritten on the
  next save. Change config through the API, or stop the service first. New top-level config sections are
  dropped by an older running server, so restart after adding one.
- **Auto save is on by default.** Tests that type into a real file through the UI will write it to disk.
  Use files in a temp folder for UI tests.
- **Testing without touching the user's instance:** run a second server with
  `DASH_CONFIG=<copy of projects.json> DASH_STATE=<tmp file> PORT=8898 DASH_NO_AUTOSTART=1 node server.js`.
  It still shares `logs/`; delete any test log folders afterwards.
- `W.showPanel()` / `W.showView()` turn the panel / side bar on. If startup must keep them hidden, reset the
  layout flag after calling them.
