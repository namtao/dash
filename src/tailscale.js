"use strict";
// Đọc trạng thái Tailscale và IP 100.x của máy này, để Dash nghe thêm trên http://<IP Tailscale>:<cổng> khi bật truy cập từ xa.
const fs = require("fs");
const { execFile } = require("child_process");

// macOS (bản app) để CLI trong gói .app; chạy từ launchd (thiếu env của terminal) nó tưởng là mở GUI và báo lỗi,
// nên ép chế độ CLI bằng TAILSCALE_BE_CLI=1. Linux / Homebrew để trong PATH.
const CLI_ENV = { ...process.env, TAILSCALE_BE_CLI: "1" };
const CANDIDATES = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/usr/bin/tailscale", "/usr/sbin/tailscale"];
const bin = () => CANDIDATES.find((f) => fs.existsSync(f)) || null;

function run(args) {
  const file = bin();
  if (!file) return Promise.reject(new Error("Tailscale is not installed on this machine"));
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: CLI_ENV }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (err) return reject(new Error(out || err.message));
      resolve(out);
    });
  });
}

// IPv4 Tailscale của máy này (100.x), rỗng nếu tailscale chưa chạy
const ip = () => run(["ip", "-4"]).then((o) => o.split("\n")[0].trim()).catch(() => "");

async function status() {
  if (!bin()) return { installed: false };
  const addr = await run(["ip", "-4"]).catch((e) => ({ error: e.message.split("\n")[0] }));
  if (addr.error) return { installed: true, running: false, error: addr.error };
  return { installed: true, running: true, ip: addr.split("\n")[0].trim() };
}

// IP của các máy thuộc chính tailnet này (máy này + peer), bỏ máy tailnet khác được share vào (ShareeNode).
// Cache 30 giây; IP lạ thì đọc lại (tối đa 5 giây một lần) để máy mới thêm vào tailnet vào được ngay.
let members = { set: new Set(), at: 0 };
async function refreshMembers() {
  const s = JSON.parse(await run(["status", "--json"]));
  const set = new Set();
  for (const n of [s.Self, ...Object.values(s.Peer || {})]) {
    if (!n || n.ShareeNode) continue;
    for (const a of n.TailscaleIPs || []) set.add(a);
  }
  members = { set, at: Date.now() };
}
async function isMember(addr) {
  const a = String(addr || "").replace(/^::ffff:/, "");
  const age = Date.now() - members.at;
  if (age > 30000 || (!members.set.has(a) && age > 5000)) await refreshMembers().catch(() => {});
  return members.set.has(a);
}

module.exports = { status, ip, isMember };
