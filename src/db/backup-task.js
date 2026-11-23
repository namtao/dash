#!/usr/bin/env node
// Tiến trình con cho backup/restore SQL Server và SQLite (không có công cụ dòng lệnh chuẩn trên máy).
// và lệnh xoá database (mọi loại DB trừ SQLite). Thông tin kết nối nhận qua biến môi trường DASH_DB_CONF.
// Dùng: backup-task.js backup|restore <db> <file> [recreate] · backup-task.js drop <db>
const fs = require("fs");
const path = require("path");

const conf = JSON.parse(process.env.DASH_DB_CONF || "{}");
const [action, database, file, recreate] = process.argv.slice(2);
const q = (s) => `[${String(s).replace(/]/g, "]]")}]`;
const lit = (s) => `N'${String(s).replace(/'/g, "''")}'`;

async function mssql() {
  const sql = require("mssql");
  const pool = await new sql.ConnectionPool({
    server: conf.host,
    port: conf.port,
    user: conf.user,
    password: conf.password,
    database: "master",
    requestTimeout: 0,
    options: { encrypt: Boolean(conf.ssl), trustServerCertificate: true },
  }).connect();
  const run = async (text) => {
    const req = pool.request();
    req.on("info", (m) => console.log(m.message));
    return req.query(text);
  };
  try {
    if (action === "backup") {
      console.log(`Backing up ${database} to ${file} (path on the SQL Server host) ...`);
      await run(`BACKUP DATABASE ${q(database)} TO DISK = ${lit(file)} WITH INIT, COPY_ONLY, STATS = 10`);
      console.log(`✓ Backup saved on the server: ${file}`);
    } else {
      console.log(`Reading file list of ${file} ...`);
      const files = (await run(`RESTORE FILELISTONLY FROM DISK = ${lit(file)}`)).recordset;
      const paths = (await run("SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)) d, CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000)) l")).recordset[0];
      const sep = String(paths.d || "").includes("\\") ? "\\" : "/";
      const moves = files.map((f, i) => {
        const dir = (f.Type === "L" ? paths.l : paths.d) || path.dirname(f.PhysicalName);
        const ext = f.Type === "L" ? "_log.ldf" : i === 0 ? ".mdf" : `_${i}.ndf`;
        return `MOVE ${lit(f.LogicalName)} TO ${lit(`${dir.replace(/[\\/]$/, "")}${sep}${database}${ext}`)}`;
      });
      const exists = (await run(`SELECT DB_ID(${lit(database)}) id`)).recordset[0].id;
      if (exists) {
        console.log(`Closing connections to ${database} ...`);
        await run(`ALTER DATABASE ${q(database)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
        if (recreate === "1") {
          console.log(`Dropping ${database} ...`);
          await run(`DROP DATABASE ${q(database)}`);
        }
      }
      console.log(`Restoring into ${database} ...`);
      try {
        await run(`RESTORE DATABASE ${q(database)} FROM DISK = ${lit(file)} WITH REPLACE, ${moves.join(", ")}, STATS = 10`);
      } finally {
        if (exists && recreate !== "1") await run(`ALTER DATABASE ${q(database)} SET MULTI_USER`).catch(() => {});
      }
      console.log("✓ Restore finished");
    }
  } finally {
    await pool.close();
  }
}

async function sqlite() {
  const { DatabaseSync } = require("node:sqlite");
  if (action === "backup") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(conf.file);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    db.close();
    console.log(`✓ Backup saved: ${file}`);
  } else {
    const keep = `${conf.file}.before-restore`;
    if (fs.existsSync(conf.file)) fs.copyFileSync(conf.file, keep);
    fs.copyFileSync(file, conf.file);
    console.log(`✓ Restored ${file} → ${conf.file} (previous file kept as ${keep})`);
  }
}

// Xoá database: kết nối vào database quản trị (postgres / master / không chọn), ngắt các kết nối khác rồi DROP
async function dropDb() {
  if (!database) throw new Error("No database given");
  const drv = require(`./${conf.type}`);
  const h = await drv.open({ ...conf, database: "" }, { postgres: "postgres", mssql: "master" }[conf.type] || "");
  const name = drv.quote(database);
  try {
    if (conf.type === "postgres") {
      console.log(`Terminating connections to ${database} ...`);
      await h.exec("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [database]);
    } else if (conf.type === "mssql") {
      console.log(`Closing connections to ${database} ...`);
      await h.exec(`IF DB_ID(@p1) IS NOT NULL ALTER DATABASE ${name} SET SINGLE_USER WITH ROLLBACK IMMEDIATE`, [database]);
    }
    console.log(`Dropping database ${database} ...`);
    await h.run(`DROP DATABASE ${name}`);
    console.log(`✓ Database ${database} dropped`);
  } finally {
    await h.close();
  }
}

(action === "drop" ? dropDb() : conf.type === "mssql" ? mssql() : sqlite()).catch((e) => {
  console.error(`!!! ${e.message}`);
  process.exit(1);
});
