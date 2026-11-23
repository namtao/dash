// Driver SQL Server (mssql/tedious). Lệnh nhiều khối tách theo dòng GO.
const sql = require("mssql");
const { cell } = require("./cell");
const { splitSql } = require("./sql-split");

const quote = (id) => `[${String(id).replace(/]/g, "]]")}]`;

// Không có thông tin bảng gốc trong kết quả: chỉ cho sửa khi câu lệnh là SELECT từ đúng một bảng.
function guessSource(stmt, columns) {
  const s = stmt.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (/\bjoin\b|\bunion\b|\bgroup\s+by\b|\bdistinct\b/i.test(s)) return null;
  const m = s.match(/\bfrom\s+((?:\[[^\]]+\]|\w+)(?:\s*\.\s*(?:\[[^\]]+\]|\w+)){0,2})(?:\s+(?:as\s+)?\w+)?\s*(?:where|order|option|$|;)/i);
  if (!m) return null;
  const parts = m[1].split(".").map((x) => x.trim().replace(/^\[|\]$/g, ""));
  const table = parts.pop();
  const schema = parts.pop() || "dbo";
  return { schema, table, columns: columns.map((c) => c.name) };
}

async function open(conf, database) {
  const pool = new sql.ConnectionPool({
    server: conf.host,
    port: conf.port,
    user: conf.user,
    password: conf.password,
    database: database || conf.database || undefined,
    connectionTimeout: 10000,
    requestTimeout: 0,
    options: { encrypt: Boolean(conf.ssl), trustServerCertificate: true, useUTC: false },
    pool: { max: 2 },
  });
  await pool.connect();
  let tx = null;
  const request = () => (tx ? new sql.Request(tx) : pool.request());

  return {
    quote,
    placeholder: (i) => `@p${i}`,
    async run(text, { limit } = {}) {
      const out = [];
      for (const batch of splitSql(text, { go: true })) {
        const req = request();
        req.arrayRowMode = true;
        const r = await req.query(limit ? `SET ROWCOUNT ${Number(limit)};\n${batch}\n;SET ROWCOUNT 0;` : batch);
        const sets = r.recordsets || [];
        sets.forEach((rs, i) => {
          const columns = (r.columns?.[i] || []).map((c) => ({ name: c.name, type: c.type?.declaration || "" }));
          out.push({ command: "SELECT", affected: rs.length, columns, rows: rs.map((row) => row.map(cell)), source: sets.length === 1 ? guessSource(batch, columns) : null });
        });
        if (!sets.length) out.push({ command: "OK", affected: (r.rowsAffected || []).reduce((a, b) => a + b, 0), columns: [], rows: [] });
      }
      return out;
    },
    async exec(text, params) {
      const req = request();
      params.forEach((v, i) => req.input(`p${i + 1}`, v));
      const r = await req.query(text);
      return (r.rowsAffected || []).reduce((a, b) => a + b, 0);
    },
    async transaction(fn) {
      tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const v = await fn();
        await tx.commit();
        return v;
      } catch (e) {
        await tx.rollback().catch(() => {});
        throw e;
      } finally {
        tx = null;
      }
    },
    async databases() {
      const r = await pool.request().query("SELECT name FROM sys.databases ORDER BY name");
      return r.recordset.map((x) => x.name);
    },
    async schema() {
      const r = await pool.request().query(`
        SELECT c.TABLE_SCHEMA s, c.TABLE_NAME t, t.TABLE_TYPE tt, c.COLUMN_NAME col, c.DATA_TYPE dt, c.IS_NULLABLE nul,
               CASE WHEN k.COLUMN_NAME IS NULL THEN 0 ELSE 1 END pk
        FROM INFORMATION_SCHEMA.COLUMNS c
        JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        LEFT JOIN (
          SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON ku.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND ku.TABLE_SCHEMA = tc.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        ) k ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`);
      return r.recordset.map((x) => ({ schema: x.s, table: x.t, view: x.tt !== "BASE TABLE", column: x.col, type: x.dt, nullable: x.nul === "YES", pk: Boolean(x.pk) }));
    },
    close: () => pool.close().catch(() => {}),
  };
}

module.exports = { open, quote, defaultSchema: "dbo" };
