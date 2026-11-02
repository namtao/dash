"use strict";
// Chat với AI chạy trên máy (OpenAI-compatible: Ollama, LM Studio…), nằm ngay dưới nút Claude trên activity bar.
// Server làm proxy và stream câu trả lời (SSE); hội thoại lưu trong trình duyệt theo cửa sổ.
(() => {
  let root = null;
  let messages = store.get("aiChat", []); // [{ role, content, think? }]
  let ctrl = null;
  const save = () => store.set("aiChat", messages.slice(-60));

  // Một số model trả phần suy nghĩ trong <think>…</think>
  const split = (text) => {
    const m = text.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
    return m ? { think: m[1].trim(), content: text.slice(m[0].length).trim() } : { think: "", content: text };
  };

  async function paintMsg(el, m) {
    const { think, content } = split(m.content || "");
    const thinking = [m.think, think].filter(Boolean).join("\n");
    if (m.role === "user") {
      el.innerHTML = `<div class="cl-user-text">${esc(m.content)}</div>`;
      return;
    }
    el.innerHTML = `${thinking ? `<details class="ai-think"><summary><span class="think-mark">✻</span> Thinking</summary><div class="cl-think"></div></details>` : ""}<div class="ai-md md-body"></div>`;
    if (thinking) $(".cl-think", el).textContent = thinking;
    await W.renderMarkdown($(".ai-md", el), content || (m.pending ? "…" : ""), W.folder + "/x");
  }

  function paint() {
    if (!root) return;
    const ai = W.config()?.ai || {};
    $(".ai-model", root).textContent = ai.model ? `${ai.model} · ${ai.baseUrl.replace(/^https?:\/\//, "")}` : "No model set";
    const box = $(".ai-log", root);
    box.innerHTML = messages.length ? "" : `<div class="cl-empty">${W.ICON.ai}<h3>Local AI</h3><p>Chat with a model running on your machine.</p><p class="faint">${ai.model ? "Enter to send · Shift+Enter new line" : `Set the server and model in <a href="#" data-ai-settings>Settings → Local AI</a>.`}</p></div>`;
    for (const m of messages) {
      const el = document.createElement("div");
      el.className = `cl-msg ${m.role === "user" ? "cl-user" : "cl-assistant"}`;
      box.append(el);
      paintMsg(el, m);
    }
    box.scrollTop = box.scrollHeight;
    $(".ai-send", root).classList.toggle("hidden", Boolean(ctrl));
    $(".ai-stop", root).classList.toggle("hidden", !ctrl);
  }

  async function send() {
    const input = $(".ai-input", root);
    const text = input.value.trim();
    if (!text || ctrl) return;
    if (!W.config()?.ai?.model) return toast("Set a model in Settings → Local AI first", "error");
    input.value = "";
    messages.push({ role: "user", content: text });
    const reply = { role: "assistant", content: "", think: "", pending: true };
    messages.push(reply);
    ctrl = new AbortController();
    paint();
    const el = $(".ai-log", root).lastElementChild;
    let raf = 0;
    const repaint = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        paintMsg(el, reply);
        const box = $(".ai-log", root);
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 200) box.scrollTop = box.scrollHeight;
      });
    };
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dash": "1" },
        body: JSON.stringify({ messages: messages.filter((m) => !m.pending).map(({ role, content }) => ({ role, content: split(content).content || content })) }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
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
          else if (ev === "error") throw new Error(v);
          repaint();
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        reply.content += `${reply.content ? "\n\n" : ""}⚠ ${e.message}`;
        toast(e.message, "error");
      }
    }
    delete reply.pending;
    ctrl = null;
    save();
    paint();
  }

  function mount(body, actions) {
    root = body;
    body.innerHTML = `<div class="ai-chat"><div class="ai-model faint mono"></div><div class="ai-log cl-scroll"></div>
      <div class="cl-input-wrap"><textarea class="ai-input cl-input" rows="2" placeholder="Ask the local model…"></textarea>
        <div class="cl-input-bar"><span class="faint" style="flex:1"></span><button class="btn sm danger ai-stop hidden" data-ai-act="stop">■ Stop</button><button class="btn sm primary ai-send" data-ai-act="send">Send ↵</button></div></div></div>`;
    actions.innerHTML = `<button class="icon" data-ai-act="clear" title="New chat">＋</button><button class="icon" data-ai-act="settings" title="Local AI settings">⚙</button>`;
    const input = $(".ai-input", body);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
      if (e.key === "Escape" && ctrl) ctrl.abort();
    });
    const onClick = (e) => {
      if (e.target.closest("[data-ai-settings]")) {
        e.preventDefault();
        return W.run("settings.open"), setTimeout(() => W.findTab("settings")?.inst?.jump?.("Local AI"), 60);
      }
      const a = e.target.closest("[data-ai-act]")?.dataset.aiAct;
      if (a === "send") send();
      if (a === "stop") ctrl?.abort();
      if (a === "clear") {
        ctrl?.abort();
        messages = [];
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
