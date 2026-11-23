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

// Công cụ cho model (gọi hàm kiểu OpenAI). Trình duyệt chạy công cụ qua API sẵn có của Dash; công cụ ghi file
// và chạy lệnh chỉ chạy sau khi người dùng bấm Allow.
const TOOLS = [
  ["read_file", "Read a text file. Returns numbered lines.", { path: ["string", "File path, relative to the working folder or absolute"], offset: ["integer", "First line to read (1-based), optional"], limit: ["integer", "Number of lines to read, optional (default 400)"] }, ["path"]],
  ["list_dir", "List the files and folders in a folder.", { path: ["string", "Folder path, relative to the working folder or absolute. Use \".\" for the working folder"] }, ["path"]],
  ["search", "Search file contents in the working folder (like grep). Returns matching lines with file and line number.", { query: ["string", "Text or regular expression to find"], regex: ["boolean", "Treat query as a regular expression"], include: ["string", "Glob of files to search, e.g. *.js or src/**, optional"] }, ["query"]],
  ["write_file", "Create or overwrite a file with the given content. The user must approve.", { path: ["string", "File path"], content: ["string", "Full new file content"] }, ["path", "content"]],
  ["edit_file", "Replace one exact occurrence of old_string with new_string in a file. The user must approve.", { path: ["string", "File path"], old_string: ["string", "Exact text to replace; must appear exactly once"], new_string: ["string", "Replacement text"] }, ["path", "old_string", "new_string"]],
  ["run_command", "Run a shell command in the working folder and return its output. The user must approve.", { command: ["string", "Shell command"] }, ["command"]],
].map(([name, description, props, required]) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: Object.fromEntries(Object.entries(props).map(([k, [type, d]]) => [k, { type, description: d }])), required } },
}));

const systemPrompt = (cwd) =>
  `You are a coding assistant running inside Dash, a local workspace. The working folder is ${cwd}. ` +
  "Use the tools to look at files before answering questions about the code; do not guess file contents. " +
  "Prefer edit_file for small changes. Keep answers short and use Markdown.";

// Chỉ giữ các trường API cần, bỏ dữ liệu giao diện
const clean = (m) => ({
  role: m.role,
  content: m.content ?? "",
  ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.function?.name, arguments: c.function?.arguments || "{}" } })) } : {}),
  ...(m.role === "tool" ? { tool_call_id: m.tool_call_id } : {}),
});

// Chuyển stream SSE của API OpenAI thành sự kiện "delta" / "think" / "tool_calls" / "done" / "error" gửi cho trình duyệt.
// Server không hỗ trợ gọi công cụ (HTTP 400 nhắc tới "tool") thì gửi lại không kèm công cụ và báo "notools".
async function chatStream(body, req, res) {
  const ai = conf();
  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const msgs = (Array.isArray(body.messages) ? body.messages : []).filter((m) => ["user", "assistant", "tool", "system"].includes(m?.role)).map(clean);
  const useTools = Boolean(body.tools && body.cwd);
  if (body.cwd) msgs.unshift({ role: "system", content: systemPrompt(body.cwd) });
  try {
    let upstream;
    try {
      upstream = await request(ai, "/chat/completions", { model: ai.model, messages: msgs, stream: true, ...(useTools ? { tools: TOOLS } : {}) }, ctrl.signal);
    } catch (e) {
      if (!useTools || !/HTTP 4\d\d[\s\S]*tool/i.test(e.message)) throw e;
      send("notools", e.message.slice(0, 200));
      upstream = await request(ai, "/chat/completions", { model: ai.model, messages: msgs.filter((m) => m.role !== "tool").map(({ tool_calls, ...m }) => m), stream: true }, ctrl.signal);
    }
    const decoder = new TextDecoder();
    const calls = []; // gom các mảnh tool_calls theo index
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
          for (const tc of delta.tool_calls || []) {
            const c = (calls[tc.index ?? calls.length] ||= { id: "", type: "function", function: { name: "", arguments: "" } });
            if (tc.id) c.id = tc.id;
            if (tc.function?.name) c.function.name += tc.function.name;
            if (tc.function?.arguments) c.function.arguments += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          }
        } catch {}
      }
    }
    const done = calls.filter((c) => c?.function.name).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
    if (done.length) send("tool_calls", done);
    send("done", {});
  } catch (e) {
    if (e.name !== "AbortError") send("error", e.message);
  }
  res.end();
}

// Chạy một lệnh shell cho công cụ run_command (chỉ thư mục trên máy này; người dùng đã bấm Allow trên trình duyệt)
function exec(cwd, command) {
  const remote = require("./remote");
  const fs = require("fs");
  if (!cwd || remote.isRemote(cwd)) throw Object.assign(new Error("Commands run only in local folders"), { status: 400 });
  if (!fs.existsSync(cwd)) throw Object.assign(new Error(`Folder not found: ${cwd}`), { status: 400 });
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || "/bin/sh", ["-c", String(command || "")], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    const add = (d) => {
      out += d;
      if (out.length > 60000) out = out.slice(0, 30000) + "\n… (output cut) …\n" + out.slice(-20000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }, 120000);
    child.on("error", (e) => (clearTimeout(timer), resolve({ code: -1, output: e.message })));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, output: out + (timedOut ? "\n(stopped after 120 s)" : "") });
    });
  });
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

module.exports = { models, chatStream, commitMessage, exec };
