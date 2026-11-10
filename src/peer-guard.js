"use strict";
// Kết nối loopback chỉ nhận từ trình duyệt. Trên macOS, mọi thứ chạy trên máy đều tới Dash qua 127.0.0.1 giống hệt
// trình duyệt: container (com.docker.backend khi gọi host.docker.internal), tunnel (cloudflared, ngrok…), proxy, ssh -R.
// Trình duyệt lại gửi cookie localhost của Dash cho mọi cổng localhost (Portainer, omniroute…), nên cookie có thể lọt
// vào một container rồi bị gửi ngược vào Dash. Danh sách chặn sẽ luôn thiếu, nên dùng danh sách cho phép.
// Kiểm tiến trình ở đầu kia của kết nối bằng lsof (~30 ms, một lần mỗi kết nối TCP). Không xác định được thì chặn.
// Thêm tiến trình khác (vd. curl để thử): DASH_LOOPBACK_ALLOW='^(curl|node)$'. Linux: không kiểm (không có lsof
// chắc chắn; container đi qua docker0 chứ không phải loopback).
const { execFile } = require("child_process");

const BROWSERS = /^((Google Chrome|Google Chrome for Testing|Brave Browser|Microsoft Edge|Chromium|Arc|Vivaldi|Opera|Dia|Comet) Helper|com\.apple\.WebKit\.Networking|firefox|Orion)\b/i;
const EXTRA = process.env.DASH_LOOPBACK_ALLOW ? new RegExp(process.env.DASH_LOOPBACK_ALLOW) : null;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function peerProcess(port) {
  return new Promise((resolve) => {
    execFile("/usr/sbin/lsof", ["-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:ESTABLISHED", "-Fpc"], { timeout: 3000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      // Bản ghi lsof -F: p<pid> rồi c<lệnh>. Bỏ chính Dash (đầu nhận của kết nối).
      let pid = 0;
      for (const line of stdout.split("\n")) {
        if (line[0] === "p") pid = Number(line.slice(1));
        else if (line[0] === "c" && pid !== process.pid) return resolve(line.slice(1));
      }
      resolve(null);
    });
  });
}

const refusedOnce = new Set();
// true nếu cho kết nối này đi tiếp
async function allowed(socket) {
  if (process.platform !== "darwin" || !LOOPBACK.has(socket.remoteAddress)) return true;
  const cmd = await peerProcess(socket.remotePort);
  if (cmd && (BROWSERS.test(cmd) || EXTRA?.test(cmd))) return true;
  // Ghi log một lần mỗi tiến trình để biết cần thêm gì vào DASH_LOOPBACK_ALLOW (không làm đầy log)
  const who = cmd || "unknown process";
  if (!refusedOnce.has(who)) {
    refusedOnce.add(who);
    console.warn(`[auth] ${new Date().toISOString()} refused loopback connection from ${who} (only browsers may connect; see DASH_LOOPBACK_ALLOW)`);
  }
  return false;
}

module.exports = { allowed };
