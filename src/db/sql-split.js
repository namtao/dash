// Tách chuỗi SQL thành từng câu lệnh theo dấu ";" (bỏ qua ";" trong chuỗi, định danh và comment).
// Hỗ trợ $tag$...$tag$ của PostgreSQL và dòng "GO" của SQL Server.
function splitSql(sql, { go = false } = {}) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  const pushStmt = (end) => {
    const text = sql.slice(start, end).trim();
    if (text) out.push(text);
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      i = sql.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && next === "*") {
      i = sql.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < n && !(sql[i] === c && sql[i + 1] !== c)) i += sql[i] === c ? 2 : sql[i] === "\\" && c === "'" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "[" && go) {
      i = sql.indexOf("]", i);
      if (i < 0) break;
      i++;
      continue;
    }
    if (c === "$") {
      const m = sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end < 0 ? n : end + m[0].length;
        continue;
      }
    }
    if (c === ";") {
      pushStmt(i);
      start = i + 1;
    } else if (go && (c === "\n" || i === 0)) {
      const m = sql.slice(c === "\n" ? i + 1 : i).match(/^\s*GO\s*(?:\n|$)/i);
      if (m) {
        pushStmt(i);
        i += (c === "\n" ? 1 : 0) + m[0].length;
        start = i;
        continue;
      }
    }
    i++;
  }
  pushStmt(n);
  return out;
}

// Câu SELECT đơn giản chưa có LIMIT: thêm LIMIT để không kéo cả bảng về trình duyệt.
function isPlainSelect(stmt) {
  const s = stmt.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  return /^(select|with)\b/i.test(s) && !/\b(limit|fetch\s+first|offset|into)\b/i.test(s) && !/\bfor\s+update\b/i.test(s);
}

module.exports = { splitSql, isPlainSelect };
