// Quản lý kết nối DB: giữ kết nối mở theo (kết nối, database), chạy SQL có giới hạn số hàng,
// đánh dấu kết quả nào sửa được (lấy từ đúng một bảng có khoá chính) và lưu thay đổi trong một transaction.
const store = require("../store");
const { splitSql, isPlainSelect } = require("./sql-split");

const DRIVERS = { postgres: require("./postgres"), mysql: require("./mysql"), mssql: require("./mssql"), sqlite: require("./sqlite") };
const handles = new Map(); // key -> { promise, lastUsed }
const schemaCache = new Map(); // key -> { at, rows }
const IDLE_MS = 10 * 60 * 1000;

const keyOf = (id, database) => `${id}|${database || ""}`;

async function handle(id, database) {
  const conf = store.getDatabase(id);
  const key = keyOf(id, database);
  let h = handles.get(key);
  if (!h) {
    h = { promise: DRIVERS[conf.type].open(conf, database), lastUsed: Date.now() };
    handles.set(key, h);
    h.promise.catch(() => handles.delete(key));
  }
  h.lastUsed = Date.now();
  return h.promise;
}

function drop(id, database) {
  for (const [key, h] of handles) {
    if (key.startsWith(`${id}|`) && (database === undefined || key === keyOf(id, database))) {
      handles.delete(key);
      h.promise.then((x) => x.close()).catch(() => {});
    }
  }
  for (const key of schemaCache.keys()) if (key.startsWith(`${id}|`)) schemaCache.delete(key);
}

setInterval(() => {
  for (const [key, h] of handles) {
    if (Date.now() - h.lastUsed > IDLE_MS) {
      handles.delete(key);
      h.promise.then((x) => x.close()).catch(() => {});
    }
  }
}, 60000).unref();

// Lỗi mất kết nối: bỏ kết nối cũ để lần sau mở lại.
async function withHandle(id, database, fn) {
  const h = await handle(id, database);
  try {
    return await fn(h);
  } catch (e) {
    if (/ECONNRESET|EPIPE|Connection terminated|closed state|Connection lost|not connected|socket hang up/i.test(e.message)) drop(id, database);
    throw Object.assign(e, { status: e.status || 400 });
  }
}

async function test(conf) {
  const h = await DRIVERS[conf.type].open(conf, conf.database);
  try {
    const dbs = await h.databases();
    return { ok: true, databases: dbs.length };
  } finally {
    await h.close();
  }
}

async function schema(id, database, force = false) {
  const key = keyOf(id, database);
  const hit = schemaCache.get(key);
  if (hit && !force && Date.now() - hit.at < 5 * 60 * 1000) return hit.rows;
  const rows = await withHandle(id, database, (h) => h.schema());
  schemaCache.set(key, { at: Date.now(), rows });
  return rows;
}

const databases = (id) => withHandle(id, undefined, (h) => h.databases());

async function run(id, database, sql) {
  const conf = store.getDatabase(id);
  const limit = store.load().workspace.sqlRowLimit;
  const stmts = splitSql(sql, { go: conf.type === "mssql" });
  if (!stmts.length) throw Object.assign(new Error("Nothing to run"), { status: 400 });
  const single = stmts.length === 1 && isPlainSelect(stmts[0]);
  const started = Date.now();
  const results = await withHandle(id, database, async (h) => {
    if (single && (conf.type === "postgres" || conf.type === "sqlite")) return h.run(`${stmts[0]}\nLIMIT ${limit + 1}`);
    if (single) return h.run(stmts[0], { limit: limit + 1 });
    return h.run(sql);
  });
  const ms = Date.now() - started;
  let cols = null;
  for (const r of results) {
    if (r.rows.length > limit) {
      r.rows.length = limit;
      r.truncated = true;
    }
    if (!r.source) continue;
    cols ||= await schema(id, database).catch(() => []);
    const tableCols = cols.filter((c) => c.table === r.source.table && (!r.source.schema || c.schema === r.source.schema) && !c.view);
    const pk = tableCols.filter((c) => c.pk).map((c) => c.column);
    const editable = pk.length > 0 && pk.every((k) => r.source.columns.includes(k));
    r.edit = editable ? { schema: r.source.schema, table: r.source.table, pk, columns: r.source.columns, all: tableCols.map((c) => ({ name: c.column, type: c.type, nullable: c.nullable, pk: c.pk })) } : null;
    if (!editable) r.readonlyReason = pk.length ? "Primary key columns are not all in the result" : tableCols.length ? "Table has no primary key" : "Result is not from a single table";
    delete r.source;
  }
  return { results, ms, limit };
}

// changes: { schema, table, pk: [cols], updates: [{ key, set }], inserts: [obj], deletes: [{ key }] }
async function save(id, database, changes) {
  const conf = store.getDatabase(id);
  const drv = DRIVERS[conf.type];
  const { schema: sch, table, pk } = changes;
  if (!table || !Array.isArray(pk) || !pk.length) throw Object.assign(new Error("Table and primary key are required"), { status: 400 });
  const target = sch && conf.type !== "sqlite" ? `${drv.quote(sch)}.${drv.quote(table)}` : drv.quote(table);
  return withHandle(id, database, (h) =>
    h.transaction(async () => {
      let affected = 0;
      const where = (key, start) => {
        const parts = [];
        const params = [];
        pk.forEach((k) => {
          if (key[k] === null || key[k] === undefined) parts.push(`${h.quote(k)} IS NULL`);
          else {
            params.push(key[k]);
            parts.push(`${h.quote(k)} = ${h.placeholder(start + params.length)}`);
          }
        });
        return { sql: parts.join(" AND "), params };
      };
      for (const d of changes.deletes || []) {
        const w = where(d.key, 0);
        const n = await h.exec(`DELETE FROM ${target} WHERE ${w.sql}`, w.params);
        if (n !== 1) throw new Error(`Delete matched ${n} rows (expected 1). All changes were rolled back.`);
        affected += n;
      }
      for (const u of changes.updates || []) {
        const cols = Object.keys(u.set || {});
        if (!cols.length) continue;
        const params = cols.map((c) => u.set[c]);
        const sets = cols.map((c, i) => `${h.quote(c)} = ${h.placeholder(i + 1)}`).join(", ");
        const w = where(u.key, params.length);
        const n = await h.exec(`UPDATE ${target} SET ${sets} WHERE ${w.sql}`, [...params, ...w.params]);
        if (n !== 1) throw new Error(`Update matched ${n} rows (expected 1). All changes were rolled back.`);
        affected += n;
      }
      for (const row of changes.inserts || []) {
        const cols = Object.keys(row).filter((c) => row[c] !== undefined);
        if (!cols.length) throw new Error("A new row has no values");
        const sql = `INSERT INTO ${target} (${cols.map(h.quote).join(", ")}) VALUES (${cols.map((_, i) => h.placeholder(i + 1)).join(", ")})`;
        affected += await h.exec(sql, cols.map((c) => row[c]));
      }
      return { ok: true, affected };
    })
  );
}

module.exports = { test, schema, databases, run, save, drop, DRIVERS };
