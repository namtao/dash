// Driver PostgreSQL (thư viện pg). Ngày giờ giữ nguyên dạng chuỗi của server để sửa rồi lưu lại không bị lệch múi giờ.
const pg = require("pg");
const { cell } = require("./cell");

for (const oid of [1082, 1083, 1114, 1184, 1266, 1186]) pg.types.setTypeParser(oid, (v) => v);
pg.types.setTypeParser(20, (v) => v); // int8 giữ dạng chuỗi để không mất chính xác

const quote = (id) => `"${String(id).replace(/"/g, '""')}"`;

async function open(conf, database) {
  const client = new pg.Client({
    host: conf.host,
    port: conf.port,
    user: conf.user,
    password: conf.password,
    database: database || conf.database || "postgres",
    ssl: conf.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    application_name: "dash",
  });
  await client.connect();
  const tableNames = new Map(); // oid -> {schema, table, cols: Map(attnum -> name)}

  async function origin(fields) {
    const oids = [...new Set(fields.map((f) => f.tableID).filter(Boolean))];
    if (oids.length !== 1 || fields.some((f) => !f.tableID)) return null;
    const oid = oids[0];
    if (!tableNames.has(oid)) {
      const r = await client.query(
        "SELECT n.nspname, c.relname, a.attnum, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 WHERE c.oid = $1 AND c.relkind IN ('r','p')",
        [oid]
      );
      if (!r.rows.length) tableNames.set(oid, null);
      else tableNames.set(oid, { schema: r.rows[0].nspname, table: r.rows[0].relname, cols: new Map(r.rows.map((x) => [x.attnum, x.attname])) });
    }
    const t = tableNames.get(oid);
    if (!t) return null;
    return { schema: t.schema, table: t.table, columns: fields.map((f) => t.cols.get(f.columnID) || null) };
  }

  return {
    quote,
    placeholder: (i) => `$${i}`,
    async run(sql) {
      const res = await client.query({ text: sql, rowMode: "array" });
      const list = Array.isArray(res) ? res : [res];
      const out = [];
      for (const r of list) {
        const fields = r.fields || [];
        out.push({
          command: r.command,
          affected: r.rowCount,
          columns: fields.map((f) => ({ name: f.name, type: f.dataTypeID })),
          rows: fields.length ? r.rows.map((row) => row.map(cell)) : [],
          source: fields.length ? await origin(fields) : null,
        });
      }
      return out;
    },
    async exec(sql, params) {
      const r = await client.query(sql, params);
      return r.rowCount;
    },
    async transaction(fn) {
      await client.query("BEGIN");
      try {
        const v = await fn();
        await client.query("COMMIT");
        return v;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
    },
    async databases() {
      const r = await client.query("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1");
      return r.rows.map((x) => x.datname);
    },
    async schema() {
      const r = await client.query(`
        SELECT c.table_schema s, c.table_name t, t.table_type tt, c.column_name col, c.data_type dt, c.is_nullable nul,
               (k.column_name IS NOT NULL) pk
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        LEFT JOIN (
          SELECT kcu.table_schema, kcu.table_name, kcu.column_name FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
        ) k ON k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
        ORDER BY c.table_schema, c.table_name, c.ordinal_position`);
      return r.rows.map((x) => ({ schema: x.s, table: x.t, view: x.tt !== "BASE TABLE", column: x.col, type: x.dt, nullable: x.nul === "YES", pk: x.pk }));
    },
    close: () => client.end().catch(() => {}),
  };
}

module.exports = { open, quote, defaultSchema: "public" };
