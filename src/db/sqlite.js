// Driver SQLite dùng node:sqlite có sẵn trong Node (không cần thư viện ngoài).
const { DatabaseSync } = require("node:sqlite");
const { cell } = require("./cell");
const { splitSql } = require("./sql-split");

const quote = (id) => `"${String(id).replace(/"/g, '""')}"`;

async function open(conf) {
  const db = new DatabaseSync(conf.file);

  function origin(cols) {
    const tables = new Set(cols.map((c) => c.table));
    if (tables.size !== 1 || cols.some((c) => !c.table)) return null;
    return { schema: "main", table: cols[0].table, columns: cols.map((c) => c.column || null) };
  }

  return {
    quote,
    placeholder: () => "?",
    async run(text) {
      const out = [];
      for (const stmtText of splitSql(text)) {
        const stmt = db.prepare(stmtText);
        const cols = stmt.columns();
        if (cols.length) {
          if (stmt.setReturnArrays) stmt.setReturnArrays(true);
          const rows = stmt.all().map((r) => (Array.isArray(r) ? r : cols.map((c) => r[c.name])).map(cell));
          out.push({ command: "SELECT", affected: rows.length, columns: cols.map((c) => ({ name: c.name, type: c.type || "" })), rows, source: origin(cols) });
        } else {
          const r = stmt.run();
          out.push({ command: "OK", affected: Number(r.changes), columns: [], rows: [] });
        }
      }
      return out;
    },
    async exec(text, params) {
      return Number(db.prepare(text).run(...params).changes);
    },
    async transaction(fn) {
      db.exec("BEGIN");
      try {
        const v = await fn();
        db.exec("COMMIT");
        return v;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    },
    async databases() {
      return ["main"];
    },
    async schema() {
      const out = [];
      for (const t of db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
        for (const c of db.prepare(`PRAGMA table_info(${quote(t.name)})`).all()) {
          out.push({ schema: "main", table: t.name, view: t.type === "view", column: c.name, type: c.type, nullable: !c.notnull, pk: c.pk > 0 });
        }
      }
      return out;
    },
    close: async () => db.close(),
  };
}

module.exports = { open, quote, defaultSchema: "main" };
