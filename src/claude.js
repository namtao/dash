// Claude Code trong Dash: phiên chat qua Claude Agent SDK (dùng bản claude CLI đã cài và đăng nhập
// của người dùng), xin quyền chạy công cụ qua giao diện, và đọc hạn mức 5 giờ / tuần.
//
// Hạn mức đọc từ endpoint mà lệnh /usage của Claude Code dùng (api/oauth/usage) bằng OAuth token trong
// ~/.claude/.credentials.json (macOS: Keychain, mục "Claude Code-credentials"): chỉ là một request HTTP,
// không gửi prompt nên không tốn token.
// Token không bao giờ được gửi xuống trình duyệt hay ghi ra log.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const store = require("./store");

const CREDENTIALS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

let sdk = null;
const loadSdk = async () => (sdk ||= await import("@anthropic-ai/claude-agent-sdk"));

function claudeBinary() {
  for (const p of [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"]) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // SDK tự dùng bản đi kèm
}

// ---------- Hạn mức ----------
const usageState = { data: null, fetchedAt: 0, error: "", nextAllowedAt: 0, inflight: null, live: {} };

// Linux lưu token trong file; Claude Code trên macOS lưu trong Keychain (file chỉ có khi Keychain không dùng được).
function readCredentials() {
  try {
    return fs.readFileSync(CREDENTIALS, "utf8");
  } catch (e) {
    if (process.platform !== "darwin") throw e;
    return execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  }
}

function readToken() {
  const raw = JSON.parse(readCredentials());
  const oauth = raw.claudeAiOauth || {};
  return { token: oauth.accessToken || "", expiresAt: oauth.expiresAt || 0, plan: oauth.subscriptionType || "" };
}

function shapeUsage(json) {
  const limits = {};
  for (const [key, v] of Object.entries(json || {})) {
    if (v && typeof v === "object" && typeof v.utilization === "number") limits[key] = { utilization: v.utilization, resetsAt: v.resets_at ? Date.parse(v.resets_at) : null };
  }
  return limits;
}

async function fetchUsage() {
  let cred;
  try {
    cred = readToken();
  } catch {
    throw new Error("Not logged in to Claude Code (run `claude` once)");
  }
  if (!cred.token) throw new Error("Not logged in to Claude Code (run `claude` once)");
  if (cred.expiresAt && cred.expiresAt < Date.now()) throw new Error("Claude login token expired; it refreshes the next time Claude Code runs");
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${cred.token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json", "User-Agent": "dash-local" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after")) || 300;
    usageState.nextAllowedAt = Date.now() + wait * 1000;
    throw new Error(`Usage endpoint rate-limited, retrying in ${Math.round(wait / 60) || 1} min`);
  }
  if (!res.ok) throw new Error(`Usage request failed: HTTP ${res.status}`);
  return { plan: cred.plan, limits: shapeUsage(await res.json()) };
}

// Trả về số liệu đã cache nếu còn mới (theo usageRefreshSec); nhiều tab cùng hỏi chỉ tốn một request.
async function usage(force = false) {
  const maxAge = store.load().workspace.usageRefreshSec * 1000;
  const fresh = Date.now() - usageState.fetchedAt < (force ? 15000 : maxAge);
  if (!fresh && Date.now() >= usageState.nextAllowedAt) {
    usageState.inflight ||= fetchUsage()
      .then((d) => {
        usageState.data = d;
        usageState.error = "";
      })
      .catch((e) => {
        usageState.error = e.message;
      })
      .finally(() => {
        usageState.fetchedAt = Date.now();
        usageState.inflight = null;
      });
    await usageState.inflight;
  }
  return { ...(usageState.data || { limits: {} }), live: usageState.live, error: usageState.error, fetchedAt: usageState.fetchedAt };
}

// Sự kiện rate_limit_event của SDK cập nhật ngay mức dùng mà không cần gọi thêm.
function noteRateLimit(info) {
  if (!info?.rateLimitType) return;
  usageState.live[info.rateLimitType] = { utilization: typeof info.utilization === "number" ? info.utilization * (info.utilization <= 1 ? 100 : 1) : null, resetsAt: info.resetsAt ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : null, status: info.status, at: Date.now() };
}

// ---------- Phiên chat ----------
const sessions = new Map(); // id -> session
const listeners = new Set();
let seq = 0;
// Mỗi sự kiện mang theo workspace (cửa sổ) sở hữu phiên để trình duyệt lọc
const emit = (payload) => {
  const ws = payload.ws || sessions.get(payload.id)?.ws;
  listeners.forEach((fn) => fn({ ...payload, ws }));
};
const MAX_TOOL_TEXT = 20000;

