"use strict";
// Đăng nhập Dash: một mật khẩu (scrypt) + phiên theo từng thiết bị (cookie HttpOnly, hết hạn sau 30 ngày không dùng,
// thu hồi được). Mọi request đều phải đăng nhập, kể cả từ 127.0.0.1: container Docker gọi host.docker.internal cũng tới
// Dash qua loopback, không phân biệt được với trình duyệt trên máy, mà Dash mở được shell trên máy chủ.
// Mật khẩu đầu tiên / quên mật khẩu: `npm run set-password` trong terminal của máy (container không chạy được lệnh này).
// Dữ liệu nằm riêng trong .dash-auth.json (mode 600) cạnh projects.json, nên không bao giờ lọt vào publicConfig / export.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const store = require("./store");

const scrypt = promisify(crypto.scrypt);
const AUTH_PATH = process.env.DASH_AUTH || path.join(path.dirname(store.CONFIG_PATH), ".dash-auth.json");
const COOKIE = "dash_session";
const TTL = 30 * 24 * 3600 * 1000; // phiên không dùng quá 30 ngày thì hết hạn
const TOUCH_MS = 60 * 1000; // ghi lastSeen tối đa mỗi phút
const MAX_FAILS = 5;
const MAX_GLOBAL_FAILS = 20;
const LOCK_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 12; // Dash mở được shell trên máy chính: mật khẩu dài là lớp chặn dò chính
const MAX_PASSWORD = 1024; // chặn body vài MB bắt scrypt băm
const IDLE_MS = 30 * 60 * 1000; // thiết bị qua Tailscale không thao tác 30 phút thì tự đăng xuất
const ACTIVE_WRITE_MS = 60 * 1000; // ghi lastActive tối đa mỗi phút
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Nhật ký đăng nhập ra stdout (launchd / journald giữ lại) để biết ai đã vào, ai dò sai
const audit = (msg) => console.log(`[auth] ${new Date().toISOString()} ${msg}`);
const httpError = (status, message) => Object.assign(new Error(message), { status });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---------- Lưu trữ ----------
// File có thể bị `npm run set-password` sửa lúc server đang chạy: đọc lại khi mtime đổi, báo các phiên đã mất.
let data = null;
let mtime = 0;
const listeners = new Set();
const onRevoke = (fn) => listeners.add(fn);
const notify = (ids) => ids.size && listeners.forEach((fn) => fn(ids));

function load() {
  let m = 0;
  try {
    m = fs.statSync(AUTH_PATH).mtimeMs;
  } catch {}
  if (data && m === mtime) return data;
  const before = new Set((data?.sessions || []).map((s) => s.id));
  try {
    data = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
  } catch {
    data = {};
  }
  if (!Array.isArray(data.sessions)) data.sessions = [];
  mtime = m;
  data.sessions.forEach((s) => before.delete(s.id));
  notify(before);
  return data;
}

const isRemote = (s) => !LOOPBACK.has(s.ip);
const live = (s) => Boolean(s.hash) && s.lastSeen + TTL > Date.now() && !(isRemote(s) && (s.lastActive || s.lastSeen) + IDLE_MS <= Date.now());

function save() {
  const now = Date.now();
  // Thiết bị từ xa giữ chỗ (kể cả đã đăng xuất) cho tới khi bị xoá ở máy này; bản ghi local hết hạn thì bỏ
  data.sessions = data.sessions.filter((s) => isRemote(s) || s.lastSeen + TTL > now);
  const tmp = `${AUTH_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, AUTH_PATH);
  mtime = fs.statSync(AUTH_PATH).mtimeMs;
}

// ---------- Nhận diện ----------
// Trên máy này (loopback, Host localhost). Chỉ dùng để giới hạn thao tác quản trị (bật/tắt Tailscale) cho phiên đã
// đăng nhập ngồi tại máy; KHÔNG dùng để bỏ qua mật khẩu.
function isLocal(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return false;
  return LOCAL_HOSTS.has((req.headers.host || "").replace(/:\d+$/, ""));
}

// Địa chỉ socket, không tin X-Forwarded-For (ai cũng tự gửi được, kể cả container qua loopback)
const clientIp = (req) => String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

// Tên thiết bị đọc từ User-Agent: "Chrome · macOS"
function deviceName(ua = "") {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return os ? `${browser} · ${os}` : browser;
}

// Phiên của request (null nếu không có / hết hạn / khác IP / đã đăng xuất). Gia hạn lastSeen khi đang dùng.
// Phiên gắn với IP lúc đăng nhập (IP Tailscale cố định theo máy). Cookie theo host chứ không theo cổng, nên server dev
// khác trên 100.x:<cổng khác> cũng nhận được cookie; lộ cookie cũng không dùng được từ máy khác.
function identify(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token || !passwordSet()) return null;
  const hash = sha(token);
  const s = data.sessions.find((x) => x.hash === hash);
  if (!s || s.ip !== clientIp(req)) return null;
  if (!live(s)) {
    endSessions((x) => x.id === s.id, "idle / expired");
    return null;
  }
  if (Date.now() - s.lastSeen > TOUCH_MS) {
    s.lastSeen = Date.now();
    save();
  }
  return s;
}

// Người dùng vừa thao tác (gõ phím, bấm, cuộn): trình duyệt báo về để tính 30 phút không dùng. Các request tự động
// (làm mới giá coin, usage…) không gọi hàm này nên không giữ phiên sống mãi.
function touchActive(who) {
  if (!who || !isRemote(who)) return { ok: true };
  if (Date.now() - (who.lastActive || 0) > ACTIVE_WRITE_MS) {
    who.lastActive = Date.now();
    save();
  }
  return { ok: true, idleMs: IDLE_MS };
}

const passwordSet = () => Boolean(load().passwordHash);

// ---------- Mật khẩu ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(pw) {
  const [, salt, key] = String(load().passwordHash || "").split("$");
  if (!salt || !key) return false;
  const got = await scrypt(String(pw ?? ""), Buffer.from(salt, "hex"), 64);
  return crypto.timingSafeEqual(got, Buffer.from(key, "hex"));
}

function checkLength(pw) {
  if (pw.length < MIN_PASSWORD || pw.length > MAX_PASSWORD) throw httpError(400, `The password needs ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
}

