// Chuyển tiếp cổng qua SSH (ssh -N -L cổng_local:host:cổng): mỗi chuyển tiếp là một tiến trình ssh con,
// tắt khi bấm Stop hoặc khi Dash dừng. Chỉ dùng khoá / ssh-agent (BatchMode) vì không có chỗ gõ mật khẩu.
const { spawn } = require("child_process");
const store = require("./store");
const ssh = require("./ssh-profiles");

const forwards = new Map(); // id -> { id, profileId, label, local, host, remote, startedAt, child, error, exited }
let listener = () => {};

const info = (f) => ({ id: f.id, profileId: f.profileId, label: f.label, local: f.local, host: f.host, remote: f.remote, startedAt: f.startedAt, running: !f.exited, error: f.error });

function list() {
  return [...forwards.values()].map(info);
}

function start(profileId, spec) {
  const profile = store.load().ssh.find((p) => p.id === profileId);
  if (!profile) throw Object.assign(new Error("SSH profile not found"), { status: 404 });
  const local = Number(spec.local);
  const remote = Number(spec.remote);
  const host = String(spec.host || "localhost").trim() || "localhost";
  if (!(local > 0 && local < 65536) || !(remote > 0 && remote < 65536)) throw Object.assign(new Error("Ports must be numbers from 1 to 65535"), { status: 400 });
  const id = `${profileId}:${local}`;
  if (forwards.get(id) && !forwards.get(id).exited) throw Object.assign(new Error(`Local port ${local} is already forwarded`), { status: 409 });
  const args = ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-L", `127.0.0.1:${local}:${host}:${remote}`, ...ssh.options(profile), ssh.target(profile)];
  const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
  const f = { id, profileId, label: String(spec.label || "").trim(), local, host, remote, startedAt: Date.now(), child, error: "", exited: false };
  child.stderr.on("data", (d) => {
    f.error = (f.error + d.toString()).slice(-2000).trim();
  });
  child.on("error", (e) => {
    f.error = e.message;
  });
  child.on("exit", (code) => {
    f.exited = true;
    if (code && !f.error) f.error = `ssh exited with code ${code}`;
    listener(info(f));
  });
  forwards.set(id, f);
  listener(info(f));
  return info(f);
}

function stop(id) {
  const f = forwards.get(id);
  if (!f) return;
  if (!f.exited) f.child.kill("SIGTERM");
  forwards.delete(id);
  listener({ ...info(f), running: false, removed: true });
}

function stopAll() {
  for (const id of [...forwards.keys()]) stop(id);
}

module.exports = { list, start, stop, stopAll, on: (fn) => (listener = fn) };
