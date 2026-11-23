// Chuyển giá trị từ driver sang dạng gửi được qua JSON để hiển thị và sửa trong bảng kết quả.
const pad = (n, w = 2) => String(n).padStart(w, "0");

function fmtDate(d) {
  if (Number.isNaN(d.getTime())) return String(d);
  const ms = d.getMilliseconds();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms ? `.${pad(ms, 3)}` : ""}`;
}

function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return fmtDate(v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v);
    return { $binary: b.length > 64 ? `0x${b.subarray(0, 64).toString("hex")}… (${b.length} bytes)` : `0x${b.toString("hex")}` };
  }
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

module.exports = { cell, fmtDate };