// Chặn dò mật khẩu: 5 lần sai liên tiếp từ một IP thì khoá IP đó 15 phút; tổng cộng 20 lần sai trong 15 phút (dò từ
// nhiều máy) thì khoá mọi đăng nhập 15 phút. Khoá nằm trong bộ nhớ: khởi động lại Dash là mở.
const fails = new Map(); // ip -> { n, until }
let recent = []; // thời điểm các lần sai gần đây (mọi IP)
let globalUntil = 0;
const lockMsg = (until) => `Too many wrong passwords. Try again in ${Math.ceil((until - Date.now()) / 60000)} min.`;
function checkLock(ip) {
  if (globalUntil > Date.now()) throw httpError(429, lockMsg(globalUntil));
  const f = fails.get(ip);
  if (f?.until > Date.now()) throw httpError(429, lockMsg(f.until));
}
function recordFail(ip, what) {
  const now = Date.now();
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n = f.until && f.until <= now ? 1 : f.n + 1;
  f.until = f.n >= MAX_FAILS ? now + LOCK_MS : 0;
  fails.set(ip, f);
  audit(`${what} from ${ip}`);
  recent = recent.filter((t) => t > now - LOCK_MS).concat(now);
  if (recent.length >= MAX_GLOBAL_FAILS) {
    globalUntil = now + LOCK_MS;
    recent = [];
    audit(`${MAX_GLOBAL_FAILS} wrong passwords in 15 min: sign-in locked for 15 min`);
  }
  // Bản đồ không phình mãi: bỏ IP đã hết khoá
  if (fails.size > 1000) for (const [k, v] of fails) if (!v.until || v.until <= now) fails.delete(k);
}

