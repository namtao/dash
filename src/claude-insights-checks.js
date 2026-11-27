// Claude Insights › Checks: dòng thời gian các lần rà soát cách dùng Claude Code và nút "Ask Claude".
//
// Mốc "lần check gần nhất" là cái muộn nhất trong:
// - một lần Ask trước (lưu ở .dash-claude/insights-checks.json cạnh projects.json);
// - một chat mà user nhờ check/cải thiện token (nhận ra qua prompt; mốc là lúc việc đó xong, tức prompt kế tiếp
//   hoặc cuối chat).
// Ask gửi số liệu từ mốc đó tới giờ + đề xuất lần trước + cấu hình hiện tại (rule, hook, model) cho `claude -p`
// (không tool, không nạp hook/settings của user) và lưu câu trả lời thành một lần check mới.
// Báo cáo token tuần (~/.claude/reports/token-weekly/YYYY-MM-DD.md, nếu có) cũng hiện trong dòng thời gian.
const fs = require("fs");
const os = require("os");
const path = require("path");
const insights = require("./claude-insights");
const claudeManager = require("./claude-manager");

const HOME = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const FILE = () => path.join(path.dirname(require("./store").CONFIG_PATH), ".dash-claude", "insights-checks.json");
const WEEKLY = () => path.join(HOME(), "reports", "token-weekly");
const err = (status, message) => Object.assign(new Error(message), { status });
const MODELS = new Set(["haiku", "sonnet", "opus"]);
const KEEP = 50;
const DEFAULT_WINDOW = 7 * 86400000; // chưa từng check: lấy 7 ngày gần nhất
// Prompt nhờ check/cải thiện cách dùng token của Claude (tiếng Việt và tiếng Anh). Chỉ hỏi "có tốn token không" thì không tính.
const IMPROVE_RE = /(tiết kiệm|giảm|save|saving|reduce|cut)\W+(\S+\W+){0,3}token|token\W+(\S+\W+){0,3}(tuần|weekly|report|báo cáo|usage)|claude insights|cải thiện claude|improve claude/i;

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const readText = (p, max) => {
  try {
    return fs.readFileSync(p, "utf8").slice(0, max);
  } catch {
    return "";
  }
};
function saveAsks(list) {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(list.slice(-KEEP)), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
const asks = () => {
  const x = readJson(FILE(), []);
  return Array.isArray(x) ? x : [];
};

// Chat check/cải thiện: mốc là lúc xong việc đó (prompt kế tiếp hoặc cuối chat)
async function improveChats() {
  const out = [];
  for (const c of await insights.chats()) {
    let at = 0;
    let text = "";
    c.turns.forEach((t, i) => {
      if (t.slash || !IMPROVE_RE.test(t.text || "")) return;
      at = c.turns[i + 1]?.t || c.end;
      text = t.text;
    });
    if (at) out.push({ kind: "chat", id: c.sessionId, t: at, title: c.title || text.slice(0, 120), prompt: text.slice(0, 300), cwd: c.cwd });
  }
  return out;
}

function weeklyReports() {
  let names = [];
  try {
    names = fs.readdirSync(WEEKLY()).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  } catch {}
  return names.map((n) => {
    const p = path.join(WEEKLY(), n);
    let t = Date.parse(`${n.slice(0, 10)}T00:00:00`);
    try {
      t = fs.statSync(p).mtimeMs;
    } catch {}
    return { kind: "weekly", id: n.slice(0, 10), t, title: (readText(p, 300).match(/^#\s+(.+)/m) || [])[1] || n, text: readText(p, 30000) };
  });
}

// Mốc check gần nhất: Ask hoặc chat cải thiện, cái nào muộn hơn
function lastCheck(list) {
  const marks = list.filter((e) => e.kind === "ask" || e.kind === "chat").sort((a, b) => b.t - a.t);
  return marks[0] || null;
}

async function list() {
  const entries = [...asks().map((a) => ({ kind: "ask", ...a })), ...(await improveChats()), ...weeklyReports()].sort((a, b) => b.t - a.t);
  const last = lastCheck(entries);
  return { since: last ? last.t : Date.now() - DEFAULT_WINDOW, last: last ? { kind: last.kind, id: last.id, t: last.t, title: last.title || "" } : null, running: !!running, entries: entries.slice(0, 60) };
}

// Cấu hình hiện tại để Claude không đề xuất lại thứ đã có: model, hook theo sự kiện, nội dung rule
function configText() {
  const s = readJson(path.join(HOME(), "settings.json"), {}) || {};
  const L = [];
  L.push(`model: ${s.model || "(default)"} · effortLevel: ${s.effortLevel || "(default)"}`);
  if (s.modelSettings) L.push(`modelSettings: ${JSON.stringify(s.modelSettings).slice(0, 600)}`);
  for (const [ev, groups] of Object.entries(s.hooks || {})) {
    const names = (Array.isArray(groups) ? groups : []).flatMap((g) => (g.hooks || []).map((h) => path.basename(String(h.command || "").replace(/"/g, "").split(/\s+/).find((w) => /\.(c?js|mjs|sh|py)$/.test(w)) || String(h.command || "").split(/\s+/)[0] || "")));
    L.push(`hooks ${ev}: ${names.filter(Boolean).join(", ")}`);
  }
  const rulesDir = path.join(HOME(), "rules");
  let rules = [];
  try {
    rules = fs.readdirSync(rulesDir).filter((n) => n.endsWith(".md"));
  } catch {}
  for (const n of rules) L.push(`\n--- ~/.claude/rules/${n} ---\n${readText(path.join(rulesDir, n), 4000)}`);
  const md = readText(path.join(HOME(), "CLAUDE.md"), 4000);
  if (md) L.push(`\n--- ~/.claude/CLAUDE.md ---\n${md}`);
  return L.join("\n");
}

const usd = (n) => `$${(n || 0).toFixed(2)}`;
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round((n || 0) / 1000)}k`);
const day = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

function statsText(o) {
  const p = o.kpi;
  const L = [];
  L.push(`Chi phí ước tính: ${usd(p.cost)}${p.prevCost != null ? ` (khoảng dài bằng thế ngay trước đó: ${usd(p.prevCost)})` : ""} · ${p.sessions} chat · ${p.prompts} prompt · ${p.subagentRuns} lần chạy subagent (${Math.round(p.subShare * 100)}% chi phí) · vượt ngưỡng context ${usd(p.overCtxCost)} · dựng lại cache sau khi nghỉ ${usd(p.rebuildCost)}`);
  L.push(`Model: ${o.models.slice(0, 6).map((m) => `${m.model} ${usd(m.cost)} (${m.msgs} lượt)`).join(" · ")}`);
  L.push(`Đội (agent): ${o.team.slice(0, 10).map((t) => `${t.type} ${t.runs}× ${usd(t.cost)}${t.errors ? ` ${t.errors} lỗi` : ""}`).join(" · ")}`);
  L.push("\nCảnh báo theo luật:");
  for (const f of o.findings || []) L.push(`- [${f.level}] ${f.title} — ${f.why} Việc nên làm: ${f.action}${f.impact ? ` (${usd(f.impact)} ${f.impactNote || ""})` : ""}`);
  if (o.passing?.length) L.push(`Đạt: ${o.passing.map((x) => `${x.label} ${x.value}`).join(" · ")}`);
  L.push("\nChat tốn nhất:");
  for (const s of [...o.sessions].sort((a, b) => b.cost - a.cost).slice(0, 8))
    L.push(`- ${String(s.title || s.sessionId).slice(0, 80)} · ${path.basename(s.cwd || "") || "?"} · ${usd(s.cost)} · context đỉnh ${k(s.peakCtx)} · ${s.prompts} prompt · ${s.subagents} subagent · ${s.compactions} compact · ${s.images} ảnh · ${s.errors} lỗi công cụ`);
  return L.join("\n");
}

const PROMPT = {
  vi: "Viết report chi tiết bằng tiếng Việt (thuật ngữ kỹ thuật giữ tiếng Anh), Markdown, dùng đúng 3 mục:",
  en: "Write a detailed report in English, Markdown, with exactly these 3 sections:",
};
function prompt({ from, to, last, prev, stats, config, lang }) {
  const vi = lang !== "en";
  return [
    "Bạn rà soát cách user dùng Claude Code để giảm token/chi phí mà không hạ chất lượng việc làm ra.",
    `Số liệu dưới đây từ ${day(from)} tới ${day(to)} (UTC), tức kể từ lần check/cải thiện gần nhất${last ? ` (${last.kind === "ask" ? "lần Ask trước" : `chat "${String(last.title).slice(0, 80)}"`})` : ""}.`,
    "Dữ liệu chỉ đọc từ transcript; chi phí là ước tính. Không bịa số ngoài dữ liệu này. Không đề xuất thứ cấu hình hiện tại đã có, trừ khi số liệu cho thấy nó không hiệu quả.",
    vi ? PROMPT.vi : PROMPT.en,
    vi
      ? "## Kể từ lần trước — đề xuất lần trước nào đã có tác dụng, cái nào chưa, dựa vào số (không có đề xuất lần trước thì nói ngắn).\n## Vấn đề mới — chỉ cái số liệu cho thấy, xếp theo tiền có thể tiết kiệm.\n## Đề xuất — tối đa 6 mục; mỗi mục: thay đổi cụ thể (file rule/hook/setting nào, ngưỡng nào, câu chữ thêm vào), ước tính tiết kiệm, rủi ro."
      : "## Since last time — which previous suggestions worked and which did not, from the numbers (say so briefly if there were none).\n## New problems — only what the data shows, ordered by money that could be saved.\n## Suggestions — at most 6; each: the concrete change (which rule/hook/setting file, which threshold, which wording), estimated saving, risk.",
    `\n<stats>\n${stats}\n</stats>`,
    `\n<previous_suggestions>\n${prev ? prev.slice(0, 4000) : "(none)"}\n</previous_suggestions>`,
    `\n<current_config>\n${config}\n</current_config>`,
  ].join("\n");
}

let running = null;
async function ask({ model = "sonnet", lang = "vi", replyWords, ctxLimit, checkRe } = {}) {
  if (!MODELS.has(model)) throw err(400, "Unknown model");
  if (running) throw err(409, "An Ask is already running");
  running = (async () => {
    const before = await list();
    const from = before.since;
    const to = Date.now();
    const o = await insights.overview({ from, replyWords, ctxLimit, checkRe, lang: "vi" });
    if (!o.kpi.prompts && !o.kpi.cost) throw err(400, "No Claude activity since the last check");
    const prevAsk = asks().at(-1);
    // Tắt tool và chỉ nạp settings của dự án (thư mục tạm, không có): hook của user không chạy, không tốn lượt đọc file
    const text = await claudeManager.runPrint(prompt({ from, to, last: before.last, prev: prevAsk?.text, stats: statsText(o), config: configText(), lang }), 300000, { model, args: ["--tools", "", "--setting-sources", "project"] });
    const entry = { id: `ask-${to}`, t: to, from, model, lang, title: `Ask ${model}`, cost: o.kpi.cost, prompts: o.kpi.prompts, text };
    saveAsks([...asks(), entry]);
    return { kind: "ask", ...entry };
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

function remove(id) {
  const all = asks();
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) throw err(404, "Check not found");
  saveAsks(next);
  return { ok: true };
}

module.exports = { list, ask, remove };
