// Lịch sử lệnh terminal theo thư mục: mỗi lệnh gõ trong terminal của Dash được ghi một dòng JSON
// vào .dash-history.jsonl (cmd, cwd, exit, at). Giữ trong bộ nhớ để lọc nhanh.
const fs = require("fs");
const path = require("path");
const store = require("./store");

const FILE = path.join(store.ROOT, ".dash-history.jsonl");
const MAX = 50000;
let entries = null;

function all() {
  if (entries) return entries;
  entries = [];
  try {
    for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
  } catch {}
  return entries;
}

function compact() {
  entries = entries.slice(-Math.floor(MAX * 0.8));
  fs.writeFileSync(FILE, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function record({ cmd, cwd, exit, host }) {
  cmd = String(cmd || "").trim();
  if (!cmd || cmd.length > 4000) return null;
  const e = { cmd, cwd: cwd || "", exit: Number.isInteger(exit) ? exit : null, at: Date.now() };
  if (host) e.host = host;
  all().push(e);
  try {
    fs.appendFileSync(FILE, JSON.stringify(e) + "\n");
  } catch {}
  if (entries.length > MAX) compact();
  return e;
}

// scope: "dir" = đúng thư mục, "tree" = thư mục và thư mục con, "all" = mọi nơi.
// unique: gộp lệnh trùng, giữ lần chạy gần nhất kèm số lần chạy.
function query({ cwd = "", scope = "tree", q = "", limit = 300, unique = true }) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const base = cwd.replace(/\/+$/, "");
  const out = [];
  const seen = new Map();
  const list = all();
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    const e = list[i];
    if (scope === "dir" && e.cwd !== base) continue;
    if (scope === "tree" && e.cwd !== base && !e.cwd.startsWith(base + "/")) continue;
    if (words.length && !words.every((w) => e.cmd.toLowerCase().includes(w))) continue;
    if (unique) {
      const hit = seen.get(e.cmd);
      if (hit) {
        hit.count++;
        continue;
      }
      const row = { ...e, count: 1 };
      seen.set(e.cmd, row);
      out.push(row);
    } else out.push(e);
  }
  return out;
}

// Các thư mục có lịch sử, nhiều lệnh nhất trước.
function folders() {
  const counts = new Map();
  for (const e of all()) counts.set(e.cwd, (counts.get(e.cwd) || 0) + 1);
  return [...counts].map(([cwd, count]) => ({ cwd, count })).sort((a, b) => b.count - a.count);
}

function remove(cmd, cwd) {
  const before = all().length;
  entries = all().filter((e) => !(e.cmd === cmd && (!cwd || e.cwd === cwd)));
  if (entries.length !== before) fs.writeFileSync(FILE, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  return before - entries.length;
}

module.exports = { record, query, folders, remove };
