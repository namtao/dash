"use strict";
// Claude Insights (tab editor): đọc transcript Claude Code trên máy, chỉ ra chỗ tốn token và cách sửa.
// Trang tổng: vài số chính, danh sách "What to improve" (mỗi mục có lý do, việc cần làm, số tiền, chat cần xem),
// bảng chat có huy hiệu vấn đề, chi phí theo ngày / model / dự án, đội agent. Trang một phiên: cảnh báo riêng,
// dòng thời gian (làn main + subagent) và đường context có đánh dấu lần dựng lại cache.
// Màu chuỗi theo thứ tự cố định (theo model / loại công cụ), không theo thứ hạng.
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const RANGES = [
    ["7", "7 days"],
    ["30", "30 days"],
    ["90", "90 days"],
    ["all", "All"],
  ];
  const DEF_CFG = { days: "30", words: 80, ctx: 150, check: "", sort: "cost", lang: "en", askModel: "sonnet" };
  const ASK_MODELS = ["haiku", "sonnet", "opus"];
  const cfg = { ...DEF_CFG, ...store.get("claudeInsights", {}) };
  // checks: card "Checks" có trạng thái riêng để vẽ lại độc lập với số liệu chính (open = các mục đang mở, key "kind:id")
  const st = { data: null, usage: null, loading: false, error: "", q: "", checks: { data: null, loading: false, asking: false, error: "", all: false, open: new Set() } };
  let host = null;

  // ---------- định dạng ----------
  const enc = encodeURIComponent;
  const tok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
  const usd = (n) => (!n ? "$0" : n < 0.01 ? "<$0.01" : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`);
  const pct = (v, d = 0) => (v == null ? "–" : `${(v * 100).toFixed(d)}%`);
  const dur = (ms) => {
    const m = Math.round((ms || 0) / 60000);
    return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m` : `${Math.round((ms || 0) / 1000)}s`;
  };
  const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "");
  const hhmm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const clip = (s, n) => (String(s || "").length > n ? `${String(s).slice(0, n)}…` : String(s || ""));
  const tip = (...lines) => esc(lines.filter((l) => l !== "" && l != null).join("\n"));
  const shortModel = (m) => String(m || "").replace(/^claude-/, "");

  // Màu chuỗi: 8 hue theo thứ tự cố định (biến --ci0…--ci7 có bản sáng / tối), quá 8 thì xám
  const col = (i) => (i >= 0 && i < 8 ? `var(--ci${i})` : "var(--ci-other)");
  const FAMILY = ["opus", "sonnet", "haiku", "fable"];
  const modelIndex = () => {
    const extra = (st.data?.priced || []).filter((m) => !FAMILY.some((f) => m.includes(f))).sort();
    return (m) => {
      const f = FAMILY.findIndex((x) => String(m).includes(x));
      if (f >= 0) return f;
      const i = extra.indexOf(m);
      return i >= 0 ? 4 + i : 8;
    };
  };
  // Loại công cụ cho vạch trên dòng thời gian
  const TOOL_CATS = [
    ["Edit", (n) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)],
    ["Shell", (n) => /^(Bash|PowerShell|BashOutput|KillBash|Monitor)$/.test(n)],
    ["Read / search", (n) => /^(Read|Grep|Glob|LS|ToolSearch)$/.test(n)],
    ["Agent", (n) => /^(Agent|Task|SendMessage)$/.test(n)],
    ["Skill", (n) => n === "Skill"],
    ["Web", (n) => /^Web(Fetch|Search)$/.test(n)],
    ["MCP", (n) => n.startsWith("mcp__")],
    ["Other tool", () => true],
  ];
  const toolCat = (tools) => (tools?.length ? TOOL_CATS.findIndex(([, f]) => f(tools[0])) : -1);

  // ---------- SVG ----------
  const svg = (w, h, body, cls = "") => `<svg class="ci-svg ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="${NS}">${body}</svg>`;
  // Cột có đầu bo 4px phía trên, chân vuông nằm trên trục
  const topBar = (x, y, w, h, fill, r = 4) => {
    if (h <= 0 || w <= 0) return "";
    const rr = Math.min(r, h, w / 2);
    return `<path d="M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z" style="fill:${fill}"/>`;
  };
  // Thanh ngang có đầu bo 4px bên phải
  const endBar = (x, y, w, h, fill, r = 4) => {
    if (w <= 0) return "";
    const rr = Math.min(r, w, h / 2);
    return `<path d="M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z" style="fill:${fill}"/>`;
  };
  const niceMax = (v) => {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= v);
  };
  const legend = (items) => `<div class="ci-legend">${items.map(([label, color, dashed]) => `<span><i style="background:${color}"${dashed ? ' class="dash"' : ""}></i>${esc(label)}</span>`).join("")}</div>`;
  const empty = (text) => `<div class="empty">${esc(text)}</div>`;

  // ---------- biểu đồ ----------
  function dailyChart(d, width) {
    const idx = modelIndex();
    const byDay = new Map(d.daily.map((x) => [x.day, x]));
    if (!d.daily.length) return empty("No activity in this range");
    const first = new Date(d.daily[0].day + "T00:00");
    const days = [];
    for (let t = new Date(first); t <= new Date(); t.setDate(t.getDate() + 1)) {
      const k = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      days.push(byDay.get(k) || { day: k, cost: 0, tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, byModel: {} });
    }
    const models = [...new Set(d.daily.flatMap((x) => Object.keys(x.byModel)))].sort((a, b) => idx(a) - idx(b) || a.localeCompare(b));
    const H = 200;
    const L = 44;
    const B = 22;
    const plotW = Math.max(100, width - L - 6);
    const max = niceMax(Math.max(...days.map((x) => x.cost)));
    const step = plotW / days.length;
    const bw = Math.max(2, Math.min(28, step - 2));
    const y = (v) => H - B - (v / max) * (H - B - 8);
    let g = "";
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      g += `<line class="grid" x1="${L}" x2="${width - 4}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${usd(v)}</text>`;
    }
    const every = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 56)));
    days.forEach((x, i) => {
      const cx = L + i * step + (step - bw) / 2;
      let top = H - B;
      const segs = models.filter((m) => x.byModel[m] > 0);
      segs.forEach((m, k) => {
        const h = (x.byModel[m] / max) * (H - B - 8);
        const gap = k ? 2 : 0;
        const hh = Math.max(0, h - gap);
        top -= h;
        g += k === segs.length - 1 ? topBar(cx, top, bw, hh, col(idx(m))) : `<rect x="${cx}" y="${top + 0}" width="${bw}" height="${hh}" style="fill:${col(idx(m))}"/>`;
      });
      if (i % every === 0) g += `<text class="ax" x="${cx + bw / 2}" y="${H - 6}" text-anchor="middle">${x.day.slice(5).replace("-", "/")}</text>`;
      const lines = segs.sort((a, b) => x.byModel[b] - x.byModel[a]).map((m) => `${shortModel(m)}: ${usd(x.byModel[m])}`);
      g += `<rect class="hit" x="${L + i * step}" y="0" width="${step}" height="${H - B}" data-tip="${tip(new Date(x.day + "T00:00").toDateString(), `Est. cost ${usd(x.cost)} · ${tok(x.tokens)} tokens`, ...lines, x.tokens ? `in ${tok(x.input)} · out ${tok(x.output)} · cache write ${tok(x.cacheWrite)} · cache read ${tok(x.cacheRead)}` : "")}"/>`;
    });
    g += `<line class="axis" x1="${L}" x2="${width - 4}" y1="${H - B}" y2="${H - B}"/>`;
    return svg(width, H, g) + legend(models.map((m) => [shortModel(m), col(idx(m))]));
  }

  // Thanh ngang có nhãn: [{label, value, text, color, tip}]
  function hbars(rows, width, { fmt = (v) => String(v), labelW = 150 } = {}) {
    if (!rows.length) return empty("Nothing to show");
    const H = 22;
    // cột giá trị rộng theo chuỗi dài nhất để nhãn không đè lên thanh
    const valW = Math.max(48, 10 + 6.6 * Math.max(...rows.map((r) => String(r.text ?? fmt(r.value)).length)));
    const plotW = Math.max(40, width - labelW - valW);
    const max = Math.max(...rows.map((r) => r.value), 1e-9);
    let g = "";
    rows.forEach((r, i) => {
      const y = i * H;
      const w = (r.value / max) * plotW;
      g += `<text class="lbl" x="0" y="${y + 15}">${esc(clip(r.label, Math.floor(labelW / 6.6)))}</text>`;
      g += endBar(labelW, y + 6, Math.max(1, w), 10, r.color || col(0));
      g += `<text class="val" x="${width - 2}" y="${y + 15}" text-anchor="end">${esc(r.text ?? fmt(r.value))}</text>`;
      g += `<rect class="hit" x="0" y="${y}" width="${width}" height="${H}" data-tip="${r.tip || tip(r.label, r.text ?? fmt(r.value))}"/>`;
    });
    return svg(width, rows.length * H, g);
  }

  // Đội: main bên trái, mỗi tầng subagent một cột; độ dày cạnh theo số lần giao
  function teamGraph(d, width) {
    const nodes = new Map(d.team.filter((t) => t.type !== "(inline sidechain)").map((t) => [t.type, { ...t, depth: t.type === "main" ? 0 : -1 }]));
    if (!nodes.has("main")) return empty("No sessions in this range");
    const q = ["main"];
    while (q.length) {
      const k = q.shift();
      for (const e of d.edges.filter((e) => e.from === k)) {
        const n = nodes.get(e.to);
        if (n && n.depth < 0) {
          n.depth = nodes.get(k).depth + 1;
          q.push(e.to);
        }
      }
    }
    for (const n of nodes.values()) if (n.depth < 0) n.depth = 1;
    const cols = [];
    for (const n of nodes.values()) (cols[n.depth] ||= []).push(n);
    cols.forEach((c) => c.sort((a, b) => b.cost - a.cost || b.runs - a.runs));
    const NW = 168;
    const NH = 42;
    const rows = Math.max(...cols.map((c) => c.length));
    const H = Math.max(NH + 20, rows * (NH + 12) + 8);
    const gapX = cols.length > 1 ? Math.max(40, (width - NW * cols.length) / (cols.length - 1)) : 0;
    const W2 = Math.max(width, cols.length * NW + (cols.length - 1) * gapX);
    const maxCost = Math.max(...[...nodes.values()].map((n) => n.cost), 1e-9);
    cols.forEach((c, ci) =>
      c.forEach((n, ri) => {
        n.x = ci * (NW + gapX);
        n.y = ci === 0 ? H / 2 - NH / 2 : (H - c.length * (NH + 12) + 12) / 2 + ri * (NH + 12);
      }),
    );
    const maxN = Math.max(1, ...d.edges.map((e) => e.n));
    let g = "";
    for (const e of d.edges) {
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (!a || !b) continue;
      const x1 = a.x + NW;
      const y1 = a.y + NH / 2;
      const x2 = b.x;
      const y2 = b.y + NH / 2;
      const mx = (x1 + x2) / 2;
      g += `<path class="edge" d="M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2},${y2}" style="stroke-width:${1.5 + (e.n / maxN) * 4}"/>`;
      g += `<path class="hit-edge" d="M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2},${y2}" data-tip="${tip(`${e.from} → ${e.to}`, `${e.n} delegation${e.n > 1 ? "s" : ""}`)}"/>`;
      g += `<text class="ax" x="${x2 - 6}" y="${y2 - 5}" text-anchor="end">×${e.n}</text>`;
    }
    const idx = modelIndex();
    for (const n of nodes.values()) {
      const share = n.cost / maxCost;
      const m = n.models[0] || "";
      g += `<g data-tip="${tip(n.type === "main" ? "Main conversation" : n.type, `${n.runs} run${n.runs === 1 ? "" : "s"} · ${n.msgs} model calls`, `Models: ${n.models.map(shortModel).join(", ") || "–"}`, `Est. cost ${usd(n.cost)} · ${tok(n.tokens)} tokens`, `${n.calls} tool calls · ${n.errors} errors`, n.runs ? `Avg run ${dur(n.duration / n.runs)}` : "")}">
        <rect class="node${n.type === "main" ? " main" : ""}" x="${n.x}" y="${n.y}" width="${NW}" height="${NH}" rx="8"/>
        <rect x="${n.x + 8}" y="${n.y + NH - 8}" width="${Math.max(3, (NW - 16) * share)}" height="3" rx="1.5" style="fill:${col(idx(m))}"/>
        <text class="nt" x="${n.x + 10}" y="${n.y + 16}">${esc(clip(n.type === "main" ? "Main (you + Claude)" : n.type, 22))}</text>
        <text class="ns" x="${n.x + 10}" y="${n.y + 29}">${n.runs}× · ${esc(shortModel(m) || "–")} · ${usd(n.cost)}</text></g>`;
    }
    return `<div class="ci-scroll">${svg(W2, H, g, "ci-team")}</div>`;
  }

  // ---------- trang tổng ----------
  const card = (id, title, sub, wide) => `<section class="ci-card${wide ? " wide" : ""}" data-card="${id}"><header><h3>${esc(title)}</h3>${sub ? `<small class="faint">${sub}</small>` : ""}</header><div class="ci-c"></div></section>`;
  const LIMITS = [
    ["five_hour", "5-hour limit", "Hạn mức 5 giờ"],
    ["seven_day", "Weekly limit", "Hạn mức tuần"],
    ["seven_day_opus", "Opus weekly", "Hạn mức tuần Opus"],
    ["seven_day_sonnet", "Sonnet weekly", "Hạn mức tuần Sonnet"],
  ];
  const resets = (v, loc = "en-GB") => (v?.resetsAt ? new Date(v.resetsAt).toLocaleString(loc, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "–");

  function kpis(d) {
    const k = d.kpi;
    const tile = (label, value, sub, title = "", cls = "") => `<div class="ci-kpi${cls}" title="${esc(title)}"><small>${esc(label)}</small><b>${esc(value)}</b><span class="faint">${sub}</span></div>`;
    const range = d.days ? `last ${d.days} days` : "all time";
    let trend = esc(range);
    if (k.prevCost) {
      const ch = k.cost / k.prevCost - 1;
      trend = `<span class="${ch > 0.1 ? "ci-up" : ch < -0.1 ? "ci-down" : ""}">${ch >= 0 ? "▲" : "▼"} ${pct(Math.abs(ch))}</span> vs previous ${d.days} days`;
    }
    const avoid = k.overCtxCost + k.rebuildCost;
    const lim = st.usage?.limits || {};
    const meters = LIMITS.map(([key, label]) => {
      const v = lim[key];
      if (!v || typeof v.utilization !== "number") return "";
      const u = v.utilization;
      return `<div class="ci-meter ${u >= 90 ? "bad" : u >= 70 ? "warn" : "ok"}" title="Resets ${esc(resets(v))}"><span>${label}</span><span class="bar"><i style="width:${Math.min(100, u)}%"></i></span><b>${Math.round(u)}%</b></div>`;
    }).join("");
    return (
      tile("Est. cost", usd(k.cost), trend, "Estimated from Claude Code's own cost records per model. A subscription plan bills differently, but the same tokens use up its limits.") +
      tile("Cost per prompt", usd(k.prompts ? k.cost / k.prompts : 0), `${k.prompts} prompts · ${k.sessions} chats`, "Average estimated cost of one message you send, including all the work Claude does for it") +
      tile("Avoidable", usd(avoid), `${pct(avoid / Math.max(1e-9, k.cost))} of cost`, "Money spent re-reading context above your limit and rebuilding the cache after breaks. See What to improve.", avoid > k.cost * 0.1 ? " warn" : "") +
      tile("Done by subagents", pct(k.subShare), `${k.subagentRuns} subagent runs`, "Share of the cost spent in subagents. Higher usually means cheaper work, because subagents start with a small context.") +
      (meters ? `<div class="ci-kpi ci-limits"><small>Plan usage${st.usage?.plan ? ` · ${esc(st.usage.plan)}` : ""}</small>${meters}</div>` : "")
    );
  }

  // Giới hạn gói sắp hết: cảnh báo đứng đầu danh sách (dữ liệu từ /api/claude/usage, không có trong transcript)
  function limitFindings() {
    const lim = st.usage?.limits || {};
    return LIMITS.filter(([key]) => lim[key]?.utilization >= 80).map(([key, label, labelVi]) => {
      const u = lim[key].utilization;
      const t = tx();
      return { id: `limit-${key}`, level: u >= 95 ? "bad" : "warn", title: t.limTitle(cfg.lang === "vi" ? labelVi : label, Math.round(u)), why: t.limWhy(resets(lim[key], cfg.lang === "vi" ? "vi-VN" : "en-GB")), action: t.limDo, sessions: [] };
    });
  }

  const ICON = { bad: "✕", warn: "!", info: "i" };
  // Chữ của phần "What to improve" theo nút EN/VI (các cảnh báo từ server cũng nhận ?lang=)
  const TXT = {
    en: { level: { bad: "Costly", warn: "Worth fixing", info: "Good to know" }, title: "What to improve", sub: "biggest cost first · figures are estimates from your transcripts", chatTitle: "What happened in this chat", chatSub: "same checks as the overview, for this chat only", doThis: "Do this:", look: "Chats to look at", flow: "Flow", flowTip: "See where the tokens went in this chat", open: "Open chat", openTip: "Read the conversation", onTrack: "On track:", allGood: (one) => `✓ Nothing to fix${one ? " in this chat" : " in this range"}.`, cfg: "Thresholds for the checks", reply: "Reply ≤", words: "words", ctx: "Context ≤", ktok: "k tokens", check: "Check command", checkPh: "default: npm run check|test, pytest, tsc…", apply: "Apply", limTitle: (l, u) => `${l} is ${u}% used`, limWhy: (r) => `It resets ${r}. When it runs out, Claude Code stops until then.`, limDo: "Until it resets: start fresh chats instead of continuing long ones, send routine work to Sonnet / Haiku subagents, and avoid full-page screenshots." },
    vi: { level: { bad: "Tốn kém", warn: "Nên sửa", info: "Nên biết" }, title: "Cần cải thiện", sub: "tốn nhiều nhất xếp trước · số liệu ước tính từ transcript", chatTitle: "Chuyện gì đã xảy ra trong chat này", chatSub: "cùng các phép kiểm như trang tổng, chỉ cho chat này", doThis: "Nên làm:", look: "Các chat cần xem", flow: "Flow", flowTip: "Xem token của chat này đi đâu", open: "Mở chat", openTip: "Đọc cuộc trò chuyện", onTrack: "Đang ổn:", allGood: (one) => `✓ Không có gì cần sửa${one ? " trong chat này" : " trong khoảng này"}.`, cfg: "Ngưỡng của các phép kiểm", reply: "Trả lời ≤", words: "từ", ctx: "Context ≤", ktok: "k token", check: "Lệnh kiểm", checkPh: "mặc định: npm run check|test, pytest, tsc…", apply: "Áp dụng", limTitle: (l, u) => `${l} đã dùng ${u}%`, limWhy: (r) => `Reset ${r}. Hết hạn mức thì Claude Code dừng tới lúc đó.`, limDo: "Tới lúc reset: mở chat mới thay vì tiếp chat dài, giao việc thường cho subagent Sonnet / Haiku, và tránh chụp cả trang." },
  };
  const tx = () => TXT[cfg.lang] || TXT.en;
  const chatLinks = (refs, t) =>
    refs
      .map((r) => `<div class="ci-ref"><span class="ci-ref-t" title="${esc(`${r.title}\n${r.cwd || ""}`)}">${esc(clip(r.title, 70))}</span><small class="faint">${esc(r.note || "")}</small><button class="btn sm ghost" data-flow="${esc(r.sessionId)}" title="${t.flowTip}">${t.flow}</button><button class="btn sm ghost" data-chat="${esc(r.sessionId)}" title="${t.openTip}">${t.open}</button></div>`)
      .join("");
  // Danh sách việc cần làm; single = trang một phiên (không cần danh sách chat)
  function findingsHtml(list, passing, single) {
    const t = tx();
    const LEVEL = t.level;
    const items = list
      .map((f) => {
        const impact = f.impact >= 0.01 ? `<span class="ci-impact" title="${esc(f.impactNote || "")}">≈ ${usd(f.impact)}</span>` : "";
        const refs = !single && f.sessions?.length ? `<details><summary>${t.look} (${f.sessions.length})</summary>${chatLinks(f.sessions, t)}</details>` : "";
        return `<article class="ci-find ${f.level}"><span class="ci-st" title="${LEVEL[f.level]}">${ICON[f.level]}</span><div class="ci-find-main"><div class="ci-find-top"><b>${esc(f.title)}</b><small class="ci-lv">${LEVEL[f.level]}</small>${impact}</div><p>${esc(f.why)}${f.impact >= 0.01 && f.impactNote ? ` <span class="faint">(≈ ${usd(f.impact)} ${esc(f.impactNote)})</span>` : ""}</p><p class="ci-do"><b>${t.doThis}</b> ${esc(f.action)}</p>${refs}</div></article>`;
      })
      .join("");
    const ok = passing?.length ? `<div class="ci-pass"><small class="faint">${t.onTrack}</small>${passing.map((p) => `<span>✓ ${esc(p.label)} <b>${esc(p.value)}</b></span>`).join("")}</div>` : "";
    return (items || `<div class="ci-allgood">${t.allGood(single)}</div>`) + ok;
  }

  // Huy hiệu vấn đề của một chat (cùng ngưỡng với các cảnh báo)
  function issues(s) {
    const b = [];
    const limit = cfg.ctx * 1000;
    if (s.peakCtx > limit) b.push(["bad", `ctx ${tok(s.peakCtx)}`, `Context reached ${tok(s.peakCtx)} (limit ${tok(limit)}): ≈ ${usd(s.overCtxCost)} spent above the limit`]);
    if (s.rebuildCost >= 0.5) b.push(["warn", `${s.rebuilds} rebuild${s.rebuilds > 1 ? "s" : ""}`, `Cache rebuilt ${s.rebuilds}× after a break: ≈ ${usd(s.rebuildCost)} extra`]);
    if (s.images >= 5) b.push(["warn", `${s.images} images`, `${s.images} images in the main chat, re-sent on every later message`]);
    if (s.errors >= 5 && s.errors / Math.max(1, s.calls) > 0.1) b.push(["warn", `${s.errors} errors`, `${s.errors} of ${s.calls} tool calls failed`]);
    if (s.edits && !s.checked) b.push(["warn", "no check", `${s.edits} edits, no check or test command ran`]);
    if (s.gitWrites) b.push(["info", `git ×${s.gitWrites}`, `${s.gitWrites} git commit / push / reset commands`]);
    return b.map(([lv, t, title]) => `<span class="ci-badge ${lv}" title="${esc(title)}">${esc(t)}</span>`).join("");
  }

  const SHOW = 50;
  function sessionsTable(d) {
    const q = st.q.toLowerCase();
    const all = d.sessions.filter((s) => !q || `${s.title} ${s.cwd} ${s.branch}`.toLowerCase().includes(q));
    if (!all.length) return empty("No chats");
    const sorted = cfg.sort === "recent" ? all : [...all].sort((a, b) => b.cost - a.cost);
    const rows = sorted.slice(0, SHOW);
    return `<div class="ci-scroll"><table class="ci-table"><thead><tr><th>Chat</th><th>Project</th><th>Last active</th><th class="n">Prompts</th><th class="n">Est. cost</th><th class="n" title="Estimated cost of one prompt in this chat">Per prompt</th><th class="n" title="Largest context sent in one call">Peak ctx</th><th>Issues</th><th></th></tr></thead><tbody>${rows
      .map((s) => `<tr data-flow="${esc(s.sessionId)}" title="Open the flow of this chat"><td>${esc(clip(s.title || s.sessionId, 60))}</td><td class="mono faint">${esc(W.shortPath(s.cwd))}</td><td>${esc(when(s.end))}</td><td class="n">${s.prompts}</td><td class="n">${usd(s.cost)}</td><td class="n">${s.prompts ? usd(s.cost / s.prompts) : ""}</td><td class="n${s.peakCtx > cfg.ctx * 1000 ? " over" : ""}">${s.peakCtx ? tok(s.peakCtx) : ""}</td><td class="ci-issues">${issues(s)}</td><td><button class="btn sm ghost" data-chat="${esc(s.sessionId)}" title="Read the conversation">Open</button></td></tr>`)
      .join("")}</tbody></table></div>${all.length > SHOW ? `<small class="faint ci-note">Showing ${SHOW} of ${all.length} chats. Filter to find others.</small>` : ""}`;
  }

  function teamTable(d) {
    return `<div class="ci-scroll"><table class="ci-table"><thead><tr><th>Agent</th><th class="n">Runs</th><th>Models</th><th class="n">Est. cost</th><th class="n">Cost share</th><th class="n">Tool calls</th><th class="n">Errors</th><th class="n">Avg run</th></tr></thead><tbody>${d.team
      .map((t) => `<tr><td>${esc(t.type === "main" ? "Main conversation" : t.type)}</td><td class="n">${t.runs || "–"}</td><td class="faint">${esc(t.models.map(shortModel).join(", "))}</td><td class="n">${usd(t.cost)}</td><td class="n">${pct(t.cost / Math.max(1e-9, d.kpi.cost), 1)}</td><td class="n">${t.calls}</td><td class="n">${t.errors || ""}</td><td class="n">${t.runs ? dur(t.duration / t.runs) : "–"}</td></tr>`)
      .join("")}</tbody></table></div>`;
  }

  const sortBtns = () => [["cost", "Most expensive"], ["recent", "Recent"]].map(([v, l]) => `<button class="btn sm ${cfg.sort === v ? "primary" : "ghost"}" data-sort="${v}">${l}</button>`).join("");

  function paint() {
    if (!host) return;
    const d = st.data;
    $(".ci-range", host).innerHTML = RANGES.map(([v, l]) => `<button class="btn sm ${cfg.days === v ? "primary" : "ghost"}" data-range="${v}">${l}</button>`).join("");
    $(".ci-upd", host).textContent = st.loading ? "Scanning transcripts…" : st.error || (d ? `Updated ${new Date(d.generatedAt).toLocaleTimeString("en-GB")}` : "");
    const body = $(".ci-body", host);
    if (!d) {
      body.innerHTML = empty(st.error || "Loading…");
      return;
    }
    const rebuilt = body.dataset.built !== cfg.lang;
    if (rebuilt) {
      body.dataset.built = cfg.lang;
      const t = tx();
      body.innerHTML = `<div class="ci-kpis"></div><div class="ci-grid">
        ${card("daily", "Daily cost", "by model · hover a day for details", true)}
        ${card("models", "Cost by model", "")}
        ${card("projects", "Cost by project", "")}
        ${card("team", "Who does the work", "The main chat carries the whole conversation, so every step there costs the most. Subagents start small and can run cheaper models.", true)}
        <section class="ci-card wide" data-card="find"><header><h3>${t.title}</h3><small class="faint">${t.sub}</small><span class="ci-lang">${["en", "vi"].map((l) => `<button class="btn sm ${cfg.lang === l ? "primary" : "ghost"}" data-lang="${l}">${l.toUpperCase()}</button>`).join("")}</span></header><div class="ci-c"></div><details class="ci-cfg-wrap"><summary class="faint">${t.cfg}</summary><form class="ci-cfg"><label>${t.reply} <input type="number" name="words" min="5" max="2000" value="${esc(cfg.words)}" /> ${t.words}</label><label>${t.ctx} <input type="number" name="ctx" min="10" max="2000" value="${esc(cfg.ctx)}" />${t.ktok}</label><label>${t.check} <input name="check" class="mono" placeholder="${t.checkPh}" value="${esc(cfg.check)}" /></label><button class="btn sm">${t.apply}</button></form></details></section>
        ${card("checks", "Checks", "Ask Claude how to improve, using only the activity since the last check", true)}
        <section class="ci-card wide" data-card="sessions"><header><h3>Chats</h3><small class="faint">click a row to see where its tokens went</small><span class="ci-sort"></span><input type="search" class="ci-q" placeholder="Filter by title or folder" value="${esc(st.q)}" /></header><div class="ci-c"></div></section>
      </div>`;
    }
    const c = (id) => $(`[data-card="${id}"] .ci-c`, body);
    const wOf = (id) => Math.max(220, c(id).clientWidth || 600);
    const idx = modelIndex();
    $(".ci-kpis", body).innerHTML = kpis(d);
    c("find").innerHTML = findingsHtml([...limitFindings(), ...d.findings], d.passing);
    $(".ci-sort", body).innerHTML = sortBtns();
    c("sessions").innerHTML = sessionsTable(d);
    c("daily").innerHTML = dailyChart(d, wOf("daily"));
    c("models").innerHTML = hbars(
      d.models.slice(0, 9).map((m) => ({ label: shortModel(m.model), value: m.cost, color: col(idx(m.model)), text: usd(m.cost), tip: tip(m.model, `Est. cost ${usd(m.cost)}`, `${m.msgs} model calls · ${tok(m.tokens)} tokens · out ${tok(m.output)}`) })),
      wOf("models"),
      { labelW: 120 },
    );
    c("projects").innerHTML = hbars(
      d.projects.map((p) => ({ label: W.shortPath(p.cwd) || p.cwd, value: p.cost, text: usd(p.cost), tip: tip(p.cwd, `Est. cost ${usd(p.cost)}`, `${p.sessions} chats · ${tok(p.tokens)} tokens`) })),
      wOf("projects"),
      { labelW: 170 },
    );
    c("team").innerHTML = teamGraph(d, wOf("team")) + teamTable(d);
    // Card Checks tự vẽ; chỉ vẽ lại ở đây khi lưới vừa được dựng mới (nội dung cũ đã mất)
    if (rebuilt) paintChecks();
  }

  // ---------- Checks: các lần rà soát (Ask Claude, chat cải thiện token, báo cáo tuần) ----------
  const ckKey = (e) => `${e.kind}:${e.id}`;
  const ckBadge = (e) => (e.kind === "ask" ? `Ask · ${e.model || "?"}` : e.kind === "chat" ? "Chat" : "Weekly report");
  const ckEntry = (key) => st.checks.data?.entries.find((e) => ckKey(e) === key);
  const CK_SHOW = 20;

  function checkRow(e) {
    const key = ckKey(e);
    const badge = `<span class="ci-ck-badge ${e.kind}">${esc(ckBadge(e))}</span>`;
    if (e.kind === "chat") {
      return `<div class="ci-ck chat"><div class="ci-ck-row">${badge}<a href="#" class="ci-ck-t" data-flow="${esc(e.id)}" title="See where the tokens went in this chat">${esc(clip(e.title || e.id, 100))}</a><small class="faint">${esc(when(e.t))}</small></div>${e.prompt ? `<div class="ci-ck-prompt faint">${esc(clip(e.prompt, 140))}</div>` : ""}</div>`;
    }
    const title = e.kind === "ask" ? `Activity from ${when(e.from)}` : e.title || e.id;
    const meta = e.kind === "ask" ? `<small class="faint ci-ck-meta">${esc(`${e.prompts} prompts · ${usd(e.cost)} analysed`)}</small>` : "";
    const del = e.kind === "ask" ? `<div class="ci-ck-actions"><button class="btn sm ghost" data-ck="del" data-id="${esc(e.id)}" title="Delete this check">Delete</button></div>` : "";
    return `<details class="ci-ck ${e.kind}" data-key="${esc(key)}"${st.checks.open.has(key) ? " open" : ""}><summary>${badge}<span class="ci-ck-t">${esc(clip(title, 100))}</span>${meta}<small class="faint">${esc(when(e.t))}</small></summary><div class="ci-ck-body">${del}<div class="cm-md ci-md"></div></div></details>`;
  }

  // Dựng markdown lần đầu mở một mục (qua DOMPurify trong W.renderMarkdown), lỗi thì hiện chữ thô
  async function fillCheck(det) {
    const el = $(".ci-md", det);
    const e = ckEntry(det.dataset.key);
    if (!el || !e || el.dataset.done) return;
    el.dataset.done = "1";
    try {
      await W.renderMarkdown(el, e.text || "", "/x");
    } catch {
      el.textContent = e.text || "";
    }
  }

  function paintChecks() {
    const box = host && $('[data-card="checks"] .ci-c', host);
    if (!box) return;
    const k = st.checks;
    const d = k.data;
    const busy = k.asking || d?.running;
    let top = "";
    if (d) {
      const last = d.last;
      const lastAsk = last?.kind === "ask" ? ckEntry(`ask:${last.id}`) : null;
      const lastTxt = !last
        ? "no check yet · last 7 days"
        : last.kind === "chat"
          ? `last check: <a href="#" data-flow="${esc(last.id)}" title="See where the tokens went in this chat">${esc(clip(last.title || last.id, 60))}</a>`
          : `last check: Ask${lastAsk?.model ? ` · ${esc(lastAsk.model)}` : ""}`;
      top = `<span class="ci-ck-since">Since <b>${esc(when(d.since))}</b> · ${lastTxt}</span>`;
    }
    const note = busy ? `<div class="ci-ck-note faint"><span class="spinner xs"></span>Takes up to 2 minutes</div>` : "";
    const err = k.error ? `<div class="ci-ck-err">${esc(k.error)}</div>` : "";
    const entries = d?.entries || [];
    const shown = k.all ? entries : entries.slice(0, CK_SHOW);
    const list = !d ? (k.error ? "" : empty("Loading…")) : entries.length ? shown.map(checkRow).join("") : empty("No checks yet. Ask Claude to review your recent usage.");
    const more = entries.length > CK_SHOW ? `<button class="btn sm ghost ci-ck-more" data-ck="all">${k.all ? "Show fewer" : `Show all (${entries.length})`}</button>` : "";
    box.innerHTML = `<div class="ci-ck-top">${top}<span class="ci-ck-ctl"><select data-ck="model" title="Model that writes the review"${busy ? " disabled" : ""}>${ASK_MODELS.map((m) => `<option value="${m}"${cfg.askModel === m ? " selected" : ""}>${m}</option>`).join("")}</select><button class="btn sm primary" data-ck="ask"${busy ? " disabled" : ""}>${busy ? "Asking…" : "Ask Claude"}</button></span></div>${note}${err}<div class="ci-ck-list">${list}</div>${more}`;
    for (const det of box.querySelectorAll("details.ci-ck[open]")) fillCheck(det);
  }

  async function loadChecks() {
    const k = st.checks;
    if (k.loading) return;
    k.loading = true;
    try {
      k.data = await api("GET", "/api/claude/insights/checks");
      if (!k.asking) k.error = "";
    } catch (e) {
      k.error = e.message || "Could not load checks";
    }
    k.loading = false;
    paintChecks();
  }

  // Ask Claude mất 30–120 giây; xong thì tải lại danh sách và mở sẵn mục mới
  async function askClaude() {
    const k = st.checks;
    if (k.asking || k.data?.running) return;
    if (!ASK_MODELS.includes(cfg.askModel)) cfg.askModel = DEF_CFG.askModel;
    k.asking = true;
    k.error = "";
    paintChecks();
    try {
      const e = await api("POST", "/api/claude/insights/ask", { model: cfg.askModel, lang: cfg.lang, words: cfg.words, ctx: cfg.ctx * 1000, check: cfg.check });
      k.open.add(ckKey(e));
      await loadChecks();
    } catch (e) {
      k.error = e.message || "Ask failed";
      toast(k.error, "error");
    }
    k.asking = false;
    paintChecks();
  }

  async function deleteCheck(id) {
    if (!(await confirmDialog("Delete this check? The saved answer is removed.", { title: "Delete check", ok: "Delete", danger: true }))) return;
    try {
      await api("DELETE", `/api/claude/insights/checks/${enc(id)}`);
      st.checks.open.delete(`ask:${id}`);
      await loadChecks();
    } catch (e) {
      toast(e.message || "Could not delete the check", "error");
    }
  }

  // Mở transcript của một chat trong Claude Manager
  function openChat(r) {
    if (r) W.openClaudeTranscript?.({ sessionId: r.sessionId, title: r.title || r.sessionId, cwd: r.cwd, gitBranch: r.branch, lastModified: r.end });
  }
  const findRef = (sid) => st.data?.sessions.find((s) => s.sessionId === sid);

  async function load() {
    if (st.loading) return;
    st.loading = true;
    st.error = "";
    paint();
    const qs = `days=${enc(cfg.days)}&words=${enc(cfg.words)}&ctx=${enc(cfg.ctx * 1000)}&check=${enc(cfg.check)}&lang=${enc(cfg.lang)}`;
    const [d, u] = await Promise.allSettled([api("GET", `/api/claude/insights?${qs}`), api("GET", "/api/claude/usage")]);
    st.loading = false;
    if (d.status === "fulfilled") st.data = d.value;
    else st.error = d.reason?.message || "Could not read transcripts";
    if (u.status === "fulfilled") st.usage = u.value;
    paint();
  }

  // Một tooltip dùng chung cho mọi phần tử có data-tip trong tab
  function bindTip(h) {
    const box = document.createElement("div");
    box.className = "ci-tip hidden";
    h.appendChild(box);
    let cur = null;
    h.addEventListener("pointermove", (e) => {
      const el = e.target.closest?.("[data-tip]");
      if (!el) {
        box.classList.add("hidden");
        cur = null;
        return;
      }
      if (el !== cur) {
        cur = el;
        const [head, ...rest] = el.dataset.tip.split("\n");
        box.innerHTML = `<b>${esc(head)}</b>${rest.map((l) => `<div>${esc(l)}</div>`).join("")}`;
      }
      box.classList.remove("hidden");
      const r = box.getBoundingClientRect();
      const x = e.clientX + 14 + r.width > innerWidth ? e.clientX - r.width - 10 : e.clientX + 14;
      const y = e.clientY + 14 + r.height > innerHeight ? e.clientY - r.height - 10 : e.clientY + 14;
      box.style.left = `${Math.max(4, x)}px`;
      box.style.top = `${Math.max(4, y)}px`;
    });
    h.addEventListener("pointerleave", () => box.classList.add("hidden"));
  }

  // Vẽ lại khi đổi cỡ (debounce) và khi đổi theme
  function onResize(h, fn) {
    let t = 0;
    let lastW = 0;
    const ro = new ResizeObserver(() => {
      if (Math.abs(h.clientWidth - lastW) < 8) return;
      lastW = h.clientWidth;
      clearTimeout(t);
      t = setTimeout(fn, 120);
    });
    ro.observe(h);
    return ro;
  }

  function mount(h) {
    host = h;
    h.classList.add("ci-host");
    h.innerHTML = `<div class="ci"><div class="ci-head"><h2>${W.ICON.claude} Claude Insights</h2><div class="ci-range"></div><small class="ci-upd faint"></small><button class="btn sm" data-ci="reload" title="Rescan transcripts">↻ Refresh</button><button class="btn sm ghost" data-ci="manager" title="Open Claude Manager">Manager</button></div><div class="ci-body"></div></div>`;
    bindTip(h);
    const ro = onResize(h, paint);
    h.addEventListener("click", (e) => {
      const r = e.target.closest("[data-range]");
      if (r) {
        cfg.days = r.dataset.range;
        store.set("claudeInsights", cfg);
        return load();
      }
      const ch = e.target.closest("[data-chat]");
      if (ch) return openChat(findRef(ch.dataset.chat));
      const lg = e.target.closest("[data-lang]");
      if (lg) {
        cfg.lang = lg.dataset.lang;
        store.set("claudeInsights", cfg);
        return load();
      }
      const so = e.target.closest("[data-sort]");
      if (so) {
        cfg.sort = so.dataset.sort;
        store.set("claudeInsights", cfg);
        return paint();
      }
      const f = e.target.closest("[data-flow]");
      if (f) {
        e.preventDefault();
        return openFlow(f.dataset.flow);
      }
      const ck = e.target.closest("[data-ck]");
      if (ck) {
        if (ck.dataset.ck === "ask") askClaude();
        else if (ck.dataset.ck === "all") {
          st.checks.all = !st.checks.all;
          paintChecks();
        } else if (ck.dataset.ck === "del") deleteCheck(ck.dataset.id);
        return;
      }
      const a = e.target.closest("[data-ci]")?.dataset.ci;
      if (a === "reload") {
        load();
        loadChecks();
      }
      else if (a === "manager") W.run("claude.manager");
    });
    h.addEventListener("submit", (e) => {
      if (!e.target.matches(".ci-cfg")) return;
      e.preventDefault();
      const fd = new FormData(e.target);
      cfg.words = Math.max(5, Math.min(2000, Number(fd.get("words")) || DEF_CFG.words));
      cfg.ctx = Math.max(10, Math.min(2000, Number(fd.get("ctx")) || DEF_CFG.ctx));
      cfg.check = String(fd.get("check") || "").trim();
      store.set("claudeInsights", cfg);
      load();
    });
    h.addEventListener("change", (e) => {
      if (!e.target.matches('[data-ck="model"]') || !ASK_MODELS.includes(e.target.value)) return;
      cfg.askModel = e.target.value;
      store.set("claudeInsights", cfg);
    });
    // toggle không nổi bọt nên bắt ở pha capture; mở một mục thì ghi nhớ và dựng markdown
    h.addEventListener(
      "toggle",
      (e) => {
        const det = e.target;
        if (!det.matches?.("details.ci-ck")) return;
        if (det.open) {
          st.checks.open.add(det.dataset.key);
          fillCheck(det);
        } else st.checks.open.delete(det.dataset.key);
      },
      true,
    );
    h.addEventListener("input", (e) => {
      if (!e.target.matches(".ci-q")) return;
      st.q = e.target.value;
      if (st.data) $('[data-card="sessions"] .ci-c', h).innerHTML = sessionsTable(st.data);
    });
    const offTheme = () => host === h && paint();
    W.on("theme", offTheme);
    paint();
    load();
    loadChecks();
    return {
      dispose: () => {
        ro.disconnect();
        host = null;
      },
    };
  }

  function open() {
    W.openTab({ id: "claude-insights", title: "Claude Insights", icon: W.ICON.claude, persist: { kind: "claude-insights", data: {} }, create: (h) => mount(h) });
    if (host && !st.loading) load();
    if (host) loadChecks();
  }

  // ---------- dòng chảy một phiên ----------
  // Trục thời gian nén: khoảng nghỉ > 5 phút chỉ chiếm một đoạn ngắn có dấu ≈
  function timeScale(times, x0, width) {
    const GAP = 5 * 60000;
    const ts = [...new Set(times.filter(Boolean))].sort((a, b) => a - b);
    const knots = [[ts[0] || 0, 0]];
    const breaks = [];
    let acc = 0;
    for (let i = 1; i < ts.length; i++) {
      const dt = ts[i] - ts[i - 1];
      if (dt > GAP) {
        breaks.push({ at: acc + GAP / 4, from: ts[i - 1], to: ts[i] });
        acc += GAP / 2;
      } else acc += dt;
      knots.push([ts[i], acc]);
    }
    const total = Math.max(1, acc);
    const x = (t) => {
      if (t <= knots[0][0]) return x0;
      let lo = 0;
      let hi = knots.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (knots[mid][0] <= t) lo = mid;
        else hi = mid;
      }
      const [ta, va] = knots[lo];
      const [tb, vb] = knots[hi];
      const v = t >= tb ? vb : va + ((t - ta) / Math.max(1, tb - ta)) * (vb - va);
      return x0 + (v / total) * width;
    };
    return { x, breaks: breaks.map((b) => ({ ...b, x: x0 + (b.at / total) * width })), span: ts.length ? ts[ts.length - 1] - ts[0] : 0 };
  }

  function flowSvg(f, width) {
    const LW = 190;
    const RH = 30;
    const TOP = 30;
    const plotW = Math.max(200, width - LW - 12);
    const times = f.lanes.flatMap((l) => [l.start, l.end, ...l.events.map((e) => e.t)]).concat(f.prompts.map((p) => p.t));
    const sc = timeScale(times, LW, plotW);
    const H = TOP + f.lanes.length * RH + 8;
    let g = `<line class="axis" x1="${LW}" x2="${LW + plotW}" y1="${TOP - 6}" y2="${TOP - 6}"/>`;
    // nhãn giờ thưa trên trục
    let lastX = -99;
    for (const t of times.filter(Boolean).sort((a, b) => a - b)) {
      const x = sc.x(t);
      if (x - lastX < 70) continue;
      lastX = x;
      g += `<text class="ax" x="${x}" y="10" text-anchor="middle">${hhmm(t)}</text>`;
    }
    for (const b of sc.breaks) g += `<g data-tip="${tip("Idle gap collapsed", `${hhmm(b.from)} → ${hhmm(b.to)} (${dur(b.to - b.from)})`)}"><rect class="brk" x="${b.x - 5}" y="${TOP - 4}" width="10" height="${H - TOP}"/><text class="ax" x="${b.x}" y="${TOP - 10}" text-anchor="middle">≈</text></g>`;
    for (const c of f.compactions) {
      const x = sc.x(c);
      g += `<line class="compact" x1="${x}" x2="${x}" y1="${TOP - 6}" y2="${H}"/><g data-tip="${tip("Context compacted", when(c))}"><rect class="hit" x="${x - 5}" y="${TOP - 18}" width="10" height="${H - TOP + 18}"/><text class="ax cmp" x="${x}" y="${TOP - 10}" text-anchor="middle">⟲</text></g>`;
    }
    for (const p of f.prompts) {
      const x = sc.x(p.t);
      g += `<path class="prompt" d="M${x - 4},${TOP - 15}h8l-4,7z" data-tip="${tip(`Prompt · ${when(p.t)}`, clip(p.text, 160), p.words >= 0 ? `Final reply: ${p.words} words` : "")}"/>`;
    }
    const laneY = new Map();
    f.lanes.forEach((l, i) => laneY.set(l.id, TOP + i * RH + RH / 2));
    f.lanes.forEach((l, i) => {
      const y = TOP + i * RH + RH / 2;
      const label = l.type === "main" ? "Main conversation" : l.type;
      g += `<text class="lbl" x="${4 + l.depth * 12}" y="${y + 4}" data-tip="${tip(label, l.description, `${l.models.map(shortModel).join(", ")} · ${dur(l.end - l.start)}`)}">${esc(clip(label, 24 - l.depth * 2))}</text>`;
      const x1 = sc.x(l.start);
      const x2 = Math.max(x1 + 3, sc.x(l.end));
      g += `<rect class="lane${l.type === "main" ? " main" : ""}" x="${x1}" y="${y - 5}" width="${x2 - x1}" height="10" rx="5"/>`;
      if (l.parentId && laneY.has(l.parentId)) g += `<line class="spawn" x1="${x1}" x2="${x1}" y1="${laneY.get(l.parentId)}" y2="${y - 5}"/>`;
      for (const e of l.events) {
        const k = toolCat(e.tools);
        const x = sc.x(e.t);
        g += k < 0 ? `<circle cx="${x}" cy="${y}" r="2" class="ev-text"/>` : `<rect x="${x - 1.5}" y="${y - 8}" width="3" height="16" rx="1.5" style="fill:${col(k)}"/>`;
        g += `<rect class="hit" x="${x - 3}" y="${y - 10}" width="6" height="20" data-tip="${tip(`${label} · ${hhmm(e.t)}`, e.tools.length ? `Tools: ${e.tools.join(", ")}` : "Text / thinking", `${shortModel(e.model)} · context ${tok(e.ctx)} · out ${tok(e.out)}`, `Est. ${usd(e.cost)}`)}"/>`;
      }
      g += `<text class="val" x="${width - 2}" y="${y - 8}" text-anchor="end"></text>`;
    });
    return { html: svg(width, H, g), sc };
  }

  function ctxSvg(f, width, sc) {
    const main = f.lanes.find((l) => l.type === "main");
    const pts = (main?.events || []).filter((e) => !e.sc && e.ctx > 0);
    if (pts.length < 2) return "";
    const H = 150;
    const B = 18;
    const limit = cfg.ctx * 1000;
    const max = niceMax(Math.max(limit * 1.1, ...pts.map((p) => p.ctx)));
    const y = (v) => H - B - (v / max) * (H - B - 8);
    let g = "";
    for (let i = 0; i <= 4; i++) g += `<line class="grid" x1="190" x2="${width - 4}" y1="${y((max * i) / 4)}" y2="${y((max * i) / 4)}"/><text class="ax" x="184" y="${y((max * i) / 4) + 3}" text-anchor="end">${tok((max * i) / 4)}</text>`;
    g += `<line class="limit" x1="190" x2="${width - 4}" y1="${y(limit)}" y2="${y(limit)}"/><text class="ax" x="${width - 6}" y="${y(limit) - 4}" text-anchor="end">limit ${tok(limit)}</text>`;
    g += `<path class="ctx-line" d="${pts.map((p, i) => `${i ? "L" : "M"}${sc.x(p.t).toFixed(1)},${y(p.ctx).toFixed(1)}`).join("")}"/>`;
    for (const c of f.compactions) g += `<line class="compact" x1="${sc.x(c)}" x2="${sc.x(c)}" y1="4" y2="${H - B}"/>`;
    pts.forEach((p, i) => {
      const x = sc.x(p.t);
      const prev = i ? sc.x(pts[i - 1].t) : x - 4;
      const next = i < pts.length - 1 ? sc.x(pts[i + 1].t) : x + 4;
      g += `<rect class="hit" x="${(prev + x) / 2}" y="0" width="${Math.max(1, (next - prev) / 2)}" height="${H - B}" data-tip="${tip(hhmm(p.t), `Context ${tok(p.ctx)}${p.ctx > limit ? " · over limit" : ""}`, `${shortModel(p.model)} · out ${tok(p.out)} · est. ${usd(p.cost)}`)}"/>`;
    });
    // Lần dựng lại cache sau khi nghỉ: chấm vẽ sau vùng hover để tooltip của chấm thắng
    pts.forEach((p, i) => {
      if (p.rb) g += `<circle class="rb" cx="${sc.x(p.t)}" cy="${y(p.ctx)}" r="5" data-tip="${tip(`Cache rebuilt · ${hhmm(p.t)}`, `After ${dur(i ? p.t - pts[i - 1].t : 0)} idle the cache had expired, so ${tok(p.ctx)} of context was written again.`, `≈ ${usd(p.rb)} extra`)}"/>`;
    });
    g += `<line class="axis" x1="190" x2="${width - 4}" y1="${H - B}" y2="${H - B}"/>`;
    return svg(width, H, g);
  }

  function openFlow(sid) {
    const short = sid.slice(0, 8);
    W.openTab({
      id: `ciflow:${sid}`,
      title: `Flow ${short}`,
      icon: W.ICON.claude,
      create: (h) => {
        h.classList.add("ci-host");
        h.innerHTML = `<div class="ci ci-flow"><div class="ci-head"><h2>Session flow</h2><small class="ci-upd faint">Loading…</small><button class="btn sm" data-f="reload">↻ Refresh</button><button class="btn sm ghost" data-f="chat">Open conversation</button></div><div class="ci-body">${empty("Loading…")}</div></div>`;
        bindTip(h);
        let f = null;
        const draw = () => {
          if (!f) return;
          const body = $(".ci-body", h);
          const w = Math.max(480, body.clientWidth - 32); // trừ padding + viền của card
          const cost = f.lanes.reduce((n, l) => n + l.cost, 0);
          const rbs = f.lanes.find((l) => l.type === "main")?.events.filter((e) => e.rb) || [];
          const tokens = f.lanes.reduce((n, l) => n + l.tokens, 0);
          const start = Math.min(...f.lanes.map((l) => l.start).filter(Boolean));
          const end = Math.max(...f.lanes.map((l) => l.end));
          const flow = flowSvg(f, w);
          const cats = TOOL_CATS.map(([n], i) => [n, col(i)]);
          body.innerHTML = `<div class="ci-flow-head"><b>${esc(f.title || f.sessionId)}</b><small class="faint mono">${esc(W.shortPath(f.cwd))}${f.branch ? ` · ⎇ ${esc(f.branch)}` : ""}</small></div>
            <div class="ci-kpis">${[
              ["Est. cost", usd(cost)],
              ["Per prompt", f.prompts.length ? usd(cost / f.prompts.length) : "–"],
              ["Tokens", tok(tokens)],
              ["Prompts", f.prompts.length],
              ["Agents", f.lanes.length - 1],
              ["Compactions", f.compactions.length],
              ["Wall time", dur(end - start)],
            ]
              .map(([l, v]) => `<div class="ci-kpi"><small>${l}</small><b>${esc(String(v))}</b></div>`)
              .join("")}</div>
            <section class="ci-card wide"><header><h3>${tx().chatTitle}</h3><small class="faint">${tx().chatSub}</small></header>${findingsHtml(f.findings || [], f.passing, true)}</section>
            <section class="ci-card wide"><header><h3>Flow</h3><small class="faint">▼ prompt · ⟲ compaction · ≈ idle gap over 5 min collapsed · each tick is one model call</small></header>${legend([...cats, ["Text / thinking", "var(--faint)"]])}<div class="ci-scroll">${flow.html}</div></section>
            <section class="ci-card wide"><header><h3>Main context size</h3><small class="faint">tokens sent with each call: every call pays for all of it again · dashed line = your limit (${cfg.ctx}k)${rbs.length ? ` · orange dot = cache rebuilt after a break (${rbs.length}×, ≈ ${usd(rbs.reduce((n, e) => n + e.rb, 0))} extra)` : ""}</small></header>${ctxSvg(f, w, flow.sc) || empty("Not enough calls")}</section>
            <section class="ci-card wide"><header><h3>Agents in this session</h3></header><div class="ci-scroll"><table class="ci-table"><thead><tr><th>Agent</th><th>Task</th><th>Model</th><th>Start</th><th class="n">Duration</th><th class="n">Tool calls</th><th class="n">Errors</th><th class="n">Tokens</th><th class="n">Est. cost</th></tr></thead><tbody>${f.lanes
              .map((l) => `<tr><td style="padding-left:${8 + l.depth * 14}px">${esc(l.type === "main" ? "Main conversation" : l.type)}</td><td class="faint" title="${esc(l.description)}">${esc(clip(l.description, 70))}</td><td>${esc(l.models.map(shortModel).join(", "))}</td><td>${esc(hhmm(l.start))}</td><td class="n">${dur(l.end - l.start)}</td><td class="n" title="${esc(l.tools.slice(0, 8).map((t) => `${t.name} ${t.calls}`).join("\n"))}">${l.calls}</td><td class="n">${l.errors.denied + l.errors.hook + l.errors.other || ""}</td><td class="n">${tok(l.tokens)}</td><td class="n">${usd(l.cost)}</td></tr>`)
              .join("")}</tbody></table></div></section>`;
        };
        const load = async () => {
          $(".ci-upd", h).textContent = "Loading…";
          try {
            f = await api("GET", `/api/claude/insights/session/${enc(sid)}?words=${enc(cfg.words)}&ctx=${enc(cfg.ctx * 1000)}&check=${enc(cfg.check)}&lang=${enc(cfg.lang)}`);
            $(".ci-upd", h).textContent = "";
            draw();
          } catch (e) {
            $(".ci-upd", h).textContent = e.message;
            $(".ci-body", h).innerHTML = empty(e.message);
          }
        };
        h.addEventListener("click", (e) => {
          const a = e.target.closest("[data-f]")?.dataset.f;
          if (a === "reload") load();
          else if (a === "chat" && f) W.openClaudeTranscript?.({ sessionId: f.sessionId, title: f.title || f.sessionId, cwd: f.cwd, gitBranch: f.branch, lastModified: Math.max(...f.lanes.map((l) => l.end)) });
        });
        const ro = onResize(h, draw);
        W.on("theme", draw);
        load();
        return { dispose: () => ro.disconnect() };
      },
    });
  }

  W.registerRestorer("claude-insights", () => open());
  W.command("claude.insights", "Claude: Insights (what costs tokens and how to fix it)", () => open());
})();