// Cắt bớt kết quả công cụ quá dài trước khi gửi xuống trình duyệt.
function trimMessage(msg) {
  if (msg?.type !== "user" || !Array.isArray(msg.message?.content)) return msg;
  const content = msg.message.content.map((b) => {
    if (b.type !== "tool_result") return b;
    let c = b.content;
    if (Array.isArray(c)) c = c.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
    c = String(c ?? "");
    return { ...b, content: c.length > MAX_TOOL_TEXT ? `${c.slice(0, MAX_TOOL_TEXT)}\n… (${c.length - MAX_TOOL_TEXT} more chars)` : c };
  });
  const { tool_use_result, ...rest } = msg;
  return { ...rest, message: { ...msg.message, content } };
}

function info(s) {
  return { id: s.id, ws: s.ws, cwd: s.cwd, title: s.title, sessionId: s.sessionId, model: s.model, permissionMode: s.permissionMode, busy: s.busy, closed: s.closed, createdAt: s.createdAt, pending: [...s.permissions.values()].map((p) => p.request) };
}

function push(s, msg) {
  s.log.push(msg);
  if (s.log.length > 3000) s.log.splice(0, s.log.length - 3000);
  emit({ id: s.id, msg });
}

function inputStream(s) {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            if (s.closed) return resolve({ done: true, value: undefined });
            if (s.queue.length) return resolve({ done: false, value: s.queue.shift() });
            s.wake = resolve;
          }),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

// opts: { cwd, resume (sessionId), model, permissionMode, title, ws }
async function start(opts = {}) {
  const { query } = await loadSdk();
  const ws = store.load().workspace;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? path.resolve(opts.cwd) : os.homedir();
  const s = {
    id: `c${++seq}`,
    ws: String(opts.ws || "main"),
    cwd,
    title: opts.title || path.basename(cwd),
    sessionId: opts.resume || null,
    model: opts.model || ws.claudeModel || "",
    permissionMode: opts.permissionMode || ws.claudePermissionMode || "default",
    busy: false,
    closed: false,
    createdAt: Date.now(),
    queue: [],
    wake: null,
    log: [],
    permissions: new Map(),
  };
  sessions.set(s.id, s);

  if (opts.resume) {
    try {
      const past = await sdk.getSessionMessages(opts.resume, { dir: cwd });
      for (const m of past) if (m.type === "user" || m.type === "assistant") s.log.push(trimMessage({ type: m.type, uuid: m.uuid, message: m.message, parent_tool_use_id: m.parent_tool_use_id, replay: true }));
    } catch {}
  }

  const options = {
    cwd,
    pathToClaudeCodeExecutable: claudeBinary(),
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    permissionMode: s.permissionMode,
    allowDangerouslySkipPermissions: s.permissionMode === "bypassPermissions",
    canUseTool: (toolName, input, { signal, suggestions, decisionReason, blockedPath }) =>
      new Promise((resolve) => {
        const requestId = `p${++seq}`;
        const request = { requestId, toolName, input, suggestions: suggestions || [], reason: decisionReason || "", blockedPath: blockedPath || "" };
        s.permissions.set(requestId, { resolve, request, input });
        push(s, { type: "dash_permission", ...request });
        signal?.addEventListener("abort", () => {
          if (s.permissions.delete(requestId)) push(s, { type: "dash_permission_done", requestId, behavior: "cancelled" });
          resolve({ behavior: "deny", message: "Cancelled" });
        });
      }),
    stderr: (d) => process.env.DASH_DEBUG && process.stderr.write(`[claude ${s.id}] ${d}`),
  };
  if (s.model) options.model = s.model;
  if (ws.claudeEffort) options.effort = ws.claudeEffort;
  if (opts.resume) options.resume = opts.resume;

  s.query = query({ prompt: inputStream(s), options });
  emit({ id: s.id, created: info(s) });
  // Danh sách lệnh / đầy đủ (built-in, skills, custom commands) kèm mô tả, có ngay mà không cần gửi prompt.
  s.query.supportedCommands().then((cmds) => {
    s.commands = cmds.map(({ name, description, argumentHint }) => ({ name, description: description || "", argumentHint: argumentHint || "" }));
    emit({ id: s.id, msg: { type: "dash_commands", commands: s.commands } });
  }, () => {});
  (async () => {
    try {
      for await (const msg of s.query) {
        if (msg.type === "system" && msg.subtype === "init") {
          s.sessionId = msg.session_id;
          s.model = msg.model || s.model;
          s.permissionMode = msg.permissionMode || s.permissionMode;
        }
        if (msg.type === "rate_limit_event") {
          noteRateLimit(msg.rate_limit_info);
          emit({ id: s.id, usage: usageState.live });
          continue;
        }
        if (msg.type === "result") s.busy = false;
        push(s, trimMessage(msg));
        if (msg.type === "result") emit({ id: s.id, state: info(s) });
      }
    } catch (e) {
      push(s, { type: "dash_error", message: e.message });
    } finally {
      s.busy = false;
      s.closed = true;
      if (sessions.has(s.id)) emit({ id: s.id, state: info(s) });
    }
  })();
  return info(s);
}

