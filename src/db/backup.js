// Backup / restore cho từng loại DB, chạy như một tác vụ nền có log (logs/dash-db/<kết nối>.log).
// Học theo sync_db.sh: pg_dump -Fc; khi restore có thể ngắt kết nối, xoá và tạo lại database rồi
// pg_restore --no-owner --no-privileges. Backup và restore là hai thao tác riêng.
const fs = require("fs");
const path = require("path");
const store = require("../store");
const runner = require("../process-runner");

const TASK_SCRIPT = path.join(__dirname, "backup-task.js");
const jobKey = (id) => `dash-db/${id}`;
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

function defaultFile(conf, database, format) {
  const ext = { postgres: format === "plain" ? "sql" : "backup", mysql: "sql", mssql: "bak", sqlite: "db" }[conf.type];
  return path.join(store.load().workspace.backupDir, `${conf.id}-${database || "db"}-${stamp()}.${ext}`);
}

// Biến môi trường chứa thông tin đăng nhập cho công cụ dòng lệnh
function secretEnv(conf) {
  if (conf.type === "postgres") return { PGPASSWORD: conf.password || "", PGHOST: conf.host, PGPORT: String(conf.port), PGUSER: conf.user, PGSSLMODE: conf.ssl ? "require" : "prefer", PGCONNECT_TIMEOUT: "10" };
  if (conf.type === "mysql") return { MYSQL_PWD: conf.password || "" };
  return { DASH_DB_CONF: JSON.stringify(conf) };
}

const BASH = (script, ...args) => ["bash", "-c", `set -o pipefail\n${script}`, "dash-db", ...args];

// opts: { database, file, format: "custom"|"plain", schemaOnly, dataOnly }
function backupArgv(conf, opts) {
  const db = opts.database || conf.database;
  if (conf.type === "postgres") {
    const extra = [opts.schemaOnly ? "--schema-only" : "", opts.dataOnly ? "--data-only" : ""].filter(Boolean).join(" ");
    return BASH(`echo "Backing up $1 from $PGHOST:$PGPORT ..."\npg_dump -v -d "$1" -F "$3" ${extra} -f "$2"\necho "✓ Backup saved: $2 ($(du -h "$2" | cut -f1))"`, db, opts.file, opts.format === "plain" ? "p" : "c");
  }
  if (conf.type === "mysql") {
    const extra = [opts.schemaOnly ? "--no-data" : "", opts.dataOnly ? "--no-create-info" : ""].filter(Boolean).join(" ");
    return BASH(
      `echo "Backing up $1 from $3:$4 ..."\nmysqldump -h "$3" -P "$4" -u "$5" --single-transaction --routines --triggers --events ${extra} --result-file="$2" "$1"\necho "✓ Backup saved: $2 ($(du -h "$2" | cut -f1))"`,
      db,
      opts.file,
      conf.host,
      String(conf.port),
      conf.user
    );
  }
  return [process.execPath, TASK_SCRIPT, "backup", db || "", opts.file];
}

// opts: { database (đích), file, recreate, clean, noOwner, noPrivileges, jobs }
function restoreArgv(conf, opts) {
  const db = opts.database || conf.database;
  if (conf.type === "postgres") {
    const plain = /\.sql$/i.test(opts.file);
    const flags = [opts.noOwner !== false ? "--no-owner" : "", opts.noPrivileges !== false ? "--no-privileges" : "", opts.clean && !opts.recreate ? "--clean --if-exists" : "", Number(opts.jobs) > 1 ? `-j ${Number(opts.jobs)}` : ""].filter(Boolean).join(" ");
    const recreate = opts.recreate
      ? `echo "1. Terminating connections to $1 ..."
psql -d postgres -v ON_ERROR_STOP=1 -qAt -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$(printf %s "$1" | sed "s/'/''/g")' AND pid <> pg_backend_pid();" || exit 1
echo "2. Dropping and recreating database $1 ..."
psql -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \\"$1\\";" || exit 1
psql -d postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \\"$1\\";" || exit 1
`
      : "";
    const load = plain ? `psql -d "$1" -v ON_ERROR_STOP=0 -f "$2"` : `pg_restore -v -d "$1" ${flags} "$2"`;
    return BASH(`${recreate}echo "3. Restoring $2 into $1 on $PGHOST:$PGPORT ..."\n${load}\ncode=$?\nif [ $code -eq 0 ]; then echo "✓ Restore finished"; else echo "⚠ Restore finished with warnings or errors (exit $code), check the log above"; fi\nexit $code`, db, opts.file);
  }
  if (conf.type === "mysql") {
    const recreate = opts.recreate ? `echo "Dropping and recreating $1 ..."\nmysql -h "$3" -P "$4" -u "$5" -e "DROP DATABASE IF EXISTS \\\`$1\\\`; CREATE DATABASE \\\`$1\\\`;" || exit 1\n` : "";
    return BASH(`${recreate}echo "Restoring $2 into $1 ..."\nmysql -h "$3" -P "$4" -u "$5" "$1" < "$2"\necho "✓ Restore finished"`, db, opts.file, conf.host, String(conf.port), conf.user);
  }
  return [process.execPath, TASK_SCRIPT, "restore", db || "", opts.file, opts.recreate ? "1" : "0"];
}

async function start(id, action, opts = {}) {
  const conf = store.getDatabase(id);
  opts = { ...opts, database: String(opts.database || conf.database || "").trim(), file: String(opts.file || "").trim() };
  if (conf.type !== "sqlite" && !opts.database) throw Object.assign(new Error("Choose a database"), { status: 400 });
  if (action === "backup") {
    opts.file ||= defaultFile(conf, opts.database, opts.format);
    if (conf.type !== "mssql") fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  } else if (action === "restore") {
    if (!opts.file) throw Object.assign(new Error("Choose a backup file"), { status: 400 });
    if (conf.type !== "mssql" && !fs.existsSync(opts.file)) throw Object.assign(new Error(`File not found: ${opts.file}`), { status: 400 });
  } else throw Object.assign(new Error("Unknown action"), { status: 400 });
  const argv = action === "backup" ? backupArgv(conf, opts) : restoreArgv(conf, opts);
  const label = `${action === "backup" ? "Backup" : "Restore"} ${conf.name}${opts.database ? ` / ${opts.database}` : ""}`;
  const run = await runner.startJob(jobKey(id), label, { argv }, secretEnv(conf));
  if (action === "restore") run.done.then(() => require("./index").drop(id));
  return { started: true, key: run.key, file: opts.file };
}

// Danh sách file backup trong thư mục mặc định, mới nhất trước
function listBackups() {
  const dir = store.load().workspace.backupDir;
  try {
    return fs
      .readdirSync(dir)
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, path: path.join(dir, name), size: st.size, mtime: st.mtimeMs };
      })
      .filter((f) => !f.name.startsWith("."))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

module.exports = { start, listBackups, jobKey, defaultFile, backupArgv, restoreArgv };
