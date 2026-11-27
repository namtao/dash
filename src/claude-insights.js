// Claude Insights: số liệu từ transcript của Claude Code (~/.claude/projects/<thư mục>/<phiên>.jsonl và
// <phiên>/subagents/agent-*.jsonl + .meta.json). Chỉ đọc.
//
// Mỗi file được tóm tắt một lần và cache theo (mtime, size): token từng lượt gọi model, công cụ đã dùng,
// agent con đã giao, lỗi công cụ, lần compact, prompt của user và độ dài câu trả lời cuối.
// Chi phí là ước tính: Claude Code ghi "cost-state" (tiền + token theo model cho mỗi lần chạy); từ đó suy ra
// giá một token "quy đổi" của từng model (trung vị), rồi nhân với token của từng lượt.
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const HOME = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const err = (status, message) => Object.assign(new Error(message), { status });
const SID_RE = /^[A-Za-z0-9-]{8,80}$/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const INTERESTING = /"type":"(assistant|user|system|cost-state|ai-title|custom-title)"/;

// Tỉ lệ giá giữa các loại token (giống nhau ở mọi model Claude): output 5×, ghi cache 5 phút 1.25×,
// ghi cache 1 giờ 2×, đọc cache 0.1× so với input.
const weight = (i, o, c5, c1, r) => i + 5 * o + 1.25 * c5 + 2 * c1 + 0.1 * r;
const nonAscii = (s) => {
  const letters = s.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!letters) return 0;
  return letters.replace(/[\x00-\x7f]/g, "").length / letters.length;
};
const words = (s) => (s.match(/\S+/g) || []).length;
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n") : "");
const resultText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x?.type === "text" ? x.text : "")).join("\n") : "");
const countImages = (c) => (Array.isArray(c) ? c.reduce((n, b) => n + (b?.type === "image" ? 1 : b?.type === "tool_result" ? countImages(b.content) : 0), 0) : 0);
// Hook chặn có dạng "PreToolUse:Bash hook error: …"; output lệnh có chữ "hook" thì không tính
const errorKind = (t) => (/doesn't want to proceed|was rejected|user (denied|rejected)|permission (was )?denied|not allowed/i.test(t) ? "denied" : /^\S*(PreToolUse|PostToolUse|UserPromptSubmit|Stop)\S* hook|a hook changed this call/i.test(t) ? "hook" : "other");

// ---------- tóm tắt một file ----------
async function parseFile(file, kind) {
  const s = { file, kind, sessionId: "", agentId: "", cwd: "", branch: "", title: "", start: 0, end: 0, msgs: [], tools: {}, spawns: [], errors: { denied: 0, hook: 0, other: 0 }, compactions: [], summaries: [], images: 0, edits: 0, bash: [], turns: [], costs: [] };
  const seen = new Map(); // message.id → bản ghi msg (một message bị tách thành nhiều dòng, mỗi dòng một khối)
  const toolNames = new Map(); // tool_use id → tên, để biết lỗi thuộc công cụ nào
  let turn = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || !INTERESTING.test(line.slice(0, 4000))) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const t = j.timestamp ? Date.parse(j.timestamp) : 0;
    if (j.sessionId && !s.sessionId) s.sessionId = j.sessionId;
    if (j.agentId && !s.agentId) s.agentId = j.agentId;
    if (j.cwd && !s.cwd) s.cwd = j.cwd;
    if (j.gitBranch && j.gitBranch !== "HEAD") s.branch = j.gitBranch;
    if (t) {
      if (!s.start || t < s.start) s.start = t;
      if (t > s.end) s.end = t;
    }
    if (j.type === "ai-title" && j.aiTitle && !s.customTitle) s.title = j.aiTitle;
    else if (j.type === "custom-title" && j.customTitle) s.title = s.customTitle = j.customTitle;
    else if (j.type === "cost-state" && j.modelUsage) {
      const i = s.costs.findIndex((c) => c.startTime === j.startTime);
      const entry = { startTime: j.startTime, modelUsage: j.modelUsage };
      if (i >= 0) s.costs[i] = entry;
      else s.costs.push(entry);
    } else if (j.type === "system" && j.subtype === "compact_boundary") s.compactions.push(t);
    else if (j.type === "assistant" && j.message) {
      const m = j.message;
      const u = m.usage || {};
      let rec = m.id && seen.get(m.id);
      if (!rec && m.model !== "<synthetic>") {
        const cc = u.cache_creation || {};
        const c1 = cc.ephemeral_1h_input_tokens || 0;
        const c5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - c1);
        rec = { t, m: m.model || "unknown", i: u.input_tokens || 0, o: u.output_tokens || 0, c5, c1, r: u.cache_read_input_tokens || 0, sc: j.isSidechain ? 1 : 0, tl: [] };
        s.msgs.push(rec);
        if (m.id) seen.set(m.id, rec);
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "tool_use") {
          const name = b.name || "?";
          toolNames.set(b.id, name);
          rec?.tl.push(name);
          (s.tools[name] ||= { calls: 0, errors: 0 }).calls++;
          const inp = b.input || {};
          if (EDIT_TOOLS.has(name)) s.edits++;
          else if (name === "Bash" && inp.command) s.bash.push(String(inp.command).slice(0, 400));
          else if (AGENT_TOOLS.has(name)) s.spawns.push({ id: b.id, type: inp.subagent_type || "general-purpose", description: String(inp.description || "").slice(0, 120), model: inp.model || "", t });
        } else if (b?.type === "text" && b.text && turn && !j.isSidechain) turn.reply = b.text;
      }
    } else if (j.type === "user" && j.message) {
      const c = j.message.content;
      s.images += countImages(c);
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== "tool_result" || !b.is_error) continue;
          const kindE = errorKind(resultText(b.content));
          s.errors[kindE]++;
          const name = toolNames.get(b.tool_use_id);
          if (name && s.tools[name]) s.tools[name].errors++;
        }
      }
      if (j.isCompactSummary) {
        s.summaries.push(t);
        continue;
      }
      if (j.isMeta || j.isSidechain || kind !== "main") continue;
      if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) continue;
      const text = textOf(c).trim();
      if (!text || /^<(local-command|command-message|bash-|task-notification)/.test(text)) continue;
      if (turn) s.turns.push(closeTurn(turn));
      const slash = /^<command-name>/.test(text);
      turn = { t, text: slash ? (text.match(/<command-name>([^<]*)/)?.[1] || "/command") : text.slice(0, 160), slash, lang: slash ? 0 : nonAscii(text.slice(0, 2000)), reply: "" };
    }
  }
  if (turn) s.turns.push(closeTurn(turn));
  if (!s.compactions.length) s.compactions = s.summaries; // transcript cũ chỉ có bản tóm tắt
  delete s.summaries;
  return s;
}
const closeTurn = (x) => ({ t: x.t, text: x.text, slash: x.slash, lang: x.lang, words: x.reply ? words(x.reply) : -1, replyLang: x.reply ? nonAscii(x.reply.slice(0, 2000)) : 0 });

