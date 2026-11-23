// Tải file / thư mục về trình duyệt (thư mục nén ZIP ngay khi gửi) và nhận file tải lên, cho cả máy này lẫn
// thư mục SSH (ssh://<hồ sơ>/đường/dẫn). Thư mục SSH được đóng gói bằng `tar` ở máy kia rồi đổi sang ZIP tại đây.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const files = require("./files");
const remote = require("./remote");
const ssh = require("./ssh-profiles");
const { ZipStream } = require("./zip-stream");

const q = ssh.shellQuote;
const httpError = (status, message) => Object.assign(new Error(message), { status });
// Bỏ qua khi người dùng chọn tải "không kèm thư mục nặng"
const HEAVY = [".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", ".cache", ".DS_Store"];
const SKIPPED_NOTE = "_skipped-by-dash.txt";

async function stat(p) {
  p = files.abs(p);
  if (remote.isRemote(p)) {
    const { profile, dir } = remote.parse(p);
    const st = await remote.stat(profile, dir);
    if (!Number.isFinite(st.size)) throw httpError(404, "Not found");
    return { path: p, size: st.size, mtime: st.mtime, dir: st.isDir };
  }
  const st = await fsp.stat(p);
  return { path: p, size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
}

// Thư mục bắt đầu cho hồ sơ SSH: thư mục mặc định của hồ sơ, không có thì thư mục home trên máy đó
async function sshHome(id) {
  const { profile } = remote.parse(`ssh://${id}/`);
  if (profile.remoteDir?.startsWith("/")) return `ssh://${id}${profile.remoteDir}`;
  const dir = (await remote.exec(profile, "pwd")).trim();
  return `ssh://${id}${dir.startsWith("/") ? dir : "/"}`;
}

function sshSpawn(profile, command) {
  return spawn("ssh", ssh.execArgs(profile, command), { stdio: ["ignore", "pipe", "pipe"] });
}

// Tên file trong Content-Disposition: bản ASCII cho trình duyệt cũ + bản UTF-8 (RFC 5987)
function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function startDownload(res, name, type, length) {
  const headers = { "Content-Type": type, "Content-Disposition": disposition(name), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (length != null) headers["Content-Length"] = length;
  res.writeHead(200, headers);
}

// ----- thư mục trên máy này: duyệt đệ quy, bỏ symlink (tránh vòng lặp) và file đặc biệt (socket, FIFO) -----
async function zipLocalDir(zip, dir, prefix, skipHeavy, skipped) {
  let items;
  try {
    items = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    skipped.push(`${prefix || "."}: ${e.code || e.message}`);
    return;
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const d of items) {
    if (skipHeavy && HEAVY.includes(d.name)) continue;
    const full = path.join(dir, d.name);
    const rel = prefix + d.name;
    if (d.isDirectory()) {
      const st = await fsp.stat(full).catch(() => null);
      await zip.addDir(rel, { mtime: st?.mtimeMs, mode: st?.mode });
      await zipLocalDir(zip, full, `${rel}/`, skipHeavy, skipped);
    } else if (d.isFile()) {
      // Mở trước khi ghi header: file không đọc được thì bỏ qua thay vì làm hỏng file ZIP
      let fh;
      try {
        fh = await fsp.open(full, "r");
      } catch (e) {
        skipped.push(`${rel}: ${e.code || e.message}`);
        continue;
      }
      const st = await fh.stat();
      await zip.addFile(rel, { mtime: st.mtimeMs, mode: st.mode, size: st.size }, fh.createReadStream());
    } else if (d.isSymbolicLink()) skipped.push(`${rel}: symbolic link (not followed)`);
  }
}

// ----- đọc luồng tar (ustar, GNU tên dài, pax) từ máy SSH -----
function byteReader(stream) {
  const it = stream[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  async function fill(n) {
    while (buf.length < n) {
      const { value, done } = await it.next();
      if (done) return false;
      buf = buf.length ? Buffer.concat([buf, value]) : value;
    }
    return true;
  }
  const r = {
    async exact(n) {
      if (!(await fill(n))) return null;
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    async upTo(n) {
      if (!buf.length && !(await fill(1))) throw new Error("The tar stream ended early");
      const out = buf.subarray(0, Math.min(n, buf.length));
      buf = buf.subarray(out.length);
      return out;
    },
    async skip(n) {
      while (n > 0) n -= (await r.upTo(Math.min(n, 1 << 20))).length;
    },
  };
  return r;
}

const cstr = (b) => {
  const i = b.indexOf(0);
  return b.subarray(0, i < 0 ? b.length : i).toString("utf8");
};
function tarNumber(b) {
  // số lớn (> 8 GB) mã hoá base-256: bit cao nhất của byte đầu bật
  if (b[0] & 0x80) {
    let n = BigInt(b[0] & 0x7f);
    for (let i = 1; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
    return Number(n);
  }
  return parseInt(cstr(b).trim() || "0", 8);
}
function paxRecords(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\d+ ([^=]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function zipTar(zip, stream, skipped) {
  const rd = byteReader(stream);
  let longName = null;
  let pax = {};
  for (;;) {
    const h = await rd.exact(512);
    if (!h || h.every((x) => x === 0)) break;
    const type = String.fromCharCode(h[156] || 48);
    let size = tarNumber(h.subarray(124, 136));
    const pad = (512 - (size % 512)) % 512;
    if (type === "L" || type === "x" || type === "g" || type === "K") {
      const data = size ? await rd.exact(size) : Buffer.alloc(0);
      await rd.skip(pad);
      if (type === "L") longName = cstr(data);
      if (type === "x") pax = paxRecords(data.toString("utf8"));
      continue;
    }
    const prefix = h.subarray(257, 262).toString() === "ustar" ? cstr(h.subarray(345, 500)) : "";
    let name = pax.path || longName || (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100)));
    if (pax.size) size = Number(pax.size);
    const realPad = (512 - (size % 512)) % 512;
    const mtime = (pax.mtime ? Number(pax.mtime) : tarNumber(h.subarray(136, 148))) * 1000;
    const mode = tarNumber(h.subarray(100, 108));
    longName = null;
    pax = {};
    name = name.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
    // Không cho tên chứa ".." lọt vào ZIP (giải nén sẽ ghi ra ngoài thư mục)
    if (!name || name.split("/").includes("..")) {
      await rd.skip(size + realPad);
      continue;
    }
    if (type === "5") {
      await zip.addDir(name, { mtime, mode });
      await rd.skip(size + realPad);
    } else if (type === "0" || type === "7" || h[156] === 0) {
      let left = size;
      const body = Readable.from(
        (async function* () {
          while (left > 0) {
            const chunk = await rd.upTo(Math.min(left, 256 * 1024));
            left -= chunk.length;
            yield chunk;
          }
        })()
      );
      await zip.addFile(name, { mtime, mode, size }, body);
      await rd.skip(left + realPad);
    } else {
      if (type === "2" || type === "1") skipped.push(`${name}: ${type === "2" ? "symbolic" : "hard"} link (not followed)`);
      await rd.skip(size + realPad);
    }
  }
}

// GET: file thì gửi nguyên file, thư mục thì gửi file ZIP (skipHeavy: bỏ node_modules, .git, .venv…)
async function download(p, res, { skipHeavy = false } = {}) {
  p = files.abs(p);
  const info = await stat(p);
  const base = (remote.isRemote(p) ? path.posix.basename(remote.parse(p).dir) : path.basename(p)) || "root";
  const kids = new Set();
  res.on("close", () => kids.forEach((c) => c.kill()));
  try {
    if (!info.dir) {
      if (!remote.isRemote(p)) {
        const fh = await fsp.open(p, "r"); // không đọc được thì báo lỗi trước khi gửi header
        startDownload(res, base, "application/octet-stream", (await fh.stat()).size);
        return await pipeline(fh.createReadStream(), res);
      }
      const { profile, dir: file } = remote.parse(p);
      const child = sshSpawn(profile, `cat -- ${q(file)}`);
      kids.add(child);
      const exited = new Promise((resolve) => child.on("close", resolve));
      startDownload(res, base, "application/octet-stream", info.size);
      await pipeline(child.stdout, res, { end: false });
      if ((await exited) !== 0) throw new Error("Could not read the file on the remote machine");
      return res.end();
    }
    startDownload(res, `${base}.zip`, "application/zip", null);
    const zip = new ZipStream(res);
    const skipped = [];
    if (!remote.isRemote(p)) {
      await zip.addDir(base, { mtime: info.mtime });
      await zipLocalDir(zip, p, `${base}/`, skipHeavy, skipped);
    } else {
      const { profile, dir } = remote.parse(p);
      const parent = path.posix.dirname(dir);
      // "./tên" để tên bắt đầu bằng "-" không bị tar hiểu là tuỳ chọn; thư mục gốc "/" thì đóng gói "."
      const what = dir === "/" ? "." : `./${path.posix.basename(dir)}`;
      const excludes = skipHeavy ? HEAVY.map((n) => `--exclude=${q(n)}`).join(" ") : "";
      const child = sshSpawn(profile, `cd -- ${q(parent)} && LC_ALL=C tar cf - ${excludes} ${q(what)}`);
      kids.add(child);
      let errText = "";
      child.stderr.on("data", (d) => (errText = (errText + d).slice(-20000)));
      const exited = new Promise((resolve) => child.on("close", resolve));
      await zipTar(zip, child.stdout, skipped);
      const code = await exited;
      const errors = errText.split("\n").map((l) => l.trim()).filter((l) => l && !/Removing leading|socket ignored/i.test(l));
      // tar trả 1 khi có file đổi trong lúc đọc, 2 khi có file không đọc được: vẫn giữ phần đã đóng gói
      if (code > 2 || (code && !zip.entries.length)) throw new Error(errors.pop() || `tar exited with code ${code}`);
      skipped.push(...errors);
    }
    if (skipped.length) {
      const note = Buffer.from(`Dash left these out of the archive:\n\n${skipped.join("\n")}\n`);
      await zip.addFile(`${base}/${SKIPPED_NOTE}`, { size: note.length }, Readable.from([note]));
    }
    await zip.finish();
    res.end();
  } catch (e) {
    // Đã gửi header: chỉ còn cách cắt kết nối để trình duyệt báo tải lỗi, không để lại file thiếu mà tưởng đủ
    if (res.headersSent) return res.destroy(e);
    throw e;
  }
}

// PUT thân request là nội dung file. overwrite: cho ghi đè; mtime: lưu lại file đang sửa (Excel), file đã bị
// sửa ở nơi khác thì báo xung đột. Ghi vào file tạm rồi đổi tên, kiểm đủ số byte trước khi đổi tên.
async function upload(p, req, { overwrite = false, mtime = 0 } = {}) {
  p = files.abs(p);
  const expected = Number(req.headers["content-length"]);
  if (!Number.isFinite(expected) || req.headers["content-length"] == null) throw httpError(411, "Content-Length is required");
  const old = await stat(p).catch(() => null);
  if (old?.dir) throw httpError(409, "A folder with this name already exists");
  if (old && !overwrite) throw httpError(409, "A file with this name already exists");
  const tmpName = `.${path.posix.basename(p.replace(/^ssh:\/\/[^/]+/, ""))}.dash-upload-${crypto.randomBytes(4).toString("hex")}`;
  if (remote.isRemote(p)) {
    const { profile, id, dir: file } = remote.parse(p);
    // máy từ xa chỉ cho mtime theo giây
    if (old && mtime && Math.abs(old.mtime - Math.floor(mtime / 1000) * 1000) > 1000) throw httpError(409, "File changed on disk since it was opened");
    const folder = path.posix.dirname(file);
    const tmp = path.posix.join(folder, tmpName);
    const child = spawn("ssh", ssh.execArgs(profile, `mkdir -p -- ${q(folder)} && cat > ${q(tmp)} && [ "$(wc -c < ${q(tmp)} | tr -d ' ')" = ${expected} ] && mv -f -- ${q(tmp)} ${q(file)} || { rm -f -- ${q(tmp)}; echo 'Upload was incomplete' >&2; exit 1; }`), { stdio: ["pipe", "ignore", "pipe"] });
    let errText = "";
    child.stderr.on("data", (d) => (errText += d));
    const exited = new Promise((resolve) => child.on("close", resolve));
    req.on("aborted", () => child.kill());
    try {
      await pipeline(req, child.stdin);
    } catch {
      child.kill();
    }
    const code = await exited;
    if (code !== 0) throw httpError(400, `${profile.label}: ${errText.trim().split("\n").pop() || "upload failed"}`);
    const st = await stat(p);
    return { path: `ssh://${id}${file}`, size: st.size, mtime: st.mtime };
  }
  if (old && mtime && Math.abs(old.mtime - mtime) > 1) throw httpError(409, "File changed on disk since it was opened");
  const folder = path.dirname(p);
  await fsp.mkdir(folder, { recursive: true });
  const tmp = path.join(folder, tmpName);
  try {
    await pipeline(req, fs.createWriteStream(tmp, { flags: "wx", mode: old ? (await fsp.stat(p)).mode & 0o7777 : 0o644 }));
    const st = await fsp.stat(tmp);
    if (st.size !== expected) throw httpError(400, "Upload was incomplete");
    await fsp.rename(tmp, p);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  const st = await fsp.stat(p);
  return { path: p, size: st.size, mtime: st.mtimeMs };
}

module.exports = { stat, sshHome, download, upload };