// Cookie sống lâu hơn TTL; server mới là nơi quyết định hết hạn (trượt 30 ngày)
function cookie(req, token, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---------- API ----------
async function login(req, res, body) {
  if (!passwordSet()) throw httpError(400, "No password is set yet. In a terminal on the Dash machine run: npm run set-password");
  const ip = clientIp(req);
  checkLock(ip);
  if (String(body.password ?? "").length > MAX_PASSWORD) throw httpError(400, "Password too long");
  if (!(await verifyPassword(body.password))) {
    recordFail(ip, "wrong password");
    throw httpError(401, "Wrong password");
  }
  fails.delete(ip);
  // Từ xa (Tailscale) chỉ một thiết bị được đăng nhập. Thiết bị khác muốn vào thì phải xoá thiết bị cũ ở máy này
  // (127.0.0.1). Cùng thiết bị (cùng IP Tailscale) đăng nhập lại thì thay phiên cũ của nó.
  if (!LOOPBACK.has(ip)) {
    const other = load().sessions.find((s) => isRemote(s) && s.ip !== ip);
    if (other) {
      audit(`refused sign-in from ${ip}: ${other.name} ${other.ip} already holds the remote slot`);
      throw httpError(403, `Another device (${other.name}) is already signed in remotely. Remove it in Settings → Remote access on the Dash machine first.`);
    }
    // Cùng thiết bị đăng nhập lại: thay bản ghi cũ của nó (đóng phiên cũ nếu còn)
    const old = data.sessions.filter((s) => s.ip === ip).map((s) => s.id);
    data.sessions = data.sessions.filter((s) => s.ip !== ip);
    notify(new Set(old));
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const ua = String(req.headers["user-agent"] || "").slice(0, 300);
  load().sessions.push({
    id: crypto.randomUUID(),
    hash: sha(token),
    name: String(body.name || "").trim().slice(0, 60) || deviceName(ua),
    ua,
    ip,
    created: now,
    lastSeen: now,
    lastActive: now,
  });
  save();
  audit(`signed in from ${ip} (${deviceName(ua)})`);
  res.setHeader("Set-Cookie", cookie(req, token, 400 * 24 * 3600));
  return { ok: true };
}

// Xoá hẳn thiết bị (giải phóng chỗ đăng nhập từ xa). Chỉ gọi từ máy này.
function revoke(pred) {
  const gone = load().sessions.filter(pred);
  if (!gone.length) return 0;
  data.sessions = data.sessions.filter((s) => !pred(s));
  save();
  audit(`removed device ${gone.map((s) => `${s.name} ${s.ip}`).join(", ")}`);
  notify(new Set(gone.map((s) => s.id)));
  return gone.length;
}

// Đăng xuất: xoá token, thiết bị từ xa vẫn giữ chỗ (chỉ Remove ở máy này mới giải phóng). Bản ghi local thì bỏ luôn.
function endSessions(pred, why) {
  const gone = load().sessions.filter((s) => s.hash && pred(s));
  if (!gone.length) return 0;
  for (const s of gone) s.hash = null;
  data.sessions = data.sessions.filter((s) => s.hash || isRemote(s));
  save();
  audit(`signed out (${why}) ${gone.map((s) => `${s.name} ${s.ip}`).join(", ")}`);
  notify(new Set(gone.map((s) => s.id)));
  return gone.length;
}

// Tự đăng xuất thiết bị từ xa không thao tác quá 30 phút (đóng luôn WebSocket đang mở)
setInterval(() => {
  if (data) endSessions((s) => isRemote(s) && !live(s), "idle 30 min");
}, 60 * 1000).unref();

function logout(req, res, who) {
  if (who) endSessions((s) => s.id === who.id, "sign out");
  res.setHeader("Set-Cookie", cookie(req, "", 0));
  return { ok: true };
}

function state(req) {
  const who = identify(req);
  return { passwordSet: passwordSet(), signedIn: Boolean(who), local: Boolean(who) && isLocal(req), device: who ? who.name : null };
}

function devices(who) {
  return load()
    .sessions.sort((a, b) => b.lastSeen - a.lastSeen)
    .map(({ hash, ...s }) => ({ ...s, remote: isRemote(s), signedIn: live({ hash, ...s }), current: who?.id === s.id }));
}

// Đổi mật khẩu (phải nhập mật khẩu cũ). Đổi xong, mọi thiết bị khác bị đăng xuất.
async function setPassword(who, body) {
  const next = String(body.password || "");
  checkLength(next);
  checkLock(who.ip);
  if (!(await verifyPassword(body.current))) {
    recordFail(who.ip, "wrong current password");
    throw httpError(403, "Current password is wrong");
  }
  load().passwordHash = await hashPassword(next);
  save();
  audit(`password changed from ${who.ip}`);
  endSessions((s) => s.id !== who.id, "password changed");
  return { ok: true };
}

// Bật truy cập qua Tailscale (nhớ qua các lần khởi động lại Dash)
const tailscaleOn = () => passwordSet() && load().tailscale === true;
function setTailscale(on) {
  load().tailscale = Boolean(on);
  save();
}

module.exports = { tailscaleOn, setTailscale, identify, isLocal, login, logout, state, devices, revoke, endSessions, touchActive, onRevoke, setPassword, AUTH_PATH };

// ---------- CLI: npm run set-password ----------
// Đặt mật khẩu đầu tiên hoặc đặt lại khi quên. Đăng xuất mọi thiết bị. Server đang chạy tự đọc lại file.
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error("Run this in a terminal"));
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let s = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          return resolve(s);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") s = s.slice(0, -1);
        else s += c;
      }
    };
    stdin.on("data", onData);
  });
}

if (require.main === module) {
  (async () => {
    const pw = await readHidden(`New Dash password (${MIN_PASSWORD}+ characters): `);
    checkLength(pw);
    if ((await readHidden("Repeat it: ")) !== pw) throw new Error("The passwords do not match");
    load().passwordHash = await hashPassword(pw);
    const n = data.sessions.filter((s) => s.hash).length;
    data.sessions = data.sessions.filter(isRemote).map((s) => ({ ...s, hash: null }));
    save();
    audit(`password set from the command line; ${n} session(s) signed out`);
    console.log(`Password saved in ${AUTH_PATH}. Sign in again in your browsers.`);
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
