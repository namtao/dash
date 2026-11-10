"use strict";
// Claude Code trong panel bên phải (giống extension VS Code): nhiều phiên, tiếp tục phiên cũ, chọn model và
// chế độ quyền, xem công cụ Claude dùng (Edit/Write hiện diff), cho phép/từ chối, dán ảnh, @ để nhắc file.
// Hạn mức 5 giờ / tuần lấy từ server (đã cache, không tốn token) và hiện ở status bar.
(() => {
  const sessions = new Map(); // id -> { info, el, tools: Map, live, seen:Set, commands: [] }
  let current = store.get("claudeCurrent", null);
  let root = null;
  let usage = null;
  let models = [];
  const MODES = [
    ["default", "Ask before edits"],
    ["acceptEdits", "Accept edits"],
    ["plan", "Plan mode"],
    ["auto", "Auto"],
    ["bypassPermissions", "Bypass permissions"],
  ];

  // ---------- markdown tối giản ----------
  function md(text) {
    const blocks = [];
    let s = String(text || "").replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push(`<div class="md-code"><div class="md-code-head"><span>${esc(lang)}</span><button class="icon" data-copy-code title="Copy">⧉</button></div><pre><code>${esc(code.replace(/\n$/, ""))}</code></pre></div>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    s = esc(s)
      .replace(/^### (.*)$/gm, "<h4>$1</h4>")
      .replace(/^## (.*)$/gm, "<h3>$1</h3>")
      .replace(/^# (.*)$/gm, "<h3>$1</h3>")
      .replace(/^\s*[-*] (.*)$/gm, "<li>$1</li>")
      .replace(/^\s*\d+\. (.*)$/gm, "<li class='ol'>$1</li>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/^\|(.+)\|$/gm, (row) => `<tr>${row.slice(1, -1).split("|").map((c) => (/^\s*:?-+:?\s*$/.test(c) ? "" : `<td>${c.trim()}</td>`)).join("")}</tr>`)
      .replace(/(<tr>(?:<td>.*?<\/td>)*<\/tr>\n?)+/g, (t) => `<table class="md-table">${t.replace(/<tr><\/tr>\n?/g, "")}</table>`)
      .replace(/(<li>.*<\/li>\n?)+/g, (l) => `<ul>${l}</ul>`)
      .replace(/(<li class='ol'>.*<\/li>\n?)+/g, (l) => `<ol>${l}</ol>`)
      .replace(/\n{2,}/g, "</p><p>")
      .replace(/\n/g, "<br>");
    s = `<p>${s}</p>`.replace(/<p>(<(?:h3|h4|ul|ol|table)[\s\S]*?<\/(?:h3|h4|ul|ol|table)>)<\/p>/g, "$1");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  // ---------- diff dòng đơn giản cho Edit ----------
  function lineDiff(a, b) {
    const x = String(a ?? "").split("\n");
    const y = String(b ?? "").split("\n");
    if (x.length * y.length > 250000) return `<div class="ldiff">${x.map((l) => `<div class="del">- ${esc(l)}</div>`).join("")}${y.map((l) => `<div class="add">+ ${esc(l)}</div>`).join("")}</div>`;
    const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) out.push(`<div class="ctx">  ${esc(x[i++])}</div>`), j++;
      else if (j < y.length && (i >= x.length || dp[i][j + 1] >= dp[i + 1][j])) out.push(`<div class="add">+ ${esc(y[j++])}</div>`);
      else out.push(`<div class="del">- ${esc(x[i++])}</div>`);
    }
    return `<div class="ldiff">${out.join("")}</div>`;
  }

  // Tóm tắt input của công cụ thành một dòng dễ đọc
  function toolSummary(name, input = {}) {
    const short = (p) => (p ? W.shortPath(p).replace(`${W.shortPath(sessions.get(current)?.info.cwd || "")}/`, "") : "");
    switch (name) {
      case "Bash":
        return `<code>${esc(input.command)}</code>${input.description ? ` <span class="faint">${esc(input.description)}</span>` : ""}`;
      case "Read":
      case "Write":
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        return `<a href="#" data-open-file="${esc(input.file_path || input.notebook_path)}">${esc(short(input.file_path || input.notebook_path))}</a>${input.offset ? ` <span class="faint">from line ${input.offset}</span>` : ""}`;
      case "Glob":
      case "Grep":
        return `<code>${esc(input.pattern)}</code>${input.path ? ` in ${esc(short(input.path))}` : ""}`;
      case "WebFetch":
        return esc(input.url);
      case "WebSearch":
        return esc(input.query);
      case "Task":
      case "Agent":
        return esc(input.description || input.prompt?.slice(0, 120));
      case "TodoWrite":
        return `${(input.todos || []).length} items`;
      default:
        return `<span class="faint">${esc(JSON.stringify(input).slice(0, 160))}</span>`;
    }
  }

  function toolDetail(name, input = {}) {
    if (name === "Edit") return lineDiff(input.old_string, input.new_string);
    if (name === "MultiEdit") return (input.edits || []).map((e) => lineDiff(e.old_string, e.new_string)).join("");
    if (name === "Write") return `<pre class="tool-pre">${esc(String(input.content || "").slice(0, 6000))}</pre>`;
    if (name === "TodoWrite") return `<ul class="todos">${(input.todos || []).map((t) => `<li class="todo-${t.status}">${t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} ${esc(t.content)}</li>`).join("")}</ul>`;
    if (name === "Bash" || name === "Read" || name === "Glob" || name === "Grep" || name === "WebSearch" || name === "WebFetch") return "";
    return `<pre class="tool-pre">${esc(JSON.stringify(input, null, 2).slice(0, 6000))}</pre>`;
  }

  // ---------- thẻ công cụ (gọn: một dòng tiêu đề, bấm để mở chi tiết / kết quả) ----------
  // Mọi thẻ công cụ thu gọn mặc định (chỉ một dòng); bấm vào dòng tiêu đề để xem lệnh, diff, kết quả
  const OPEN_TOOLS = new Set();
  function toolCard(b) {
    const input = b.input || {};
    const isBash = b.name === "Bash";
    const detail = toolDetail(b.name, input);
    const diffBtn = b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit" ? `<button class="icon" data-diff-tool="${esc(b.id)}" title="Open in diff editor">◫</button>` : "";
    const sum = isBash ? `${input.description ? `${esc(input.description)} ` : ""}<code>${esc(String(input.command || "").split("\n")[0])}</code>` : toolSummary(b.name, input);
    return `<div class="tool-head" data-tool-toggle><span class="tool-dot run"></span><span class="tool-name">${esc(b.name)}</span><span class="tool-sum">${sum}</span><span class="tool-lines faint"></span>${diffBtn}<span class="tool-caret">›</span></div>
      <div class="tool-body">${isBash ? `<div class="tool-io"><span class="io-label">IN</span><pre class="tool-cmd">${esc(input.command)}</pre></div>` : ""}${detail ? `<div class="tool-detail">${detail}</div>` : ""}<div class="tool-out tool-io hidden"><span class="io-label">OUT</span><pre></pre></div></div>`;
  }

  // ---------- render một phiên ----------
  function sess(id) {
    let s = sessions.get(id);
    if (!s) {
      s = { id, info: { id }, el: document.createElement("div"), tools: new Map(), live: null, seen: new Set(), commands: [] };
      s.el.className = "cl-log";
      sessions.set(id, s);
    }
    return s;
  }

  function add(s, html, cls = "") {
    const div = document.createElement("div");
    div.className = `cl-msg ${cls}`;
    div.innerHTML = html;
    s.el.append(div);
    scrollDown(s);
    return div;
  }

  // Bám đáy như terminal: luôn cuộn xuống cuối khi nội dung mới tới, trừ khi người dùng đã tự cuộn lên.
  // Trạng thái "bám" lấy từ sự kiện scroll (trước khi nội dung lớn lên), không đo sau khi đã thêm nội dung.
  let stick = true;
  let scrollQueued = false;
  function stickToBottom() {
    const box = root && $(".cl-scroll", root);
    if (!box || !stick || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (stick) box.scrollTop = box.scrollHeight;
    });
  }
  function scrollDown(s, force) {
    if (!s || current !== s.id) return;
    if (force) stick = true;
    stickToBottom();
  }

  function renderMsg(s, m) {
    if (m.uuid) {
      if (s.seen.has(m.uuid)) return;
      s.seen.add(m.uuid);
    }
    const nested = m.parent_tool_use_id ? "nested" : "";
    if (m.type === "system" && m.subtype === "init") {
      if (!s.commands.length || typeof s.commands[0] === "string") s.commands = m.slash_commands || [];
      s.info.model = m.model;
      if (!s.inited) add(s, `<span class="faint">Session started · ${esc(m.model)} · ${esc(W.shortPath(m.cwd))}${m.permissionMode ? ` · ${esc(m.permissionMode)}` : ""}</span>`, "cl-sys");
      s.inited = true;
      paintHeader();
      return;
    }
    if (m.type === "system" && m.subtype === "compact_boundary") return add(s, `<span class="faint">— conversation compacted —</span>`, "cl-sys");
    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && !m.parent_tool_use_id) {
        if (!s.live) {
          s.live = add(s, "", "cl-assistant live");
          s.liveText = "";
        }
        s.liveText += ev.delta.text;
        s.live.innerHTML = md(s.liveText);
        scrollDown(s);
      }
      return;
    }
    if (m.type === "assistant") {
      for (const b of m.message?.content || []) {
        if (b.type === "text" && b.text.trim()) {
          if (s.live && !m.parent_tool_use_id) {
            s.live.classList.remove("live");
            s.live.innerHTML = md(b.text);
            s.live = null;
          } else add(s, md(b.text), `cl-assistant ${nested}`);
        } else if (b.type === "thinking" && b.thinking) {
          const words = b.thinking.trim().split(/\s+/).length;
          add(s, `<details><summary><span class="think-mark">✻</span> Thinking <span class="faint">· ${words} words</span></summary><div class="cl-think">${md(b.thinking)}</div></details>`, `cl-thinking ${nested}`);
        } else if (b.type === "tool_use") {
          const card = add(s, toolCard(b), `cl-tool ${nested} ${OPEN_TOOLS.has(b.name) ? "open" : ""}`);
          s.tools.set(b.id, { card, name: b.name, input: b.input });
        }
      }
      if (s.live && !m.parent_tool_use_id) {
        s.live.classList.remove("live");
        s.live = null;
      }
      return;
    }
    if (m.type === "user") {
      const content = m.message?.content;
      if (typeof content === "string" || (Array.isArray(content) && content.some((b) => b.type === "text" || b.type === "image"))) {
        if (m.parent_tool_use_id) return;
        const text = typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        if (/^<(command-|local-command|system-reminder)/.test(text.trim())) return;
        const imgs = Array.isArray(content) ? content.filter((b) => b.type === "image").map((b) => `<img src="data:${b.source.media_type};base64,${b.source.data}" />`).join("") : "";
        add(s, `<div class="cl-user-text">${esc(text)}</div>${imgs ? `<div class="cl-imgs">${imgs}</div>` : ""}`, "cl-user");
        scrollDown(s, true);
        return;
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== "tool_result") continue;
        const t = s.tools.get(b.tool_use_id);
        if (!t) continue;
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || "").join("\n") : "";
        $(".tool-dot", t.card).className = `tool-dot ${b.is_error ? "err" : "ok"}`;
        if (text.trim()) {
          const out = $(".tool-out", t.card);
          out.classList.remove("hidden");
          $("pre", out).textContent = text;
          const lines = text.split("\n").length;
          $(".tool-lines", t.card).textContent = `${lines} line${lines === 1 ? "" : "s"}`;
          t.card.classList.add("has-out");
          if (b.is_error) t.card.classList.add("failed");
        }
      }
      return;
    }
    if (m.type === "result") {
      const cost = m.total_cost_usd != null ? ` · $${m.total_cost_usd.toFixed(4)}` : "";
      add(s, `<span class="faint">${m.is_error ? `⚠ ${esc(m.subtype)}` : "✓ Done"} · ${(m.duration_ms / 1000).toFixed(1)}s · ${m.num_turns} turn(s)${cost}</span>${m.is_error && m.result ? `<div class="cl-err">${esc(m.result)}</div>` : ""}`, "cl-sys");
      return;
    }
    if (m.type === "dash_permission") return renderPermission(s, m);
    if (m.type === "dash_permission_done") {
      const el = $(`[data-perm="${m.requestId}"]`, s.el);
      if (el) {
        el.classList.add("done");
        $(".perm-actions", el).innerHTML = `<span class="faint">${{ allow: "Allowed", allowAlways: "Always allowed", deny: "Denied", cancelled: "Cancelled" }[m.behavior] || m.behavior}</span>`;
      }
      return;
    }
    if (m.type === "dash_commands") {
      s.commands = m.commands || [];
      return;
    }
    if (m.type === "dash_error") return add(s, `<div class="cl-err">${esc(m.message)}</div>`, "cl-sys");
  }

  function renderPermission(s, m) {
    if (m.toolName === "AskUserQuestion") {
      const qs = m.input?.questions || [];
      add(
        s,
        `<div class="perm" data-perm="${m.requestId}" data-ask="1">
          ${qs
            .map(
              (q, qi) => `<div class="ask-q" data-q="${qi}"><div class="ask-title"><span class="chip">${esc(q.header || "Question")}</span> ${esc(q.question)}</div>
              ${(q.options || []).map((o) => `<label class="ask-opt"><input type="${q.multiSelect ? "checkbox" : "radio"}" name="q${m.requestId}-${qi}" value="${esc(o.label)}" /> <b>${esc(o.label)}</b> <span class="faint">${esc(o.description || "")}</span></label>`).join("")}
              <input class="ask-other" placeholder="Other answer (optional)" /></div>`
            )
            .join("")}
          <div class="perm-actions"><button class="btn sm primary" data-answer="submit">Submit answers</button><button class="btn sm" data-answer="deny">Skip</button></div></div>`,
        "cl-perm"
      );
      return;
    }
    const detail = toolDetail(m.toolName, m.input);
    add(
      s,
      `<div class="perm" data-perm="${m.requestId}">
        <div class="perm-title">Allow <b>${esc(m.toolName)}</b>? ${toolSummary(m.toolName, m.input)}</div>
        ${m.reason ? `<div class="faint">${esc(m.reason)}</div>` : ""}
        ${detail ? `<div class="tool-detail">${detail}</div>` : ""}
        <div class="perm-actions"><button class="btn sm primary" data-answer="allow">Allow <kbd>Enter</kbd></button>
          ${m.suggestions?.length ? `<button class="btn sm" data-answer="allowAlways">Always allow</button>` : ""}
          <input class="perm-reason" placeholder="Tell Claude what to do instead…" /><button class="btn sm danger" data-answer="deny">Deny <kbd>Esc</kbd></button></div></div>`,
      "cl-perm"
    );
    if (current === s.id) setTimeout(() => $(`[data-perm="${m.requestId}"] [data-answer=allow]`, s.el)?.focus(), 50);
  }

  async function answerPerm(btn) {
    const box = btn.closest("[data-perm]");
    const s = sessions.get(current);
    const body = { requestId: box.dataset.perm, behavior: btn.dataset.answer };
    if (box.dataset.ask) {
      if (btn.dataset.answer === "submit") {
        const answers = {};
        const qs = s.lastAsk || [];
        $$(".ask-q", box).forEach((qEl, i) => {
          const picked = $$("input:checked", qEl).map((x) => x.value);
          const other = $(".ask-other", qEl).value.trim();
          if (other) picked.push(other);
          const q = $(".ask-title", qEl).textContent.replace(/^\s*\S+\s/, "").trim();
          answers[qs[i]?.question || q] = picked.join(", ");
        });
        body.behavior = "allow";
        body.answers = answers;
      } else body.message = "The user skipped the question";
    } else if (body.behavior === "deny") body.message = $(".perm-reason", box)?.value.trim() || "";
    await api("POST", `/api/claude/sessions/${s.id}/answer`, body).catch((e) => toast(e.message, "error"));
  }

  // ---------- khung panel ----------
  function paintHeader() {
    if (!root) return;
    const list = [...sessions.values()];
    $(".cl-tabs", root).innerHTML =
      list
        .map((s) => `<button class="cl-tab ${s.id === current ? "active" : ""} ${s.info.busy ? "busy" : ""}" data-sess="${s.id}" title="${esc(s.info.title || s.id)}\n${esc(s.info.cwd || "")}">${s.info.busy ? '<span class="spinner xs"></span>' : ""}${s.info.pending?.length ? "❗" : ""}<span class="cl-tab-title">${esc(s.info.title || s.id)}</span><span class="cl-tab-x" data-close-sess="${s.id}">✕</span></button>`)
        .join("") || `<span class="faint">No session</span>`;
    for (const x of list) x.el.classList.toggle("busy", Boolean(x.info.busy));
    const s = sessions.get(current);
    const model = $(".cl-model", root);
    model.innerHTML = models.map((m) => `<option value="${esc(m.value)}" ${(s?.info.model || W.ws().claudeModel || "") === m.value ? "selected" : ""}>${esc(m.label)}</option>`).join("") + (s?.info.model && !models.some((m) => m.value === s.info.model) ? `<option selected value="${esc(s.info.model)}">${esc(s.info.model)}</option>` : "");
    $(".cl-mode", root).innerHTML = MODES.map(([v, l]) => `<option value="${v}" ${(s?.info.permissionMode || W.ws().claudePermissionMode) === v ? "selected" : ""}>${l}</option>`).join("");
    $(".cl-stop", root).classList.toggle("hidden", !s?.info.busy);
    $(".cl-send", root).classList.toggle("hidden", Boolean(s?.info.busy));
    $(".cl-cwd", root).textContent = s ? W.shortPath(s.info.cwd) : W.shortPath(W.folder);
    paintUsage();
  }

  function showSession(id) {
    current = id;
    store.set("claudeCurrent", id);
    const scroll = $(".cl-scroll", root);
    scroll.innerHTML = "";
    const s = sessions.get(id);
    if (s) scroll.append(s.el);
    else scroll.innerHTML = emptyHtml();
    paintHeader();
    scrollDown(s, true);
  }

  const emptyHtml = () => `<div class="cl-empty">${W.ICON.claude}<h3>Claude Code</h3><p>Ask Claude to read, change and run code in <b>${esc(W.shortPath(W.folder))}</b>.</p>
    <p class="faint">Enter to send · Shift+Enter new line · @ to mention a file · / for commands · paste images · Esc to stop</p>
    <button class="btn sm" data-cl="history">Resume a past conversation…</button></div>`;

  async function newSession(opts = {}) {
    const ws = W.ws();
    if (W.isRemote(opts.cwd || W.folder)) return toast("Claude runs on this machine. Open a local folder to start a conversation.", "error");
    try {
      const info = await api("POST", "/api/claude/sessions", { ws: W.wsId, cwd: opts.cwd || W.folder, resume: opts.resume, title: opts.title, model: $(".cl-model", root)?.value ?? ws.claudeModel, permissionMode: $(".cl-mode", root)?.value || ws.claudePermissionMode });
      const s = sess(info.id);
      s.info = info;
      if (opts.resume) {
        const log = await api("GET", `/api/claude/sessions/${info.id}`).catch(() => []);
        log.forEach((m) => renderMsg(s, m));
        add(s, `<span class="faint">— resumed —</span>`, "cl-sys");
      }
      showSession(info.id);
      $(".cl-input", root)?.focus();
      return s;
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function resumePicker() {
    const list = await api("GET", `/api/claude/history?cwd=${encodeURIComponent(W.folder)}`).catch(() => []);
    if (!list.length) return toast(`No past Claude conversations in ${W.shortPath(W.folder)}`);
    const id = await W.quickPick(list.map((x) => ({ label: x.title.slice(0, 120), detail: new Date(x.lastModified).toLocaleString("en-GB"), value: x.sessionId })), { placeholder: "Resume a conversation" });
    if (id) newSession({ resume: id, title: list.find((x) => x.sessionId === id)?.title.slice(0, 30) });
  }

  // Ảnh dán vào ô nhập
  const pending = { images: [] };
  function paintAttachments() {
    $(".cl-attach", root).innerHTML = pending.images.map((im, i) => `<span class="cl-att"><img src="data:${im.media_type};base64,${im.data}" /><button class="icon" data-rm-img="${i}">✕</button></span>`).join("");
  }

  async function send() {
    const input = $(".cl-input", root);
    let text = input.value.trim();
    if (!text && !pending.images.length) return;
    // Lệnh xử lý ngay trong Dash, không gửi cho Claude.
    const local = { "/clear": clearSession, "/remote-control": remoteControl, "/rc": remoteControl }[text];
    if (local && !pending.images.length) {
      input.value = "";
      autoGrow(input);
      store.set("claudeDraft", "");
      return local();
    }
    let s = sessions.get(current);
    if (!s || s.info.closed) s = await newSession();
    if (!s) return;
    // Đính kèm file đang mở làm ngữ cảnh (như extension VS Code)
    const t = W.active;
    if ($(".cl-ctx-toggle", root).checked && t?.persist?.kind === "file" && !text.includes(t.persist.data.path)) text += `\n\n(Currently open in the editor: ${t.persist.data.path})`;
    const content = pending.images.length ? [...pending.images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })), { type: "text", text }] : text;
    input.value = "";
    pending.images = [];
    paintAttachments();
    autoGrow(input);
    store.set("claudeDraft", "");
    const hist = store.get("claudePrompts", []).filter((x) => x !== text);
    store.set("claudePrompts", [text, ...hist].slice(0, 100));
    scrollDown(s, true);
    await api("POST", `/api/claude/sessions/${s.id}/send`, { content }).catch((e) => toast(e.message, "error"));
  }

  const autoGrow = (el) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(260, el.scrollHeight)}px`;
  };

  // gợi ý @file và /lệnh
  let suggest = { items: [], sel: 0, kind: "", start: 0 };
  let fileIndex = { root: "", files: [] };
  async function updateSuggest(input) {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const at = before.match(/(^|\s)@([\w./-]*)$/);
    const slash = before.match(/^\/([\w:-]*)$/);
    const box = $(".cl-suggest", root);
    if (at) {
      if (fileIndex.root !== W.folder) {
        fileIndex = { root: W.folder, files: [] };
        const r = await api("GET", `/api/files/index?root=${encodeURIComponent(W.folder)}`).catch(() => null);
        fileIndex.files = r?.files || [];
      }
      const q = at[2].toLowerCase();
      suggest = { kind: "@", start: pos - at[2].length - 1, sel: 0, items: fileIndex.files.filter((f) => f.toLowerCase().includes(q)).slice(0, 12).map((f) => ({ label: f, value: `@${f} ` })) };
    } else if (slash) {
      const s = sessions.get(current);
      const q = slash[1].toLowerCase();
      const cmds = (s?.commands?.length ? s.commands : ["compact", "clear", "init", "review", "cost", "context", "usage", "model", "mcp", "config"]).map((c) => (typeof c === "string" ? { name: c } : c));
      if (!cmds.some((c) => c.name === "remote-control")) cmds.push({ name: "remote-control", description: "Continue in a terminal with Remote Control, to drive it from claude.ai/code or the Claude app (Dash)" });
      // Khớp đầu tên trước, rồi khớp giữa tên, rồi khớp mô tả; hiện hết (danh sách tự cuộn).
      const rank = (c) => (c.name.toLowerCase().startsWith(q) ? 0 : c.name.toLowerCase().includes(q) ? 1 : (c.description || "").toLowerCase().includes(q) ? 2 : 3);
      const items = cmds.map((c) => [rank(c), c]).filter(([r]) => r < 3).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, c]) => c);
      suggest = { kind: "/", start: 0, sel: 0, items: items.map((c) => ({ label: `/${c.name}`, hint: c.argumentHint || "", desc: c.description || "", value: `/${c.name} ` })) };
    } else suggest.items = [];
    box.classList.toggle("hidden", !suggest.items.length);
    box.innerHTML = suggest.items.map((it, i) => `<div class="${i === suggest.sel ? "sel" : ""}" data-sug="${i}"${it.desc ? ` title="${esc(it.desc)}"` : ""}><span class="sug-name">${esc(it.label)}</span>${it.hint ? ` <span class="faint">${esc(it.hint)}</span>` : ""}${it.desc ? `<span class="sug-desc faint">${esc(it.desc)}</span>` : ""}</div>`).join("");
    box.scrollTop = 0;
  }
  function applySuggest(input, i) {
    const it = suggest.items[i];
    if (!it) return;
    const pos = input.selectionStart;
    input.value = input.value.slice(0, suggest.start) + it.value + input.value.slice(pos);
    input.selectionStart = input.selectionEnd = suggest.start + it.value.length;
    suggest.items = [];
    $(".cl-suggest", root).classList.add("hidden");
    input.focus();
  }

  function mount() {
    root = $("#aux");
    root.innerHTML = `<div class="cl">
      <div class="cl-head">
        <div class="cl-tabs"></div>
        <div class="cl-head-actions"><button class="icon" data-cl="new" title="New conversation (${esc(W.keyFor("claude.new"))})">＋</button><button class="icon" data-cl="history" title="Resume past conversation">⟲</button><button class="icon" data-cl="remote" title="Remote Control: continue in a terminal and drive it from claude.ai/code or the Claude app">⇆</button><button class="icon" data-cmd="claude.manager" title="Claude Manager: all conversations, skills, hooks, MCP, plugins">☰</button><button class="icon" data-cmd="claude.toggle" title="Hide">✕</button></div>
      </div>
      <div class="cl-usage"></div>
      <div class="cl-scroll"></div>
      <div class="cl-input-wrap">
        <div class="cl-suggest hidden"></div>
        <div class="cl-attach"></div>
        <textarea class="cl-input" rows="2" placeholder="Ask Claude… (@ file, / command)"></textarea>
        <div class="cl-input-bar">
          <select class="cl-model" title="Model"></select>
          <select class="cl-mode" title="Permission mode"></select>
          <label class="check" title="Tell Claude which file is open in the editor"><input type="checkbox" class="cl-ctx-toggle" ${store.get("claudeCtx", true) ? "checked" : ""}/> file</label>
          <span class="cl-cwd faint"></span>
          <button class="btn sm danger cl-stop hidden" data-cl="stop" title="Stop (Esc)">■ Stop</button>
          <button class="btn sm primary cl-send" data-cl="send" title="Send (Enter)">Send ↵</button>
        </div>
      </div></div>`;
    const input = $(".cl-input", root);
    input.value = store.get("claudeDraft", "");
    let histIdx = -1;
    input.addEventListener("input", () => {
      autoGrow(input);
      store.set("claudeDraft", input.value);
      updateSuggest(input);
    });
    input.addEventListener("keydown", (e) => {
      if (suggest.items.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          suggest.sel = (suggest.sel + (e.key === "ArrowDown" ? 1 : -1) + suggest.items.length) % suggest.items.length;
          $$(".cl-suggest [data-sug]", root).forEach((d, i) => d.classList.toggle("sel", i === suggest.sel));
          $(".cl-suggest .sel", root)?.scrollIntoView({ block: "nearest" });
          return e.preventDefault();
        }
        if (e.key === "Enter" || e.key === "Tab") {
          applySuggest(input, suggest.sel);
          return e.preventDefault();
        }
        if (e.key === "Escape") {
          suggest.items = [];
          $(".cl-suggest", root).classList.add("hidden");
          return e.preventDefault();
        }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        histIdx = -1;
        return send();
      }
      if (e.key === "Escape" && sessions.get(current)?.info.busy) return interrupt();
      if (e.key === "ArrowUp" && !input.value.includes("\n") && input.selectionStart === 0) {
        const hist = store.get("claudePrompts", []);
        if (hist[histIdx + 1] != null) {
          histIdx++;
          input.value = hist[histIdx];
          e.preventDefault();
        }
      }
      if (e.key === "ArrowDown" && histIdx >= 0 && !input.value.includes("\n")) {
        histIdx--;
        input.value = histIdx < 0 ? "" : store.get("claudePrompts", [])[histIdx];
        e.preventDefault();
      }
    });
    input.addEventListener("paste", (e) => {
      for (const item of e.clipboardData?.items || []) {
        if (!item.type.startsWith("image/")) continue;
        e.preventDefault();
        const r = new FileReader();
        r.onload = () => {
          pending.images.push({ media_type: item.type, data: String(r.result).split(",")[1] });
          paintAttachments();
        };
        r.readAsDataURL(item.getAsFile());
      }
    });
    input.addEventListener("drop", (e) => {
      const p = e.dataTransfer.getData("text/plain");
      if (p.startsWith("/")) {
        e.preventDefault();
        mention(p);
      }
    });
    $(".cl-ctx-toggle", root).addEventListener("change", (e) => store.set("claudeCtx", e.target.checked));
    $(".cl-suggest", root).addEventListener("mousedown", (e) => {
      const d = e.target.closest("[data-sug]");
      if (d) {
        e.preventDefault();
        applySuggest(input, Number(d.dataset.sug));
      }
    });
    const box = $(".cl-scroll", root);
    box.addEventListener("scroll", () => {
      stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    });
    // Nội dung đổi ở bất cứ đâu (chữ đang stream, kết quả công cụ, ảnh tải xong) hay khung đổi cỡ đều giữ đáy.
    new MutationObserver(stickToBottom).observe(box, { childList: true, subtree: true, characterData: true });
    new ResizeObserver(stickToBottom).observe(box);
    box.addEventListener("load", stickToBottom, true);
    root.addEventListener("click", async (e) => {
      const x = e.target.closest("[data-close-sess]");
      if (x) {
        e.stopPropagation();
        return closeSession(x.dataset.closeSess);
      }
      const tab = e.target.closest("[data-sess]");
      if (tab) return showSession(tab.dataset.sess);
      const b = e.target.closest("[data-cl]");
      if (b) {
        const a = b.dataset.cl;
        if (a === "new") return newSession();
        if (a === "history") return resumePicker();
        if (a === "remote") return remoteControl();
        if (a === "send") return send();
        if (a === "stop") return interrupt();
        if (a === "usage") return loadUsage(true);
      }
      const ans = e.target.closest("[data-answer]");
      if (ans) return answerPerm(ans);
      const rm = e.target.closest("[data-rm-img]");
      if (rm) {
        pending.images.splice(Number(rm.dataset.rmImg), 1);
        return paintAttachments();
      }
      const of = e.target.closest("[data-open-file]");
      if (of) {
        e.preventDefault();
        return W.openFile(of.dataset.openFile);
      }
      const cc = e.target.closest("[data-copy-code]");
      if (cc) {
        navigator.clipboard?.writeText($("code", cc.closest(".md-code")).textContent);
        return toast("Copied", "ok", 1200);
      }
      const dt = e.target.closest("[data-diff-tool]");
      if (dt) return openToolDiff(dt.dataset.diffTool);
      const tt = e.target.closest("[data-tool-toggle]");
      if (tt && !e.target.closest("a")) return tt.closest(".cl-tool").classList.toggle("open");
    });
    root.addEventListener("keydown", (e) => {
      const perm = e.target.closest?.("[data-perm]:not(.done)");
      if (perm && e.key === "Escape" && !perm.dataset.ask) $("[data-answer=deny]", perm)?.click();
    });
    $(".cl-model", root).addEventListener("change", (e) => configure({ model: e.target.value }));
    $(".cl-mode", root).addEventListener("change", (e) => configure({ permissionMode: e.target.value }));
    showSession(sessions.has(current) ? current : [...sessions.keys()][0] || null);
  }

  async function configure(patch) {
    const s = sessions.get(current);
    if (!s || s.info.closed) return api("PUT", "/api/workspace", patch.model !== undefined ? { claudeModel: patch.model } : { claudePermissionMode: patch.permissionMode }).then(W.reloadConfig).catch(() => {});
    try {
      s.info = await api("PUT", `/api/claude/sessions/${s.id}`, patch);
      toast(patch.model !== undefined ? `Model: ${patch.model || "default"}` : `Mode: ${patch.permissionMode}`, "ok", 1500);
    } catch (e) {
      toast(e.message, "error");
    }
    paintHeader();
  }

  async function interrupt() {
    const s = sessions.get(current);
    if (s) await api("POST", `/api/claude/sessions/${s.id}/interrupt`).catch(() => {});
  }

  async function closeSession(id, ask = true) {
    const s = sessions.get(id);
    if (ask && s?.info.busy && !(await confirmDialog("Claude is still working in this conversation. Close it?", { title: "Close conversation", ok: "Close", danger: true }))) return false;
    await api("DELETE", `/api/claude/sessions/${id}`).catch(() => {});
    sessions.delete(id);
    if (current === id) showSession([...sessions.keys()][0] || null);
    else paintHeader();
    return true;
  }

  // Remote Control chỉ có ở chế độ tương tác của Claude Code CLI (SDK không bật được), nên chạy nó trong terminal.
  // Có cuộc trò chuyện đang mở thì tiếp tục chính cuộc đó; không thì chạy server `claude remote-control` ở thư mục hiện tại.
  async function remoteControl() {
    const s = sessions.get(current);
    const cwd = s?.info.cwd || W.folder;
    if (W.isRemote(cwd)) return toast("Claude runs on this machine. Open a local folder to use Remote Control.", "error");
    const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
    const mode = s?.info.permissionMode || $(".cl-mode", root)?.value || W.ws().claudePermissionMode || "default";
    let cmd;
    if (s?.info.sessionId) {
      if (s.info.busy) return toast("Claude is still working. Stop it or wait, then try again.", "error");
      const ok = await confirmDialog("Continue this conversation in a terminal with Remote Control, so you can drive it from claude.ai/code or the Claude app? It closes here; resume it later with ⟲.", { title: "Remote Control", ok: "Continue in terminal" });
      if (!ok) return;
      cmd = `claude --resume ${q(s.info.sessionId)} --remote-control ${q(s.info.title || "Dash")} --permission-mode ${q(mode)}${s.info.model ? ` --model ${q(s.info.model)}` : ""}`;
      await closeSession(current, false);
    } else cmd = `claude remote-control --name ${q(W.shortPath(cwd).split("/").pop() || "Dash")} --permission-mode ${q(mode)}`;
    await W.term.create({ cwd });
    setTimeout(() => W.term.insert(cmd, { run: true }), 700);
  }

  // /clear như Claude Code CLI: bỏ cuộc trò chuyện hiện tại, mở cuộc mới cùng thư mục, model và chế độ quyền.
  // Cuộc cũ vẫn tiếp tục được qua "Resume a past conversation".
  async function clearSession() {
    const old = sessions.get(current);
    if (old?.info.busy && !(await confirmDialog("Claude is still working in this conversation. Clear it and start a new one?", { title: "Clear conversation", ok: "Clear", danger: true }))) return;
    const s = await newSession({ cwd: old?.info.cwd });
    if (s && old) await closeSession(old.id, false);
  }

  function openToolDiff(toolId) {
    const s = sessions.get(current);
    const t = s?.tools.get(toolId);
    if (!t) return;
    const edits = t.name === "MultiEdit" ? t.input.edits : t.name === "Edit" ? [t.input] : [{ old_string: "", new_string: t.input.content }];
    const a = edits.map((x) => x.old_string).join("\n⋯\n");
    const b = edits.map((x) => x.new_string).join("\n⋯\n");
    W.openTab({
      id: `cldiff:${toolId}`,
      title: `${W.base(t.input.file_path)} (Claude)`,
      icon: W.ICON.diff,
      tooltip: t.input.file_path,
      create: (host) => {
        host.classList.add("code-host");
        host.innerHTML = `<div class="code-editor"></div>`;
        let ed;
        W.monaco().then((monaco) => {
          const lang = W.langOf(t.input.file_path);
          ed = monaco.editor.createDiffEditor($(".code-editor", host), { theme: W.monacoTheme(), automaticLayout: true, readOnly: true, fontFamily: W.ws().fontFamily, fontSize: W.ws().editorFontSize });
          ed.setModel({ original: monaco.editor.createModel(a, lang), modified: monaco.editor.createModel(b, lang) });
        });
        return { dispose: () => ed?.dispose(), layout: () => ed?.layout() };
      },
    });
  }

  function mention(p) {
    W.run("claude.focus");
    const input = $(".cl-input", root);
    const rel = p.startsWith(W.folder + "/") ? p.slice(W.folder.length + 1) : p;
    input.value += `${input.value && !input.value.endsWith(" ") ? " " : ""}@${rel} `;
    input.focus();
    autoGrow(input);
  }
  W.claudeMention = mention;
  // Mở lại một cuộc trò chuyện cũ (từ Claude Manager) trong panel Claude, đúng thư mục của nó.
  W.claudeResume = ({ sessionId, cwd, title }) => {
    if (!W.layout.showAux) W.run("claude.toggle");
    return newSession({ resume: sessionId, cwd, title: String(title || "").slice(0, 30) });
  };
  W.claudeAsk = (text) => {
    W.run("claude.focus");
    const input = $(".cl-input", root);
    input.value = text;
    autoGrow(input);
    input.focus();
  };

  // ---------- hạn mức ----------
  const LIMIT_LABELS = { five_hour: "5h", seven_day: "Week", seven_day_opus: "Opus wk", seven_day_sonnet: "Sonnet wk" };
  const level = (u) => (u >= 90 ? "bad" : u >= 70 ? "warn" : "ok");
  const resetIn = (t) => {
    if (!t) return "";
    const ms = t - Date.now();
    if (ms <= 0) return "now";
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  function limits() {
    const out = {};
    for (const k of Object.keys(LIMIT_LABELS)) {
      const base = usage?.limits?.[k];
      const live = usage?.live?.[k];
      const v = live && (!usage.fetchedAt || live.at > usage.fetchedAt) && live.utilization != null ? live : base;
      if (v && typeof v.utilization === "number") out[k] = v;
    }
    return out;
  }

  function paintUsage() {
    const l = limits();
    const keys = Object.keys(l);
    const err = usage?.error;
    W.status("claude", {
      side: "right",
      order: 5,
      cls: keys.some((k) => l[k].utilization >= 90) ? "sb-bad" : "",
      html: keys.length
        ? keys.filter((k) => k === "five_hour" || k === "seven_day").map((k) => `<span class="sb-meter ${level(l[k].utilization)}"><b>${LIMIT_LABELS[k]}</b> ${Math.round(l[k].utilization)}%</span>`).join("")
        : `${W.ICON.claude}<span>${err ? "usage ?" : "…"}</span>`,
      title: keys.length ? keys.map((k) => `${LIMIT_LABELS[k]}: ${Math.round(l[k].utilization)}% · resets in ${resetIn(l[k].resetsAt)}`).join("\n") + `\nUpdated ${usage.fetchedAt ? new Date(usage.fetchedAt).toLocaleTimeString("en-GB") : "-"} (no tokens used)${err ? `\n${err}` : ""}` : err || "Loading Claude usage",
      cmd: "claude.usage",
    });
    if (!root) return;
    $(".cl-usage", root).innerHTML = keys.length
      ? keys
          .map((k) => `<div class="meter" title="Resets in ${resetIn(l[k].resetsAt)}${l[k].resetsAt ? ` (${new Date(l[k].resetsAt).toLocaleString("en-GB")})` : ""}"><span class="meter-label">${LIMIT_LABELS[k]}</span><span class="meter-bar"><i class="${level(l[k].utilization)}" style="width:${Math.min(100, l[k].utilization)}%"></i></span><span class="meter-val">${Math.round(l[k].utilization)}%</span><span class="meter-reset faint">↻ ${resetIn(l[k].resetsAt)}</span></div>`)
          .join("") + `<button class="icon" data-cl="usage" title="Refresh usage (no tokens used)">↻</button>`
      : `<span class="faint">${esc(err || "Loading usage…")}</span>`;
  }

  async function loadUsage(force) {
    try {
      usage = await api("GET", `/api/claude/usage${force ? "?force=1" : ""}`);
    } catch (e) {
      usage = { limits: {}, error: e.message };
    }
    paintUsage();
  }
  // Server chỉ gọi endpoint khi cache quá usageRefreshSec, nên hỏi thường xuyên vẫn không tốn thêm request
  function scheduleUsage() {
    loadUsage();
    setTimeout(scheduleUsage, Math.max(30, W.ws().usageRefreshSec || 60) * 1000);
  }
  setInterval(paintUsage, 60000);

  // ---------- sự kiện server ----------
  W.onMsg("claude", (m) => {
    if (m.usage) {
      usage = { ...(usage || { limits: {} }), live: m.usage };
      return paintUsage();
    }
    if (m.ws && m.ws !== W.wsId) return; // phiên của cửa sổ khác
    if (m.removed) {
      sessions.delete(m.id);
      if (current === m.id && root) showSession([...sessions.keys()][0] || null);
      return paintHeader();
    }
    const s = sess(m.id);
    if (m.created || m.state) {
      s.info = { ...s.info, ...(m.created || m.state) };
      if (!current || !sessions.has(current)) current = m.id;
      return paintHeader();
    }
    if (m.msg) {
      if (m.msg.type === "dash_permission" && m.msg.toolName === "AskUserQuestion") s.lastAsk = m.msg.input?.questions;
      renderMsg(s, m.msg);
      if (m.msg.type === "dash_permission" && !W.layout.showAux) {
        toast(`Claude asks to use ${m.msg.toolName}`, "info", 6000);
        W.setBadge?.("claude", "!");
      }
      // Claude xong một lượt (có thể đã sửa file): làm mới Source Control và Explorer
      if (m.msg.type === "result") {
        W.scmRefresh?.();
        W.emit("git:changed");
      }
    }
  });
  W.on("ws:open", async () => {
    // Nạp lại các phiên đang chạy trên server (sau khi tải lại trang)
    const list = await api("GET", `/api/claude/sessions?ws=${encodeURIComponent(W.wsId)}`).catch(() => []);
    for (const info of list) {
      const s = sess(info.id);
      s.info = info;
      if (!s.loaded) {
        s.loaded = true;
        const log = await api("GET", `/api/claude/sessions/${info.id}`).catch(() => []);
        log.forEach((m) => renderMsg(s, m));
      }
    }
    if (root) showSession(sessions.has(current) ? current : [...sessions.keys()][0] || null);
  });
  W.on("folder", () => root && !sessions.get(current) && showSession(null));

  W.command("claude.toggle", "Claude: toggle panel", () => {
    W.layout.showAux = !W.layout.showAux;
    if (W.layout.showAux && W.narrow()) W.layout.showSidebar = false;
    store.set("layout", W.layout);
    if (W.layout.showAux && !root) mount();
    W.applyLayout();
    W.paintActivity();
    if (W.layout.showAux) setTimeout(() => $(".cl-input", root)?.focus(), 30);
  }, "Ctrl+Alt+B, Ctrl+Shift+L");
  W.command("claude.focus", "Claude: focus input", () => {
    if (!W.layout.showAux) W.run("claude.toggle");
    else $(".cl-input", root)?.focus();
  }, "Ctrl+Escape");
  W.command("claude.new", "Claude: new conversation", () => {
    if (!W.layout.showAux) W.run("claude.toggle");
    newSession();
  }, "Ctrl+Alt+N");
  W.command("claude.resume", "Claude: resume past conversation…", () => {
    if (!W.layout.showAux) W.run("claude.toggle");
    resumePicker();
  });
  W.command("claude.usage", "Claude: refresh usage limits", () => loadUsage(true));
  W.command("claude.mentionFile", "Claude: mention current file", () => W.active?.persist?.data?.path && mention(W.active.persist.data.path), "Ctrl+Alt+K");

  W.on("ready", async () => {
    models = await api("GET", "/api/claude/models").catch(() => [{ value: "", label: "Default" }]);
    if (W.layout.showAux) mount();
    scheduleUsage();
  });
})();