function get(id) {
  const s = sessions.get(id);
  if (!s) throw Object.assign(new Error("Claude session not found"), { status: 404 });
  return s;
}

// content: chuỗi, hoặc mảng block (text + image base64) khi dán ảnh.
function send(id, content) {
  const s = get(id);
  if (s.closed) throw Object.assign(new Error("Session has ended, start a new one"), { status: 409 });
  const msg = { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  push(s, { ...msg, local: true });
  s.busy = true;
  emit({ id: s.id, state: info(s) });
  if (s.wake) {
    const w = s.wake;
    s.wake = null;
    w({ done: false, value: msg });
  } else s.queue.push(msg);
}

// decision: { behavior: "allow" | "allowAlways" | "deny", message, answers }
function answer(id, requestId, decision) {
  const s = get(id);
  const p = s.permissions.get(requestId);
  if (!p) throw Object.assign(new Error("Permission request is no longer pending"), { status: 409 });
  s.permissions.delete(requestId);
  let result;
  if (decision.behavior === "deny") result = { behavior: "deny", message: decision.message || "The user denied this action" };
  else {
    result = { behavior: "allow", updatedInput: decision.answers ? { ...p.input, answers: decision.answers } : p.input };
    if (decision.behavior === "allowAlways" && p.request.suggestions?.length) result.updatedPermissions = p.request.suggestions;
  }
  p.resolve(result);
  push(s, { type: "dash_permission_done", requestId, behavior: decision.behavior });
}

async function interrupt(id) {
  const s = get(id);
  for (const [rid, p] of s.permissions) {
    p.resolve({ behavior: "deny", message: "Interrupted", interrupt: true });
    s.permissions.delete(rid);
  }
  await s.query?.interrupt().catch(() => {});
}

async function configure(id, { model, permissionMode }) {
  const s = get(id);
  if (model !== undefined) {
    await s.query.setModel(model || undefined);
    s.model = model;
  }
  if (permissionMode) {
    await s.query.setPermissionMode(permissionMode);
    s.permissionMode = permissionMode;
  }
  emit({ id: s.id, state: info(s) });
  return info(s);
}

function close(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.closed = true;
  for (const p of s.permissions.values()) p.resolve({ behavior: "deny", message: "Session closed" });
  s.wake?.({ done: true, value: undefined });
  try {
    s.query?.close?.();
  } catch {}
  sessions.delete(id);
  emit({ id, ws: s.ws, removed: true });
}

const list = (ws) => [...sessions.values()].filter((s) => !ws || s.ws === ws).map(info);
const transcript = (id) => {
  const s = get(id);
  return s.commands ? [{ type: "dash_commands", commands: s.commands }, ...s.log] : s.log;
};

async function history(cwd) {
  const { listSessions } = await loadSdk();
  const items = await listSessions({ dir: cwd }).catch(() => []);
  return items
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 100)
    .map((x) => ({ sessionId: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || x.sessionId, lastModified: x.lastModified }));
}

async function models() {
  return [
    { value: "", label: "Default (from Claude settings)" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
    { value: "claude-fable-5-1", label: "Fable 5.1" },
    { value: "claude-opus-5-5", label: "Opus 5.5" },
    { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { value: "claude-haiku-5-5", label: "Haiku 5.5" },
  ];
}

module.exports = { claudeBinary, usage, start, send, answer, interrupt, configure, close, list, transcript, history, models, on: (fn) => listeners.add(fn), off: (fn) => listeners.delete(fn) };
