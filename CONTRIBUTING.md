# Contributing to Dash

Thanks for helping. Dash is a small project with a few firm rules, mostly because it can run shell
commands on the machine it serves: a bug in Dash can become remote code execution.

## Set up

```bash
git clone https://github.com/namtao/dash.git
cd dash
npm install            # builds node-pty: gcc/make/python3 on Linux, `xcode-select --install` on macOS
node server.js         # http://127.0.0.1:8899
```

Node ≥ 22.5 is required. Dash supports Linux and macOS only.

To test without touching your own Dash instance, run a second server on a copy of the config:

```bash
cp projects.json /tmp/dash-test.json
DASH_CONFIG=/tmp/dash-test.json DASH_STATE=/tmp/dash-test-state.json \
  PORT=8898 DASH_NO_AUTOSTART=1 node server.js
```

It still shares `logs/`, so delete any test log folders afterwards. Auto save is on by default: when you
test the editor through the UI, use files in a temp folder.

## Before you open a pull request

- Run `npm run check` (syntax check of every JS file). It must pass.
- Try the change in the browser, on a narrow (phone) window too if it touches layout.
- If you touched process, path or shell code, check it on both Linux and macOS, or say in the PR which one
  you could not test.
- Update `README.md` when user-visible behavior, settings or `projects.json` fields change.
- Keep the PR focused on one change. Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(explorer): …`, `fix(terminal): …`, `refactor: …`.

## Rules for the code

**Keep it vanilla.** Plain Node on the server and plain browser JavaScript, with no bundler, framework or
build step. Browser libraries come from `node_modules` through the `VENDOR` map in `server.js` and are
loaded lazily with `W.loadScript()` (which also hides Monaco's AMD loader while the library loads).

**Security.**

- Every state-changing request needs the `X-Dash: 1` header. The `api()` helper in the browser adds it.
  New routes go through `route()` in `server.js`.
- HTML that comes from files (Markdown, docx, previews) is untrusted. Sanitize it with DOMPurify
  (`sanitize()` in `explorer.js`). Never insert file content with `innerHTML` unsanitized.
- Secrets (database passwords, the local AI API key) stay on the server in `projects.json`.
  A new secret field must be stripped in both `store.publicConfig()` and `store.exportConfig()`, and kept on
  save when the browser sends it empty.

**UI.**

- UI text is English.
- No native browser dialogs (`alert`, `confirm`, `prompt`). Use `confirmDialog()` / `askDialog()` from
  `app.js`, `W.prompt()` or `W.confirm3()`.
- Monaco uses generic class names (`.main`, `.tree`, `.icon`). Scope your CSS (`main.main`,
  `.view-body .tree`) and never add bare global rules for such names.

**Platforms.**

- No `/proc`, `ss`, `xdg-open`, `systemctl` or GNU-only flags without a branch on `process.platform`.
- Build local paths from `os.homedir()`, never a hard-coded `/home/...`.
- Remote (SSH) folders use `ssh://<profile id>/abs/path`. Features that only work locally must check
  `W.isRemote()` in the browser or `remote.isRemote()` on the server.

**Tools.** Formatters and linters run only if they are already installed (ruff, shellcheck, yamllint…),
with built-in fallbacks otherwise. Dash must not download tools at runtime (`npx`, `uvx`).

## Never commit personal data

Dash is public. Do not commit real hosts or IPs, usernames, emails, home paths, passwords, tokens or company
names. Use placeholders such as `203.0.113.10`, `deploy` and `/home/me/project`.

These local files are ignored and must stay that way: `projects.json`, `.dash-state.json`,
`.dash-history.jsonl`, `.dash-auth.json`, `.dash-tls/`, `logs/`, `plans/`, exported `dash-config-*.json`.

Commits are public too. Set a GitHub noreply address for this repository if you do not want your email
published:

```bash
git config user.email "<id>+<username>@users.noreply.github.com"
```

## Reporting bugs and security issues

Open an issue with your OS, Node version, the steps to reproduce and what you expected. For a security
problem (a way to run commands, read files or bypass sign-in), do not open a public issue; use
[GitHub private vulnerability reporting](https://github.com/namtao/dash/security/advisories/new) instead.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
