// Warmup hạn mức 5 giờ của Claude: cửa sổ 5 giờ bắt đầu từ tin nhắn đầu tiên khi chưa có cửa sổ nào đang chạy.
// Muốn hạn mức reset lúc R thì gửi một prompt rất nhỏ (Haiku, không tool) lúc R − 5h; ví dụ reset 10:00 và 15:00 →
// warmup 05:00 và 10:00 (cửa sổ 05:00 vừa hết lúc 10:00 thì cửa sổ mới bắt đầu ngay).
// Trong khung một giờ kể từ giờ warmup: nếu đang có cửa sổ chạy (người dùng đã dùng từ trước) thì chờ nó hết rồi mới gửi;
// gửi xong đọc lại hạn mức để chắc cửa sổ mới đã bắt đầu, chưa thì thử lại (tối đa 3 lần). Máy ngủ thì không chạy được.
const { execFile } = require("child_process");
const os = require("os");
const store = require("./store");

const WINDOW_MIN = 60; // khung bù khi tới giờ mà chưa gửi được (máy vừa thức, cửa sổ cũ chưa hết)
const MAX_TRIES = 3;
const PROMPT = "Reply with the single word: ok";
const state = { slots: {}, runs: [], running: null };
let binary = () => "claude";
let usage = async () => ({ limits: {} });

const conf = () => {
  const ws = store.load().workspace;
  return { on: ws.claudeWarmup, resets: parseTimes(ws.claudeWarmupResets), tz: ws.claudeWarmupTz || Intl.DateTimeFormat().resolvedOptions().timeZone };
};
// "10:00, 15:00" → [600, 900] (phút trong ngày)
function parseTimes(text) {
  return [...String(text || "").matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
}
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// Giờ hiện tại (phút trong ngày) và ngày theo múi giờ đã chọn
function clock(tz, at = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

function record(run) {
  state.runs = [run, ...state.runs].slice(0, 20);
  return run;
}

// Gửi prompt warmup. Trả { at, ok, output, resetsAt }
function warmup(reason = "manual") {
  state.running ||= new Promise((resolve) => {
    const args = ["-p", PROMPT, "--model", "haiku", "--tools", "", "--no-session-persistence"];
    const child = execFile(binary(), args, { cwd: os.tmpdir(), timeout: 120000, env: { ...process.env, CI: "1" } }, async (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim().slice(-400);
      const u = await usage(true).catch(() => null);
      resolve(record({ at: Date.now(), reason, ok: !err, output: err ? output || err.message : output, resetsAt: u?.limits?.five_hour?.resetsAt || null }));
    });
    child.stdin?.end(); // không có stdin: claude -p khỏi chờ 3 giây
  }).finally(() => (state.running = null));
  return state.running;
}

async function tick() {
  const c = conf();
  if (!c.on || !c.resets.length || state.running) return;
  const now = clock(c.tz);
  for (const reset of c.resets) {
    const at = (reset - 300 + 1440) % 1440; // giờ warmup = giờ reset − 5h
    const late = (now.min - at + 1440) % 1440;
    if (late >= WINDOW_MIN) continue;
    // khung qua nửa đêm (warmup 23:30) thì vẫn tính theo ngày bắt đầu khung
    const key = `${late > now.min ? clock(c.tz, Date.now() - late * 60000).day : now.day} ${hhmm(at)}`;
    const slot = (state.slots[key] ||= { key, reset: hhmm(reset), tries: 0, lastTry: 0, status: "pending", note: "" });
    if (slot.status === "done" || slot.status === "failed" || Date.now() - slot.lastTry < 60000) continue;
    const u = await usage(false).catch(() => null);
    const active = u?.limits?.five_hour?.resetsAt;
    if (active && active > Date.now() && !slot.tries) {
      slot.status = "waiting";
      slot.note = `A 5-hour window is already running until ${new Date(active).toLocaleTimeString("en-GB", { timeZone: c.tz, hour: "2-digit", minute: "2-digit" })}; warmup waits for it to end.`;
      continue;
    }
    slot.tries++;
    slot.lastTry = Date.now();
    const run = await warmup(`scheduled ${hhmm(at)} → reset ${hhmm(reset)}`);
    // cửa sổ mới thì còn gần đủ 5 giờ; còn ít hơn nghĩa là prompt rơi vào cửa sổ cũ chưa kịp hết
    const started = run.resetsAt && run.resetsAt > Date.now() + 4 * 3600000;
    if (run.ok && (started || !u)) {
      slot.status = "done";
      slot.note = run.resetsAt ? `Window resets at ${new Date(run.resetsAt).toLocaleTimeString("en-GB", { timeZone: c.tz, hour: "2-digit", minute: "2-digit" })}.` : "Sent.";
    } else if (slot.tries >= MAX_TRIES) {
      slot.status = "failed";
      slot.note = run.ok ? "Sent, but no new 5-hour window showed up." : run.output;
    } else {
      slot.status = "retrying";
      slot.note = run.ok ? "Sent; the new window has not shown up yet." : run.output;
    }
    return; // mỗi nhịp chỉ gửi một lần
  }
  // bỏ khung cũ
  for (const k of Object.keys(state.slots)) if (Date.now() - (state.slots[k].lastTry || Date.now()) > 2 * 86400000) delete state.slots[k];
}

// Lần warmup sắp tới (theo múi giờ đã chọn) để hiện trong Settings
function status() {
  const c = conf();
  const now = clock(c.tz);
  const next = c.resets
    .map((r) => ({ reset: hhmm(r), at: hhmm((r - 300 + 1440) % 1440), wait: ((r - 300 + 1440) % 1440 - now.min + 1440) % 1440 }))
    .sort((a, b) => a.wait - b.wait)[0];
  return { enabled: c.on, tz: c.tz, resets: c.resets.map(hhmm), next: c.on ? next || null : null, slots: Object.values(state.slots).slice(-6), runs: state.runs.slice(0, 5), running: Boolean(state.running) };
}

function schedule({ findBinary, readUsage }) {
  if (findBinary) binary = () => findBinary() || "claude";
  if (readUsage) usage = readUsage;
  setInterval(() => tick().catch(() => {}), 20000).unref();
}

module.exports = { schedule, status, warmup, tick, parseTimes };
