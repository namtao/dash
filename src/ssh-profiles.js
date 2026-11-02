// Hồ sơ SSH: dựng dòng lệnh ssh cho terminal, cho lệnh chạy trên máy từ xa và cho chuyển tiếp cổng.
const os = require("os");
const path = require("path");

// Nhãn giống WezTerm: ROOT / LAN / VPN (Tailscale 100.x) / CLOUD / WAN
function tag(p) {
  if (p.user === "root") return "ROOT";
  if (/^192\.168\./.test(p.host) || /^10\./.test(p.host)) return "LAN";
  if (/^100\./.test(p.host)) return "VPN";
  if (/^172\./.test(p.host)) return "CLOUD";
  return "WAN";
}

const target = (p) => (p.user ? `${p.user}@${p.host}` : p.host);
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Tuỳ chọn chung (cổng, khoá, tham số thêm) — chưa có máy đích và lệnh
function options(p) {
  const args = ["-o", "ServerAliveInterval=30"];
  if (p.port && p.port !== 22) args.push("-p", String(p.port));
  if (p.identityFile) args.push("-i", p.identityFile.replace(/^~(?=\/)/, os.homedir()));
  if (p.args) args.push(...p.args.split(/\s+/).filter(Boolean));
  return args;
}

// Terminal tương tác; dir (nếu có) thay cho thư mục mặc định của hồ sơ
function argv(p, dir = p.remoteDir) {
  const args = ["ssh", ...options(p), target(p)];
  if (dir) args.push("-t", `cd ${shellQuote(dir)} && exec $SHELL -l`);
  return args;
}

// Lệnh không tương tác (duyệt file, đọc/ghi): dùng chung một kết nối (ControlMaster) cho nhanh,
// BatchMode để báo lỗi ngay thay vì treo chờ mật khẩu (chỉ hỗ trợ khoá / ssh-agent).
function execArgs(p, command) {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${path.join(os.tmpdir(), "dash-ssh-%C")}`,
    "-o", "ControlPersist=10m",
    ...options(p),
    target(p),
    "--",
    command,
  ];
}

module.exports = { tag, argv, execArgs, options, target, shellQuote };
