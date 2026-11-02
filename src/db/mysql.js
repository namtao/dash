// Driver MySQL / MariaDB (mysql2). Ngày giờ trả về dạng chuỗi, nhiều câu lệnh trong một lần chạy.
const mysql = require("mysql2/promise");
const { cell } = require("./cell");

const quote = (id) => `\`${String(id).replace(/`/g, "``")}\``;

async function open(conf, database) {
  const conn = await mysql.createConnection({
    host: conf.host,
    port: conf.port,
    user: conf.user,
    password: conf.password,
    database: database || conf.database || undefined,
    ssl: conf.ssl ? { rejectUnauthorized: false } : undefined,
    multipleStatements: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: 10000,
  });
  const current = database || conf.database || "";

  function origin(fields) {
    const tables = new Set(fields.map((f) => `${f.schema || f.db}\u0000${f.orgTable}`));
    if (tables.size !== 1 || fields.some((f) => !f.orgTable)) return null;
    return { schema: fields[0].schema || fields[0].db, table: fields[0].orgTable, columns: fields.map((f) => f.orgName || null) };
  }

  return {
    quote,
    placeholder: () => "?",
    async run(sql, { limit } = {}) {
      if (limit) await conn.query(`SET SESSION sql_select_limit = ${Number(limit)}`);
      try {
        const [res, fields] = await conn.query({ sql, rowsAsArray: true });
        // Một câu lệnh: res là mảng hàng hoặc ResultSetHeader; nhiều câu: mảng các kết quả
        const singleSelect = Array.isArray(fields) && fields.length > 0 && fields[0] && !Array.isArray(fields[0]);
        const results = !Array.isArray(res) || singleSelect ? [[res, fields]] : res.map((r, i) => [r, fields?.[i]]);
        return results.map(([r, f]) =>
          Array.isArray(r)
            ? { command: "SELECT", affected: r.length, columns: (f || []).map((x) => ({ name: x.name, type: x.columnType })), rows: r.map((row) => row.map(cell)), source: f?.length ? origin(f) : null }
            : { command: "OK", affected: r.affectedRows, columns: [], rows: [], info: r.info || "" }
        );
      } finally {
        if (limit) await conn.query("SET SESSION sql_select_limit = DEFAULT").catch(() => {});
      }
    },
    async exec(sql, params) {
      const [r] = await conn.execute(sql, params);
      return r.affectedRows;
    },
    async transaction(fn) {
      await conn.beginTransaction();
      try {
        const v = await fn();
        await conn.commit();
        return v;
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      }
    },
    async databases() {
      const [rows] = await conn.query("SHOW DATABASES");
      return rows.map((r) => Object.values(r)[0]);
    },
    async schema() {
      if (!current) return [];
      const [rows] = await conn.query(
        `SELECT c.TABLE_SCHEMA s, c.TABLE_NAME t, t.TABLE_TYPE tt, c.COLUMN_NAME col, c.COLUMN_TYPE dt, c.IS_NULLABLE nul, c.COLUMN_KEY k
         FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
         WHERE c.TABLE_SCHEMA = ? ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
        [current]
      );
      return rows.map((x) => ({ schema: x.s, table: x.t, view: x.tt !== "BASE TABLE", column: x.col, type: x.dt, nullable: x.nul === "YES", pk: x.k === "PRI" }));
    },
    close: () => conn.end().catch(() => {}),
  };
}

module.exports = { open, quote, defaultSchema: null };
