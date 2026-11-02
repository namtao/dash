// AI chạy trên máy (Ollama, LM Studio, llama.cpp, vLLM… — API kiểu OpenAI, cấu hình như Cline):
// chat (stream về trình duyệt qua SSE) và viết commit message từ git diff. Server làm proxy nên khoá API
// không xuống trình duyệt và không vướng CORS.
const store = require("./store");

function conf() {
  const ai = store.load().ai;
  if (!ai.model) throw Object.assign(new Error("Set a local AI model first (Settings → Local AI)"), { status: 400 });
  return ai;
}

const headers = (ai) => ({ "Content-Type": "application/json", ...(ai.apiKey ? { Authorization: `Bearer ${ai.apiKey}` } : {}) });

async function request(ai, pathname, body, signal) {
  let res;
  try {
    res = await fetch(`${ai.baseUrl}${pathname}`, { method: body ? "POST" : "GET", headers: headers(ai), body: body ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw Object.assign(new Error(`Cannot reach ${ai.baseUrl} (${e.cause?.code || e.message}). Is the local AI server running?`), { status: 502 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`Local AI: HTTP ${res.status} ${text.slice(0, 300)}`), { status: 502 });
  }
  return res;
}

async function models() {
  const ai = store.load().ai;
  const res = await request(ai, "/models", null, AbortSignal.timeout(8000));
  const json = await res.json();
  return (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
}

// Chuyển stream SSE của API OpenAI thành sự kiện "delta" / "done" / "error" gửi cho trình duyệt
async function chatStream(messages, req, res) {
  const ai = conf();
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const upstream = await request(ai, "/chat/completions", { model: ai.model, messages, stream: true }, ctrl.signal);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta || {};
          if (delta.reasoning_content || delta.reasoning) send("think", delta.reasoning_content || delta.reasoning);
          if (delta.content) send("delta", delta.content);
        } catch {}
      }
    }
    send("done", {});
  } catch (e) {
    if (e.name !== "AbortError") send("error", e.message);
  }
  res.end();
}

const COMMIT_PROMPT = `You write git commit messages. Reply with only the commit message, no explanations, no code fences.
Use the Conventional Commits format: "<type>(<optional scope>): <summary>" with type one of feat, fix, docs, style, refactor, perf, test, build, ci, chore.
Summary in imperative mood, at most 72 characters. If the change is non-trivial, add a blank line and a short bullet list of the main changes.`;

async function commitMessage(diff) {
  const ai = conf();
  const res = await request(ai, "/chat/completions", { model: ai.model, stream: false, temperature: 0.2, messages: [{ role: "system", content: COMMIT_PROMPT }, { role: "user", content: diff }] }, AbortSignal.timeout(180000));
  const json = await res.json();
  let text = json.choices?.[0]?.message?.content || "";
  // một số model in phần suy nghĩ trong <think>…</think>
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^```\w*\n?|```$/g, "").trim();
  if (!text) throw Object.assign(new Error("The model returned an empty message"), { status: 502 });
  return text;
}

module.exports = { models, chatStream, commitMessage };
