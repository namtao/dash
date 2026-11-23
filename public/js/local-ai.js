"use strict";
// Chat với AI chạy trên máy (OpenAI-compatible: Ollama, LM Studio…), nằm ngay dưới nút Claude trên activity bar.
// Server làm proxy và stream câu trả lời (SSE); hội thoại lưu trong trình duyệt theo cửa sổ.
// Giống khung chat Claude: bám đáy khi có nội dung mới (trừ khi người dùng tự cuộn lên), phần suy nghĩ mở trong lúc
// model đang nghĩ rồi tự thu gọn, và model gọi được công cụ (đọc / tìm file tự chạy; ghi file, sửa file, chạy lệnh
// phải được người dùng cho phép).
(() => {
  let root = null;
  let messages = store.get("aiChat", []); // [{ role, content, think?, tool_calls?, tool_call_id?, name?, ok? }]
  let ctrl = null;
  let allowAll = false; // "Allow all" cho hội thoại hiện tại
  const MAX_ROUNDS = 25;
  const save = () => store.set("aiChat", messages.slice(-80));
  const toolsOn = () => store.get("aiTools", true);

  // Một số model trả phần suy nghĩ trong <think>…</think>
  const split = (text) => {
    const m = String(text || "").match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
    return m ? { think: m[1].trim(), content: text.slice(m[0].length).trim(), open: !m[2] } : { think: "", content: text || "", open: false };
  };

  // ---------- bám đáy như khung chat Claude ----------
  let stick = true;
  let scrollQueued = false;
  const box = () => root && $(".ai-log", root);
  function stickToBottom() {
    const b = box();
    if (!b || !stick || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (stick) b.scrollTop = b.scrollHeight;
    });
  }
  const scrollDown = () => ((stick = true), stickToBottom());

  // ---------- công cụ ----------
  const TOOL_LABEL = { read_file: "Read", list_dir: "List", search: "Search", write_file: "Write", edit_file: "Edit", run_command: "Bash" };
  const NEEDS_OK = new Set(["write_file", "edit_file", "run_command"]);
  const args = (c) => {
    try {
      return JSON.parse(c.function?.arguments || "{}") || {};
    } catch {
      return {};
    }
  };
  // Đường dẫn tương đối tính từ thư mục đang mở (kể cả thư mục ssh://)
  function resolvePath(p) {
    p = String(p || "").trim() || ".";
    const base = String(W.folder || "").replace(/\/+$/, "");
    const host = base.match(/^ssh:\/\/[^/]+/)?.[0];
    if (p.startsWith("ssh://") || p.startsWith("~")) return p;
    if (p.startsWith("/")) return host ? host + p : p;
    const rel = p.replace(/^\.\/?/, "");
    return rel ? `${base}/${rel}` : base;
  }
  const rel = (p) => (p && W.folder && p.startsWith(`${W.folder.replace(/\/+$/, "")}/`) ? p.slice(W.folder.replace(/\/+$/, "").length + 1) : W.shortPath(p || ""));

  function toolSummary(name, a) {
    if (name === "run_command") return `<code>${esc(String(a.command || "").split("\n")[0])}</code>`;
    if (name === "search") return `<code>${esc(a.query || "")}</code>${a.include ? ` <span class="faint">in ${esc(a.include)}</span>` : ""}`;
    if (a.path != null) {
      const full = resolvePath(a.path);
      return name === "list_dir" ? esc(rel(full) || ".") : `<a href="#" data-open-file="${esc(full)}">${esc(rel(full))}</a>${a.offset ? ` <span class="faint">from line ${Number(a.offset)}</span>` : ""}`;
    }
    return `<span class="faint">${esc(JSON.stringify(a).slice(0, 160))}</span>`;
  }

  function toolDetail(name, a) {
    if (name === "run_command") return `<div class="tool-io"><span class="io-label">IN</span><pre class="tool-cmd">${esc(a.command || "")}</pre></div>`;
    if (name === "edit_file") return `<div class="tool-detail">${W.lineDiff(a.old_string, a.new_string)}</div>`;
    if (name === "write_file") return `<div class="tool-detail"><pre class="tool-pre">${esc(String(a.content || "").slice(0, 6000))}</pre></div>`;
    return "";
  }
  const toolCard = (c) => {
    const a = args(c);
    const name = c.function?.name || "?";
    return `<div class="tool-head" data-tool-toggle><span class="tool-dot run"></span><span class="tool-name">${esc(TOOL_LABEL[name] || name)}</span><span class="tool-sum">${toolSummary(name, a)}</span><span class="tool-lines faint"></span><span class="tool-caret">›</span></div>
      <div class="tool-body">${toolDetail(name, a)}<div class="tool-out tool-io hidden"><span class="io-label">OUT</span><pre></pre></div></div>`;
  };
  function paintResult(card, m) {
    if (!card || !m) return;
    $(".tool-dot", card).className = `tool-dot ${m.ok ? "ok" : "err"}`;
    card.classList.toggle("failed", !m.ok);
    const text = String(m.content || "");
    if (!text.trim()) return;
    const out = $(".tool-out", card);
    out.classList.remove("hidden");
    $("pre", out).textContent = text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text;
    const n = text.split("\n").length;
    $(".tool-lines", card).textContent = `${n} line${n === 1 ? "" : "s"}`;
    card.classList.add("has-out");
  }

  // Hỏi người dùng trước khi ghi file / chạy lệnh. Trả true khi được phép; huỷ (Stop) thì trả false.
  function approve(card, name) {
    if (allowAll) return Promise.resolve(true);
    card.classList.add("open");
    const w = document.createElement("div");
    w.className = "cl-msg cl-perm";
    w.innerHTML = `<div class="perm"><div class="perm-title">Allow <b>${esc(TOOL_LABEL[name] || name)}</b>?</div>
      <div class="perm-actions"><button class="btn sm primary" data-ok="allow">Allow <kbd>Enter</kbd></button><button class="btn sm" data-ok="all">Allow all in this chat</button><button class="btn sm danger" data-ok="deny">Deny <kbd>Esc</kbd></button></div></div>`;
    card.after(w);
    stickToBottom();
    setTimeout(() => $("[data-ok=allow]", w)?.focus(), 30);
    return new Promise((resolve) => {
      const signal = ctrl?.signal;
      const done = (ok, label) => {
        signal?.removeEventListener("abort", onAbort);
        $(".perm", w).classList.add("done");
        $(".perm-actions", w).innerHTML = `<span class="faint">${label}</span>`;
        resolve(ok);
      };
      const onAbort = () => done(false, "Cancelled");
      signal?.addEventListener("abort", onAbort);
      w.addEventListener("click", (e) => {
        const b = e.target.closest("[data-ok]");
        if (!b || $(".perm", w).classList.contains("done")) return;
        if (b.dataset.ok === "all") allowAll = true;
        done(b.dataset.ok !== "deny", { allow: "Allowed", all: "Allowed for this chat", deny: "Denied" }[b.dataset.ok]);
      });
      w.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        $("[data-ok=deny]", w)?.click();
      });
    });
  }

  async function runTool(c, card) {
    const name = c.function?.name;
    const a = args(c);
    if (!TOOL_LABEL[name]) return { ok: false, content: `Unknown tool: ${name}` };
    if (!W.folder) return { ok: false, content: "No folder is open" };
    if (NEEDS_OK.has(name) && !(await approve(card, name))) return { ok: false, content: "The user denied this action. Ask what to do instead." };
    try {
      if (name === "read_file") {
        const f = await api("GET", `/api/files/read?path=${encodeURIComponent(resolvePath(a.path))}`);
        if (f.binary || f.tooLarge) throw new Error(f.binary ? "binary file" : "file is too large");
        const lines = f.content.split("\n");
        const from = Math.max(1, Number(a.offset) || 1);
        const to = Math.min(lines.length, from - 1 + (Number(a.limit) || 400));
        const body = lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join("\n");
        return { ok: true, content: body + (to < lines.length ? `\n… (${lines.length - to} more lines, read again with offset ${to + 1})` : "") };
      }
      if (name === "list_dir") {
        const r = await api("GET", `/api/files/list?path=${encodeURIComponent(resolvePath(a.path))}`);
        return { ok: true, content: r.items.map((x) => (x.dir ? `${x.name}/` : x.name)).join("\n") || "(empty folder)" };
      }
      if (name === "search") {
        const r = await api("POST", "/api/files/search", { root: W.folder, query: String(a.query || ""), regex: Boolean(a.regex), include: a.include || "" });
        const out = [];
        for (const f of r.files) for (const m of f.matches) out.push(`${f.path}:${m.line}: ${(m.pre + m.match + m.post).replace(/^…/, "").trim()}`);
        return { ok: true, content: out.length ? out.slice(0, 200).join("\n") + (out.length > 200 ? `\n… ${out.length - 200} more matches` : "") : "No matches" };
      }
      if (name === "write_file" || name === "edit_file") {
        const file = resolvePath(a.path);
        let content = String(a.content ?? "");
        if (name === "edit_file") {
          const f = await api("GET", `/api/files/read?path=${encodeURIComponent(file)}`);
          if (f.binary || f.tooLarge) throw new Error(f.binary ? "binary file" : "file is too large");
          const n = String(a.old_string || "") ? f.content.split(String(a.old_string)).length - 1 : 0;
          if (n !== 1) throw new Error(n ? `old_string appears ${n} times; include more context so it is unique` : "old_string was not found in the file");
          content = f.content.replace(String(a.old_string), () => String(a.new_string ?? ""));
        }
        if (W.findTab(`file:${file}`)?.inst?.isDirty?.()) throw new Error("The file has unsaved changes in the editor; ask the user to save it first");
        await api("PUT", "/api/files/write", { path: file, content, force: true });
        W.findTab(`file:${file}`)?.inst?.reload?.().catch(() => {});
        W.emit("git:changed");
        return { ok: true, content: name === "edit_file" ? "Edited" : `Wrote ${content.split("\n").length} lines` };
      }
      if (name === "run_command") {
        const r = await api("POST", "/api/ai/exec", { cwd: W.folder, command: String(a.command || "") });
        W.emit("git:changed");
        return { ok: r.code === 0, content: `${r.output || ""}${r.code ? `\n(exit code ${r.code})` : ""}`.trim() || "(no output)" };
      }
    } catch (e) {
      return { ok: false, content: `Error: ${e.message}` };
    }
  }

  // ---------- vẽ ----------
  function thinkHtml(text, live) {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return `<summary><span class="think-mark">✻</span> ${live ? "Thinking…" : `Thinking <span class="faint">· ${words} words</span>`}</summary><div class="cl-think"></div>`;
  }

  // Mỗi tin nhắn của model là một khối: suy nghĩ (thu gọn), câu trả lời (markdown), các thẻ công cụ
  function msgEl(m) {
    const el = document.createElement("div");
    if (m.role === "user") {
      el.className = "cl-msg cl-user";
      el.innerHTML = `<div class="cl-user-text">${esc(m.content)}</div>`;
      return el;
    }
    el.className = "ai-turn";
    el.innerHTML = `<details class="cl-msg cl-thinking ai-think hidden"></details><div class="cl-msg cl-assistant ai-md md-body hidden"></div><div class="ai-tools"></div>`;
    el._m = m;
    return el;
  }

  // Vẽ lại phần chữ của một tin nhắn (gọi nhiều lần khi đang stream). Markdown vẽ nối tiếp, không chồng lên nhau.
  function paintText(el, m, live) {
    const s = split(m.content);
    const think = [m.think, s.think].filter(Boolean).join("\n");
    const d = $(".ai-think", el);
    const thinkingNow = live && !s.content.trim() && !m.tool_calls?.length;
    d.classList.toggle("hidden", !think);
    if (think) {
      if (d._live !== thinkingNow || !d.firstChild) {
        d.innerHTML = thinkHtml(think, thinkingNow);
        // mở trong lúc đang nghĩ, tự thu gọn khi câu trả lời bắt đầu (như Claude)
        if (thinkingNow) d.open = true;
        else if (d._live) d.open = false;
        d._live = thinkingNow;
      }
      $(".cl-think", d).textContent = think;
      if (thinkingNow) $(".cl-think", d).scrollTop = 1e9;
    }
    const mdEl = $(".ai-md", el);
    const text = s.content || (live && !think && !m.tool_calls?.length ? "…" : "");
    mdEl.classList.toggle("hidden", !text);
    mdEl.classList.toggle("live", Boolean(live));
    el._want = text;
    if (el._busy) return;
    const step = async () => {
      el._busy = true;
      while (el._done !== el._want) {
        const t = el._want;
        await W.renderMarkdown(mdEl, t, `${W.folder || ""}/x`).catch(() => (mdEl.textContent = t));
        el._done = t;
      }
      el._busy = false;
    };
    step();
  }

  function paintTools(el, m, results) {
    const wrap = $(".ai-tools", el);
    for (const c of m.tool_calls || []) {
      if ($(`[data-call="${CSS.escape(c.id)}"]`, wrap)) continue;
      const card = document.createElement("div");
      card.className = "cl-msg cl-tool";
      card.dataset.call = c.id;
      card.innerHTML = toolCard(c);
      wrap.append(card);
      paintResult(card, results?.get(c.id));
    }
  }
  const cardOf = (el, id) => $(`[data-call="${CSS.escape(id)}"]`, el);

  function paint() {
    if (!root) return;
    const ai = W.config()?.ai || {};
    $(".ai-model", root).textContent = ai.model ? `${ai.model} · ${ai.baseUrl.replace(/^https?:\/\//, "")}` : "No model set";
    const b = box();
    if (!ctrl) {
      b.innerHTML = messages.length ? "" : `<div class="cl-empty">${W.ICON.ai}<h3>Local AI</h3><p>Chat with a model running on your machine.</p><p class="faint">${ai.model ? "Enter to send · Shift+Enter new line · Esc to stop" : `Set the server and model in <a href="#" data-ai-settings>Settings → Local AI</a>.`}</p></div>`;
      const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m]));
      for (const m of messages) {
        if (m.role === "tool") continue;
        const el = msgEl(m);
        b.append(el);
        if (m.role === "assistant") {
          paintText(el, m, false);
          paintTools(el, m, results);
        }
      }
      scrollDown();
    }
    $(".ai-send", root).classList.toggle("hidden", Boolean(ctrl));
    $(".ai-stop", root).classList.toggle("hidden", !ctrl);
    $(".ai-tools-toggle", root).checked = toolsOn();
  }

  // Một lượt gọi model: stream chữ / suy nghĩ vào el, trả về danh sách công cụ model muốn gọi
  async function streamReply(reply, el) {
    const payload = messages
      .filter((m) => m !== reply)
      .map((m) => ({ role: m.role, content: m.role === "assistant" ? split(m.content).content : m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) }));
    const res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dash": "1" },
      body: JSON.stringify({ messages: payload, tools: toolsOn() && Boolean(W.folder), cwd: W.folder || "" }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let calls = [];
    let raf = 0;
    const repaint = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => paintText(el, reply, true));
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = chunk.match(/^event: (\w+)/m)?.[1];
        const data = chunk.match(/^data: (.*)$/m)?.[1];
        if (!ev || data == null) continue;
        const v = JSON.parse(data);
        if (ev === "delta") reply.content += v;
        else if (ev === "think") reply.think += v;
        else if (ev === "tool_calls") calls = v;
        else if (ev === "notools") toast("This model does not support tools; answering without them. Turn off Tools to hide this.", "error", 6000);
        else if (ev === "error") throw new Error(v);
        repaint();
      }
    }
    cancelAnimationFrame(raf);
    return calls;
  }

  async function send() {
    const input = $(".ai-input", root);
    const text = input.value.trim();
    if (!text || ctrl) return;
    if (!W.config()?.ai?.model) return toast("Set a model in Settings → Local AI first", "error");
    input.value = "";
    messages.push({ role: "user", content: text });
    paint();
    ctrl = new AbortController();
    paint();
    const b = box();
    let reply = null;
    let el = null;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        reply = { role: "assistant", content: "", think: "" };
        messages.push(reply);
        el = msgEl(reply);
        b.append(el);
        paintText(el, reply, true);
        const calls = await streamReply(reply, el);
        if (calls.length) reply.tool_calls = calls;
        paintText(el, reply, false);
        if (!calls.length) break;
        paintTools(el, reply);
        save();
        for (const c of calls) {
          const card = cardOf(el, c.id);
          const r = ctrl.signal.aborted ? { ok: false, content: "Stopped by the user" } : await runTool(c, card);
          const tm = { role: "tool", tool_call_id: c.id, name: c.function?.name, content: r.content, ok: r.ok };
          messages.push(tm);
          paintResult(card, tm);
        }
        save();
        if (ctrl.signal.aborted) break;
        if (round === MAX_ROUNDS - 1) toast(`Stopped after ${MAX_ROUNDS} tool rounds`, "error");
      }
    } catch (e) {
      if (e.name !== "AbortError" && reply) {
        reply.content += `${reply.content ? "\n\n" : ""}⚠ ${e.message}`;
        toast(e.message, "error");
      }
    }
    // tin nhắn rỗng (dừng giữa chừng) thì bỏ; công cụ đã gọi mà chưa có kết quả thì ghi kết quả "đã dừng"
    if (reply && !reply.content && !reply.think && !reply.tool_calls) messages.splice(messages.indexOf(reply), 1);
    for (const m of messages) for (const c of m.tool_calls || []) if (!messages.some((x) => x.tool_call_id === c.id)) messages.push({ role: "tool", tool_call_id: c.id, name: c.function?.name, content: "Stopped by the user", ok: false });
    ctrl = null;
    save();
    paint();
  }

  function mount(body, actions) {
    root = body;
    body.innerHTML = `<div class="ai-chat"><div class="ai-model faint mono"></div><div class="ai-log cl-scroll"></div>
      <div class="cl-input-wrap"><textarea class="ai-input cl-input" rows="2" placeholder="Ask the local model…"></textarea>
        <div class="cl-input-bar"><label class="check faint" title="Let the model read and search files in the open folder. Writing files and running commands always ask first."><input type="checkbox" class="ai-tools-toggle" /> Tools</label><span style="flex:1"></span><button class="btn sm danger ai-stop hidden" data-ai-act="stop">■ Stop</button><button class="btn sm primary ai-send" data-ai-act="send">Send ↵</button></div></div></div>`;
    actions.innerHTML = `<button class="icon" data-ai-act="clear" title="New chat">＋</button><button class="icon" data-ai-act="settings" title="Local AI settings">⚙</button>`;
    const input = $(".ai-input", body);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
      if (e.key === "Escape" && ctrl) ctrl.abort();
    });
    $(".ai-tools-toggle", body).addEventListener("change", (e) => store.set("aiTools", e.target.checked));
    const b = box();
    b.addEventListener("scroll", () => {
      stick = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
    });
    // Nội dung đổi ở bất cứ đâu (chữ đang stream, kết quả công cụ, ảnh tải xong) hay khung đổi cỡ đều giữ đáy.
    new MutationObserver(stickToBottom).observe(b, { childList: true, subtree: true, characterData: true });
    new ResizeObserver(stickToBottom).observe(b);
    b.addEventListener("load", stickToBottom, true);
    const onClick = (e) => {
      if (e.target.closest("[data-ai-settings]")) {
        e.preventDefault();
        return W.run("settings.open"), setTimeout(() => W.findTab("settings")?.inst?.jump?.("Local AI"), 60);
      }
      const f = e.target.closest("[data-open-file]");
      if (f) {
        e.preventDefault();
        return W.openFile(f.dataset.openFile);
      }
      const tt = e.target.closest("[data-tool-toggle]");
      if (tt) return tt.closest(".cl-tool").classList.toggle("open");
      const a = e.target.closest("[data-ai-act]")?.dataset.aiAct;
      if (a === "send") send();
      if (a === "stop") ctrl?.abort();
      if (a === "clear") {
        ctrl?.abort();
        ctrl = null;
        messages = [];
        allowAll = false;
        save();
        paint();
        input.focus();
      }
      if (a === "settings") {
        W.run("settings.open");
        setTimeout(() => W.findTab("settings")?.inst?.jump?.("Local AI"), 60);
      }
    };
    body.addEventListener("click", onClick);
    actions.addEventListener("click", onClick);
    paint();
  }

  W.registerView("ai", { title: "Local AI", icon: W.ICON.ai, afterClaude: true, order: 1, key: "view.ai", mount, show: () => (paint(), setTimeout(() => $(".ai-input", root)?.focus(), 30)) });
  W.command("view.ai", "Show local AI chat", () => W.showView("ai"), "Ctrl+Alt+I");
  W.on("config", paint);
})();