// ---------- quét và cache ----------
const cache = new Map(); // file → { key, data }
let scanning = null;

function listFiles() {
  const root = path.join(HOME(), "projects");
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) out.push({ file: path.join(dir, e.name), kind: "main" });
      else if (e.isDirectory()) {
        const sub = path.join(dir, e.name, "subagents");
        let files = [];
        try {
          files = fs.readdirSync(sub);
        } catch {
          continue;
        }
        for (const f of files) if (f.endsWith(".jsonl")) out.push({ file: path.join(sub, f), kind: "sub", parentSession: e.name });
      }
    }
  }
  return out;
}

const readMeta = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    return {};
  }
};

async function scan() {
  const files = listFiles();
  const live = new Set();
  const out = [];
  for (const f of files) {
    live.add(f.file);
    let st;
    try {
      st = fs.statSync(f.file);
    } catch {
      continue;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    let hit = cache.get(f.file);
    if (!hit || hit.key !== key) {
      const data = await parseFile(f.file, f.kind).catch(() => null);
      if (!data) continue;
      if (f.kind === "sub") {
        const meta = readMeta(f.file);
        data.sessionId ||= f.parentSession;
        data.agentType = meta.agentType || "";
        data.description = meta.description || "";
        data.toolUseId = meta.toolUseId || "";
        data.depth = meta.spawnDepth || 1;
      }
      hit = { key, data };
      cache.set(f.file, hit);
    }
    out.push(hit.data);
  }
  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
  return out;
}
// Nhiều tab cùng hỏi khi đang quét thì dùng chung một lần quét
const all = () => (scanning ||= scan().finally(() => (scanning = null)));

// Giá một token quy đổi (USD) theo model: trung vị các lần chạy có đủ token để tin được
function prices(files) {
  const r = {};
  for (const f of files)
    for (const c of f.costs)
      for (const [model, u] of Object.entries(c.modelUsage || {})) {
        const w = weight(u.inputTokens || 0, u.outputTokens || 0, u.cacheCreationEphemeral5mInputTokens ?? (u.cacheCreationInputTokens || 0) - (u.cacheCreationEphemeral1hInputTokens || 0), u.cacheCreationEphemeral1hInputTokens || 0, u.cacheReadInputTokens || 0);
        if (w > 5000 && u.costUSD > 0) (r[model] ||= []).push(u.costUSD / w);
      }
  const out = {};
  for (const [m, v] of Object.entries(r)) {
    v.sort((a, b) => a - b);
    out[m] = v[Math.floor(v.length / 2)];
  }
  return out;
}

// Gắn mỗi file subagent với loại agent, file cha và độ sâu
function linkAgents(files) {
  const bySpawn = new Map();
  for (const f of files) for (const sp of f.spawns) bySpawn.set(sp.id, { file: f, spawn: sp });
  for (const f of files) {
    if (f.kind !== "sub") continue;
    const p = f.toolUseId && bySpawn.get(f.toolUseId);
    f.parent = p ? p.file : null;
    if (!f.agentType) f.agentType = p?.spawn.type || "subagent";
    if (!f.description) f.description = p?.spawn.description || "";
  }
}
const laneType = (f) => (f.kind === "main" ? "main" : f.agentType || "subagent");

const msgCost = (x, price) => (price[x.m] ? weight(x.i, x.o, x.c5, x.c1, x.r) * price[x.m] : 0);
const ctxOf = (x) => x.i + x.c5 + x.c1 + x.r;
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const add = (o, k, v) => (o[k] = (o[k] || 0) + v);
const compileRe = (s, fallback) => {
  try {
    return new RegExp(String(s || fallback).slice(0, 500), "i");
  } catch {
    return new RegExp(fallback, "i");
  }
};
const DEFAULT_CHECK = "npm (run )?(check|test|lint)|pnpm (run )?test|yarn test|pytest|go (test|vet)|cargo (test|check)|tsc\\b|ruff|eslint|bash -n|node --check";
const GIT_WRITE = /\bgit\s+(-C\s+\S+\s+)?(commit|push|merge|rebase|reset --hard|tag)\b/;
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const IDLE = 5 * 60000; // cache prompt 5 phút hết hạn khi nghỉ lâu hơn
const REBUILD_MIN = 20000; // ghi lại ít nhất ngần này token cache sau khi nghỉ = dựng lại cả context
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const fmtUsd = (n) => `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;
const fmtPct = (v) => `${Math.round(v * 100)}%`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
// Lượt gọi ghi lại cả context sau một quãng nghỉ: trả về tiền trả thêm so với đọc cache (0 nếu không phải)
const rebuildExtra = (prevT, x, price) => (prevT && x.t - prevT > IDLE && x.c5 + x.c1 > REBUILD_MIN ? (1.25 * x.c5 + 2 * x.c1 - 0.1 * (x.c5 + x.c1)) * (price[x.m] || 0) : 0);

// ---------- tổng hợp ----------
// sid: chỉ tính một phiên (trang dòng chảy dùng để lấy các cảnh báo riêng của phiên đó)
// from (ms): tính từ mốc này tới giờ thay cho days (trang Checks dùng để hỏi Claude từ lần check gần nhất)
async function overview({ days = 30, from = 0, replyWords = 80, ctxLimit = 150000, checkRe = "", sid = "", lang = "" } = {}) {
  const files = await all();
  linkAgents(files);
  const price = prices(files);
  const span = from > 0 ? Math.max(60000, Date.now() - from) : days > 0 ? days * 86400000 : 0;
  const since = span ? Date.now() - span : 0;
  const check = compileRe(checkRe, DEFAULT_CHECK);
  const limitWords = Math.max(1, Number(replyWords) || 80);
  const limitCtx = Math.max(1000, Number(ctxLimit) || 150000);

  const tok = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let cost = 0;
  let prevCost = 0;
  const daily = {};
  const models = {};
  const projects = {};
  const team = {};
  const edges = {};
  const tools = {};
  const sessions = new Map(); // sessionId → hàng của bảng phiên
  const unpriced = new Set();
  let firstT = Infinity; // transcript cũ bị Claude Code xoá: kỳ trước thiếu dữ liệu thì không so sánh

  const sess = (f) => {
    let x = sessions.get(f.sessionId);
    if (!x) {
      x = { sessionId: f.sessionId, title: "", cwd: "", branch: "", start: 0, end: 0, cost: 0, tokens: 0, subCost: 0, subagents: 0, compactions: 0, peakCtx: 0, prompts: 0, edits: 0, checked: false, gitWrites: 0, images: 0, errors: 0, calls: 0, denied: 0, hook: 0, overCtxCost: 0, rebuilds: 0, rebuildCost: 0, searchCalls: 0, searchCost: 0, turns: [] };
      sessions.set(f.sessionId, x);
    }
    return x;
  };

  for (const f of files) {
    if (sid && f.sessionId !== sid) continue;
    for (const x of f.msgs) if (x.t < firstT) firstT = x.t;
    if (span) for (const x of f.msgs) if (x.t < since && x.t >= since - span) prevCost += msgCost(x, price);
    const msgs = f.msgs.filter((x) => x.t >= since);
    if (!msgs.length && !(f.kind === "main" && f.end >= since && f.turns.length)) continue;
    const s = sess(f);
    const type = laneType(f);
    const tm = (team[type] ||= { type, runs: 0, msgs: 0, tokens: 0, cost: 0, calls: 0, errors: 0, duration: 0, models: {} });
    tm.runs++;
    tm.duration += Math.max(0, f.end - f.start);
    if (f.kind === "main") {
      Object.assign(s, { title: f.title || s.title, cwd: f.cwd || s.cwd, branch: f.branch || s.branch, start: f.start, end: f.end });
      s.compactions += f.compactions.filter((t) => t >= since).length;
      s.turns.push(...f.turns.filter((t) => t.t >= since));
      s.prompts = s.turns.length;
      for (const x of msgs) if (!x.sc) s.peakCtx = Math.max(s.peakCtx, ctxOf(x));
    } else {
      s.subagents++;
      if (!s.cwd) s.cwd = f.cwd;
      const from = f.parent ? laneType(f.parent) : "main";
      add(edges, `${from}\u0000${type}`, 1);
    }
    s.edits += f.edits;
    s.images += f.kind === "main" ? f.images : 0;
    s.gitWrites += f.bash.filter((c) => GIT_WRITE.test(c)).length;
    if (f.bash.some((c) => check.test(c))) s.checked = true;
    s.denied += f.errors.denied;
    s.hook += f.errors.hook;
    const errs = f.errors.denied + f.errors.hook + f.errors.other;
    s.errors += errs;
    tm.errors += errs;
    for (const [name, v] of Object.entries(f.tools)) {
      const tt = (tools[name] ||= { name, calls: 0, errors: 0 });
      tt.calls += v.calls;
      tt.errors += v.errors;
      tm.calls += v.calls;
      s.calls += v.calls;
    }

    let prevT = 0;
    for (const x of msgs) {
      const c = msgCost(x, price);
      if (!price[x.m]) unpriced.add(x.m);
      const n = x.i + x.o + x.c5 + x.c1 + x.r;
      tok.input += x.i;
      tok.output += x.o;
      tok.cacheWrite += x.c5 + x.c1;
      tok.cacheRead += x.r;
      cost += c;
      const d = (daily[dayKey(x.t)] ||= { day: dayKey(x.t), cost: 0, tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, byModel: {} });
      d.cost += c;
      d.tokens += n;
      d.input += x.i;
      d.output += x.o;
      d.cacheWrite += x.c5 + x.c1;
      d.cacheRead += x.r;
      add(d.byModel, x.m, c);
      const mm = (models[x.m] ||= { model: x.m, msgs: 0, tokens: 0, output: 0, cost: 0 });
      mm.msgs++;
      mm.tokens += n;
      mm.output += x.o;
      mm.cost += c;
      const sideType = x.sc && f.kind === "main" ? "(inline sidechain)" : type;
      const tx = sideType === type ? tm : (team[sideType] ||= { type: sideType, runs: 0, msgs: 0, tokens: 0, cost: 0, calls: 0, errors: 0, duration: 0, models: {} });
      tx.msgs++;
      tx.tokens += n;
      tx.cost += c;
      add(tx.models, x.m, 1);
      s.cost += c;
      s.tokens += n;
      if (f.kind === "sub" || x.sc) s.subCost += c;
      // Các khoản tốn có thể tránh: context vượt ngưỡng, dựng lại cache sau khi nghỉ, model chính chỉ đọc file
      const rb = rebuildExtra(prevT, x, price);
      if (rb) {
        s.rebuilds++;
        s.rebuildCost += rb;
      }
      prevT = x.t;
      if (f.kind === "main" && !x.sc) {
        s.overCtxCost += 0.1 * Math.max(0, ctxOf(x) - limitCtx) * (price[x.m] || 0);
        if (x.tl.length && x.tl.every((t) => READ_TOOLS.has(t)) && !/haiku/.test(x.m)) {
          s.searchCalls++;
          s.searchCost += c;
        }
      }
    }
  }

  for (const s of sessions.values()) {
    const p = (projects[s.cwd || "(unknown)"] ||= { cwd: s.cwd || "(unknown)", sessions: 0, cost: 0, tokens: 0 });
    p.sessions++;
    p.cost += s.cost;
    p.tokens += s.tokens;
  }

  const list = [...sessions.values()].filter((s) => s.start || s.cost);
  const rows = list.map(({ turns, ...rest }) => rest);
  const prompts = list.reduce((n, s) => n + s.prompts, 0);
  const sum = (k) => list.reduce((n, s) => n + s[k], 0);
  const subCost = sum("subCost");
  return {
    generatedAt: Date.now(),
    days,
    priced: Object.keys(price),
    unpriced: [...unpriced].filter((m) => m !== "unknown"),
    kpi: {
      cost,
      prevCost: span && firstT <= since - span + 86400000 ? prevCost : null,
      tokens: tok,
      totalTokens: tok.input + tok.output + tok.cacheWrite + tok.cacheRead,
      sessions: list.filter((s) => s.start).length,
      prompts,
      subagentRuns: Object.values(team).filter((t) => t.type !== "main").reduce((n, t) => n + t.runs, 0),
      subShare: cost ? subCost / cost : 0,
      overCtxCost: sum("overCtxCost"),
      rebuildCost: sum("rebuildCost"),
    },
    daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
    models: Object.values(models).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    projects: Object.values(projects).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 10),
    team: Object.values(team).map((t) => ({ ...t, models: Object.entries(t.models).sort((a, b) => b[1] - a[1]).map(([m]) => m) })).sort((a, b) => (a.type === "main" ? -1 : b.type === "main" ? 1 : b.cost - a.cost || b.runs - a.runs)),
    edges: Object.entries(edges).map(([k, n]) => {
      const [from, to] = k.split("\u0000");
      return { from, to, n };
    }),
    ...findings(list, { limitWords, limitCtx, cost, subCost, tools: Object.values(tools), custom: !!checkRe, single: !!sid, lang }),
    sessions: rows.sort((a, b) => b.end - a.end),
  };
}

// Biến số liệu thành việc cần làm: mỗi mục nói rõ chuyện gì, vì sao tốn, làm gì, tốn bao nhiêu và các chat cần xem.
// Phép kiểm theo luật mà đạt mục tiêu thì vào "passing" (chỉ hiện một dòng). lang = "vi" thì viết tiếng Việt.
function findings(list, { limitWords, limitCtx, cost, subCost, tools, custom, single, lang }) {
  const vi = lang === "vi";
  const tr = (en, v) => (vi ? v : en);
  const n = (x, w, wv) => (vi ? `${x} ${wv}` : plural(x, w)); // tiếng Việt không có số nhiều
  const ref = (s, note) => ({ sessionId: s.sessionId, title: s.title || s.sessionId, cwd: s.cwd, branch: s.branch, end: s.end, note });
  const out = [];
  const passing = [];
  const sum = (arr, k) => arr.reduce((n, s) => n + s[k], 0);
  const k = `${Math.round(limitCtx / 1000)}k`;

  // Context lớn
  const withCtx = list.filter((s) => s.peakCtx > 0);
  const over = withCtx.filter((s) => s.peakCtx > limitCtx);
  const overCost = sum(over, "overCtxCost");
  if (over.length) {
    const peak = Math.max(...over.map((s) => s.peakCtx));
    out.push({
      id: "context",
      level: overCost > cost * 0.1 || over.length > withCtx.length * 0.25 ? "bad" : "warn",
      title: single ? tr(`This chat grew past ${k} tokens of context`, `Chat này có context vượt ${k} token`) : tr("Long chats re-send a huge context with every message", "Chat dài gửi lại một context rất lớn ở mỗi tin nhắn"),
      why: single
        ? tr("The context is sent again with every message, so late turns of a long chat cost many times more than early ones.", "Context được gửi lại ở mỗi tin nhắn, nên các lượt cuối của chat dài tốn gấp nhiều lần các lượt đầu.")
        : tr(`${over.length} of ${plural(withCtx.length, "chat")} grew past ${k} tokens (largest ${fmtTok(peak)}). The context is sent again with every message, so late turns of a long chat cost many times more than early ones.`, `${over.length}/${withCtx.length} chat có context vượt ${k} token (lớn nhất ${fmtTok(peak)}). Context được gửi lại ở mỗi tin nhắn, nên các lượt cuối của chat dài tốn gấp nhiều lần các lượt đầu.`),
      action: tr("Start a new chat (/clear) when a task is done, run /compact sooner, and let subagents do big reads so only their summary lands in the main chat.", "Xong một việc thì mở chat mới (/clear), chạy /compact sớm hơn, và để subagent đọc file lớn để chat chính chỉ nhận bản tóm tắt."),
      impact: overCost,
      impactNote: tr(`spent re-reading context above ${k}`, `tốn cho phần context vượt ${k}`),
      sessions: over.sort((a, b) => b.overCtxCost - a.overCtxCost).slice(0, 6).map((s) => ref(s, tr(`peak ${fmtTok(s.peakCtx)} · ${fmtUsd(s.overCtxCost)} above ${k} · ${plural(s.prompts, "prompt")}`, `đỉnh ${fmtTok(s.peakCtx)} · ${fmtUsd(s.overCtxCost)} vượt ${k} · ${s.prompts} prompt`))),
    });
  } else if (withCtx.length) passing.push({ label: tr(`Context under ${k}`, `Context dưới ${k}`), value: "100%" });

  // Dựng lại cache sau khi nghỉ
  const rebuilt = list.filter((s) => s.rebuilds);
  const rbCost = sum(rebuilt, "rebuildCost");
  if (rbCost >= 0.5) {
    const times = sum(rebuilt, "rebuilds");
    out.push({
      id: "cache-rebuild",
      level: rbCost > cost * 0.05 ? "bad" : "warn",
      title: tr("Coming back to a big chat after a break pays for it again", "Quay lại chat lớn sau khi nghỉ phải trả tiền context lại từ đầu"),
      why: tr(
        `The prompt cache expires after about 5 minutes idle (1 hour on some plans). The next message then writes the whole context again at 12–20× the cached price. This happened ${plural(times, "time")}${single ? "" : ` in ${plural(rebuilt.length, "chat")}`}.`,
        `Prompt cache hết hạn sau khoảng 5 phút không dùng (một số gói là 1 giờ). Tin nhắn kế tiếp phải ghi lại toàn bộ context với giá gấp 12–20 lần đọc cache. Đã xảy ra ${times} lần${single ? "" : ` trong ${rebuilt.length} chat`}.`,
      ),
      action: tr("After a long break, start a fresh chat with a short handoff note instead of continuing a big one. Finish or /compact a long chat before stepping away.", "Nghỉ lâu thì mở chat mới kèm ghi chú bàn giao ngắn thay vì tiếp tục chat lớn. Trước khi rời máy, làm xong hoặc /compact chat dài."),
      impact: rbCost,
      impactNote: tr("extra paid to rebuild the cache", "trả thêm để dựng lại cache"),
      sessions: rebuilt.sort((a, b) => b.rebuildCost - a.rebuildCost).slice(0, 6).map((s) => ref(s, tr(`${plural(s.rebuilds, "rebuild")} · ${fmtUsd(s.rebuildCost)} extra`, `dựng lại ${s.rebuilds} lần · thêm ${fmtUsd(s.rebuildCost)}`))),
    });
  }

  // Model chính chỉ đọc / tìm file
  const searchers = list.filter((s) => s.searchCalls);
  const searchCost = sum(searchers, "searchCost");
  const searchCalls = sum(searchers, "searchCalls");
  if (searchCalls >= 20 && searchCost > cost * 0.02) {
    out.push({
      id: "main-search",
      level: searchCost > cost * 0.15 ? "bad" : "warn",
      title: tr("The main model spends many turns only reading files", "Model chính tốn nhiều lượt chỉ để đọc file"),
      why: tr(
        `${plural(searchCalls, "call")} in the main chat did nothing but Read, Grep or Glob (${fmtPct(searchCost / cost)} of the cost). Each one re-sends the whole context on the most expensive model.`,
        `${searchCalls} lượt gọi trong chat chính chỉ Read, Grep hoặc Glob (${fmtPct(searchCost / cost)} chi phí). Mỗi lượt gửi lại toàn bộ context trên model đắt nhất.`,
      ),
      action: tr("Hand broad searches to the Explore agent (Haiku), read only the lines you need (offset / limit), and batch independent reads into one turn.", "Giao việc tìm rộng cho agent Explore (Haiku), chỉ đọc đúng các dòng cần (offset / limit), và gom các lần đọc độc lập vào một lượt."),
      impact: searchCost,
      impactNote: tr("spent on read-only turns in the main chat", "tốn cho các lượt chỉ đọc trong chat chính"),
      sessions: searchers.sort((a, b) => b.searchCost - a.searchCost).slice(0, 6).map((s) => ref(s, tr(`${plural(s.searchCalls, "read-only call")} · ${fmtUsd(s.searchCost)}`, `${s.searchCalls} lượt chỉ đọc · ${fmtUsd(s.searchCost)}`))),
    });
  }

  // Ảnh trong chat chính
  const img = list.filter((s) => s.images);
  const images = sum(img, "images");
  if (images >= 10) {
    out.push({
      id: "images",
      level: images >= 100 ? "bad" : "warn",
      title: tr("Screenshots pile up in the main chat", "Ảnh chụp màn hình dồn lại trong chat chính"),
      why: tr(
        `${plural(images, "image")} went into the main conversation${single ? "" : ` across ${plural(img.length, "chat")}`}. Every image stays in the context and is paid for again on each later message until the chat ends or compacts.`,
        `${images} ảnh đã vào chat chính${single ? "" : ` của ${img.length} chat`}. Mỗi ảnh nằm lại trong context và bị tính tiền lại ở mọi tin nhắn sau, tới khi chat kết thúc hoặc compact.`,
      ),
      action: tr("Check text, sizes and overflow through the DOM first, screenshot only the region you need, and let a tester agent go through batches of images.", "Kiểm chữ, kích thước, tràn bằng DOM trước, chỉ chụp đúng vùng cần xem, và để agent tester xem lượt nhiều ảnh."),
      sessions: img.sort((a, b) => b.images - a.images).slice(0, 6).map((s) => ref(s, n(s.images, "image", "ảnh"))),
    });
  }

  // Lỗi công cụ
  const calls = sum(list, "calls");
  const errors = sum(list, "errors");
  if (calls && errors / calls > 0.05) {
    const top = tools.filter((t) => t.errors).sort((a, b) => b.errors - a.errors).slice(0, 3).map((t) => `${t.name} ${t.errors}`).join(", ");
    out.push({
      id: "tool-errors",
      level: errors / calls > 0.12 ? "bad" : "warn",
      title: tr("Many tool calls fail and get retried", "Nhiều lần gọi công cụ bị lỗi rồi phải thử lại"),
      why: tr(
        `${errors} of ${calls} tool calls failed (${fmtPct(errors / calls)}), mostly ${top}. ${sum(list, "denied")} were permission denials and ${sum(list, "hook")} were blocked by hooks. Each failure costs an extra turn to read the error and try again.`,
        `${errors}/${calls} lần gọi công cụ bị lỗi (${fmtPct(errors / calls)}), nhiều nhất là ${top}. ${sum(list, "denied")} lần bị từ chối quyền, ${sum(list, "hook")} lần bị hook chặn. Mỗi lỗi tốn thêm một lượt để đọc lỗi và thử lại.`,
      ),
      action: tr("Open the worst chats to see what keeps failing. Allow safe commands that keep getting denied (/fewer-permission-prompts) and fix scripts that fail often.", "Mở các chat tệ nhất để xem cái gì hay lỗi. Cho phép sẵn các lệnh an toàn hay bị từ chối (/fewer-permission-prompts) và sửa các script hay lỗi."),
      sessions: list.filter((s) => s.errors).sort((a, b) => b.errors - a.errors).slice(0, 6).map((s) => ref(s, tr(`${s.errors} errors in ${s.calls} calls`, `${s.errors} lỗi / ${s.calls} lần gọi`))),
    });
  } else if (calls) passing.push({ label: tr("Tool calls succeed", "Gọi công cụ thành công"), value: fmtPct(1 - errors / calls) });

  // Độ dài câu trả lời
  const turns = list.flatMap((s) => s.turns.filter((t) => t.words >= 0 && !t.slash).map((t) => ({ ...t, s })));
  const long = turns.filter((t) => t.words > limitWords);
  if (turns.length) {
    const ok = 1 - long.length / turns.length;
    const med = turns.map((t) => t.words).sort((a, b) => a - b)[Math.floor(turns.length / 2)];
    if (ok < 0.8)
      out.push({
        id: "reply-length",
        level: ok < 0.5 ? "bad" : "warn",
        title: tr(`Replies are longer than your ${limitWords}-word rule`, `Câu trả lời dài hơn luật ${limitWords} từ của bạn`),
        why: tr(
          `${long.length} of ${turns.length} final replies were over ${limitWords} words (median ${med}). Output is the most expensive kind of token, and long replies are harder to read.`,
          `${long.length}/${turns.length} câu trả lời cuối vượt ${limitWords} từ (trung vị ${med}). Output là loại token đắt nhất, và trả lời dài khó đọc hơn.`,
        ),
        action: tr(`Tighten the response-style rule (for example "result first, under ${limitWords} words"), or raise the limit here if it is too strict.`, `Siết luật trả lời (ví dụ "kết quả trước, dưới ${limitWords} từ"), hoặc nâng ngưỡng ở đây nếu quá chặt.`),
        sessions: long.sort((a, b) => b.words - a.words).slice(0, 6).map((t) => ref(t.s, `${n(t.words, "word", "từ")} · “${t.text.slice(0, 60)}”`)),
      });
    else passing.push({ label: tr(`Replies ≤ ${limitWords} words`, `Trả lời ≤ ${limitWords} từ`), value: fmtPct(ok) });
  }

  // Ngôn ngữ trả lời
  const foreign = turns.filter((t) => t.lang >= 0.02);
  const miss = foreign.filter((t) => t.replyLang < 0.01);
  if (foreign.length) {
    const ok = 1 - miss.length / foreign.length;
    if (ok < 0.9)
      out.push({
        id: "reply-language",
        level: "warn",
        title: tr("Some replies are not in the language you wrote in", "Một số câu trả lời không cùng ngôn ngữ bạn viết"),
        why: tr(`${miss.length} of ${foreign.length} non-English prompts got an English reply.`, `${miss.length}/${foreign.length} prompt không phải tiếng Anh nhận câu trả lời tiếng Anh.`),
        action: tr("Put “reply in the user's language” near the top of your global rules; project rules like “UI text is English” can pull replies to English.", "Đặt “trả lời bằng ngôn ngữ của user” ở đầu rule global; rule dự án kiểu “UI text is English” có thể kéo câu trả lời sang tiếng Anh."),
        sessions: miss.slice(0, 6).map((t) => ref(t.s, `“${t.text.slice(0, 70)}”`)),
      });
    else passing.push({ label: tr("Same language as you", "Cùng ngôn ngữ với bạn"), value: fmtPct(ok) });
  }

  // Kiểm sau khi sửa code
  const edited = list.filter((s) => s.edits > 0);
  const unchecked = edited.filter((s) => !s.checked);
  if (edited.length) {
    const ok = 1 - unchecked.length / edited.length;
    if (ok < 0.8)
      out.push({
        id: "checks",
        level: ok < 0.5 ? "bad" : "warn",
        title: tr("Code was changed without running a check", "Sửa code mà không chạy lệnh kiểm"),
        why: tr(
          `${unchecked.length} of ${plural(edited.length, "chat")} that edited files never ran a check or test command${custom ? "" : " (npm run check / test, pytest, tsc, cargo test…)"}.`,
          `${unchecked.length}/${edited.length} chat có sửa file mà không chạy lệnh kiểm hay test nào${custom ? "" : " (npm run check / test, pytest, tsc, cargo test…)"}.`,
        ),
        action: tr("Name the exact check command in the project rules, or run it from a Stop hook. If your project uses another command, set it under Thresholds.", "Ghi rõ lệnh kiểm trong rule dự án, hoặc chạy nó bằng Stop hook. Dự án dùng lệnh khác thì đặt ở phần Ngưỡng."),
        sessions: unchecked.sort((a, b) => b.edits - a.edits).slice(0, 6).map((s) => ref(s, tr(`${plural(s.edits, "edit")}, no check`, `${s.edits} lần sửa, không kiểm`))),
      });
    else passing.push({ label: tr("Checks after edits", "Có kiểm sau khi sửa"), value: fmtPct(ok) });
  }

  // Ghi git
  const git = list.filter((s) => s.gitWrites);
  if (git.length) {
    const g = sum(git, "gitWrites");
    out.push({
      id: "git-writes",
      level: "info",
      title: tr("Claude ran git commit / push / reset", "Claude đã chạy git commit / push / reset"),
      why: tr(`${plural(g, "git write command")}${single ? "" : ` in ${plural(git.length, "chat")}`}.`, `${g} lệnh ghi git${single ? "" : ` trong ${git.length} chat`}.`),
      action: tr("Fine if you asked for them. If git writes should stay with you, add deny rules for them in settings.", "Không sao nếu bạn yêu cầu. Muốn tự giữ việc ghi git thì thêm luật deny trong settings."),
      sessions: git.sort((a, b) => b.gitWrites - a.gitWrites).slice(0, 6).map((s) => ref(s, n(s.gitWrites, "git write", "lệnh ghi git"))),
    });
  }

  if (!single) {
    // Giao việc cho subagent
    if (cost > 1 && subCost / cost < 0.05)
      out.push({
        id: "delegation",
        level: "info",
        title: tr("Almost all work happens in the main chat", "Gần như mọi việc đều làm trong chat chính"),
        why: tr(
          `Subagents did ${fmtPct(subCost / cost)} of the work by cost. The main chat carries the full context, so it is the most expensive place for routine searches, test runs and planned edits.`,
          `Subagent chỉ làm ${fmtPct(subCost / cost)} khối lượng tính theo chi phí. Chat chính mang toàn bộ context nên là chỗ đắt nhất để tìm kiếm, chạy test hay sửa theo plan.`,
        ),
        action: tr("Delegate broad searches to Explore, long test runs to tester, and planned multi-file phases to fullstack-developer on cheaper models.", "Giao tìm rộng cho Explore, chạy test dài cho tester, và các phase nhiều file đã có plan cho fullstack-developer trên model rẻ hơn."),
        sessions: list.filter((s) => s.cost > 0 && !s.subagents).sort((a, b) => b.cost - a.cost).slice(0, 6).map((s) => ref(s, tr(`${fmtUsd(s.cost)}, no subagent`, `${fmtUsd(s.cost)}, không dùng subagent`))),
      });
    // Vài chat chiếm phần lớn chi phí
    const top = [...list].sort((a, b) => b.cost - a.cost).slice(0, 5);
    const share = cost ? sum(top, "cost") / cost : 0;
    if (list.length >= 10 && share >= 0.3)
      out.push({
        id: "top-chats",
        level: "info",
        title: tr("A few chats make up much of the cost", "Vài chat chiếm phần lớn chi phí"),
        why: tr(`The 5 most expensive chats are ${fmtPct(share)} of the estimated cost. Open their flow to see where the tokens went.`, `5 chat đắt nhất chiếm ${fmtPct(share)} chi phí ước tính. Mở Flow của chúng để xem token đi đâu.`),
        action: tr("Look for the same pattern in each: very long chats, many screenshots, or retries after errors.", "Tìm điểm chung: chat quá dài, nhiều ảnh chụp, hay thử lại sau lỗi."),
        sessions: top.map((s) => ref(s, tr(`${fmtUsd(s.cost)} · ${plural(s.prompts, "prompt")} · peak ${fmtTok(s.peakCtx)}`, `${fmtUsd(s.cost)} · ${s.prompts} prompt · đỉnh ${fmtTok(s.peakCtx)}`))),
      });
  }

  const rank = { bad: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level] || (b.impact || 0) - (a.impact || 0));
  return { findings: out, passing };
}

// ---------- một phiên: các làn (main + từng subagent) theo thời gian ----------
async function session(sessionId, opts = {}) {
  if (!SID_RE.test(String(sessionId || ""))) throw err(400, "Invalid session id");
  const files = await all();
  linkAgents(files);
  const price = prices(files);
  const mine = files.filter((f) => f.sessionId === sessionId);
  const main = mine.find((f) => f.kind === "main");
  if (!main && !mine.length) throw err(404, "Session not found");
  const order = [];
  const visit = (f, depth) => {
    order.push({ f, depth });
    for (const c of mine.filter((x) => x.kind === "sub" && x.parent === f).sort((a, b) => a.start - b.start)) visit(c, depth + 1);
  };
  if (main) visit(main, 0);
  for (const f of mine.filter((x) => x.kind === "sub" && !order.some((o) => o.f === x)).sort((a, b) => a.start - b.start)) visit(f, 1);
  const lanes = order.map(({ f, depth }) => {
    const ev = f.msgs.map((x, i) => {
      const rb = rebuildExtra(f.msgs[i - 1]?.t, x, price);
      return { t: x.t, ctx: ctxOf(x), out: x.o, model: x.m, cost: msgCost(x, price), tools: x.tl, sc: x.sc, ...(rb ? { rb } : {}) };
    });
    return {
      id: f.agentId || f.sessionId,
      type: laneType(f),
      description: f.description || "",
      depth,
      parentId: f.parent ? f.parent.agentId || f.parent.sessionId : "",
      start: f.start,
      end: f.end,
      models: [...new Set(f.msgs.map((x) => x.m))],
      cost: ev.reduce((n, x) => n + x.cost, 0),
      tokens: f.msgs.reduce((n, x) => n + x.i + x.o + x.c5 + x.c1 + x.r, 0),
      calls: Object.values(f.tools).reduce((n, v) => n + v.calls, 0),
      errors: f.errors,
      tools: Object.entries(f.tools).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.calls - a.calls),
      events: ev,
    };
  });
  return {
    sessionId,
    title: main?.title || "",
    cwd: main?.cwd || mine[0]?.cwd || "",
    branch: main?.branch || "",
    prompts: (main?.turns || []).map((t) => ({ t: t.t, text: t.text, words: t.words })),
    compactions: main?.compactions || [],
    lanes,
    // Cảnh báo riêng của phiên: tính trên toàn bộ thời gian của phiên, cùng ngưỡng với trang tổng
    ...(await overview({ ...opts, days: 0, sid: sessionId }).then((o) => ({ findings: o.findings, passing: o.passing, cost: o.kpi.cost }))),
  };
}

// Chat chính (không gồm subagent) kèm prompt của user, để tìm các chat check/cải thiện token
const chats = async () => (await all()).filter((f) => f.kind === "main" && f.sessionId).map(({ sessionId, title, cwd, start, end, turns }) => ({ sessionId, title, cwd, start, end, turns }));

module.exports = { overview, session, chats };
