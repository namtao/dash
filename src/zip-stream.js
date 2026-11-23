// Ghi file ZIP thẳng ra một stream (response HTTP) mà không cần biết trước nội dung: mỗi file nén deflate, CRC và
// dung lượng nằm ở data descriptor sau dữ liệu. Tự dùng ZIP64 khi file / vị trí / số mục vượt giới hạn 32 bit.
// Chỉ dùng node:zlib, không thêm thư viện.
const zlib = require("zlib");
const { Transform, Writable } = require("stream");
const { pipeline } = require("stream/promises");

const MAX32 = 0xffffffff;
// Ngưỡng chuyển sang ZIP64 cho một file: chừa chỗ cho phần deflate có thể phình ra với dữ liệu đã nén sẵn
const BIG = 0xf0000000;
// Đã nén sẵn: nén lại tốn CPU mà không nhỏ đi, dùng mức nén nhanh nhất
const PACKED = /\.(zip|gz|tgz|bz2|xz|7z|rar|zst|jpe?g|png|gif|webp|avif|heic|mp3|m4a|aac|ogg|mp4|m4v|mov|mkv|webm|pdf|docx|xlsx|pptx|jar|apk|dmg|iso)$/i;

function dosTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class ZipStream {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
  }

  // Ghi có chờ khi bộ đệm đầy; người nhận đóng kết nối thì báo lỗi để dừng đọc file
  write(buf) {
    const out = this.out;
    if (out.destroyed || out.writableEnded) return Promise.reject(new Error("Download was cancelled"));
    this.offset += buf.length;
    if (out.write(buf)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (err) => {
        out.off("drain", onDrain);
        out.off("close", onClose);
        err ? reject(err) : resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(new Error("Download was cancelled"));
      out.on("drain", onDrain);
      out.on("close", onClose);
    });
  }

  localHeader(e, zip64) {
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2); // cỡ thật nằm ở data descriptor
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(zip64 ? 45 : 20, 4);
    h.writeUInt16LE(e.dir ? 0x0800 : 0x0808, 6); // bit 3: data descriptor, bit 11: tên UTF-8
    h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(e.dos.time, 10);
    h.writeUInt16LE(e.dos.date, 12);
    h.writeUInt32LE(0, 14);
    h.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    h.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    h.writeUInt16LE(e.name.length, 26);
    h.writeUInt16LE(extra.length, 28);
    return Buffer.concat([h, e.name, extra]);
  }

  async addDir(name, { mtime, mode = 0o755 } = {}) {
    const e = { name: Buffer.from(name.replace(/\/*$/, "/")), dir: true, method: 0, dos: dosTime(mtime), mode: 0o40000 | (mode & 0o7777), crc: 0, csize: 0, usize: 0, offset: this.offset };
    await this.write(this.localHeader(e, false));
    this.entries.push(e);
  }

  // source: Readable chứa nội dung file; size: cỡ biết trước (để chọn ZIP64), nội dung thật được đếm lại khi ghi
  async addFile(name, { mtime, mode = 0o644, size = 0 } = {}, source) {
    const e = { name: Buffer.from(name), dir: false, method: 8, dos: dosTime(mtime), mode: 0o100000 | (mode & 0o7777), crc: 0, csize: 0, usize: 0, offset: this.offset };
    e.zip64 = size >= BIG;
    await this.write(this.localHeader(e, e.zip64));
    const zip = this;
    const count = new Transform({
      transform(chunk, enc, cb) {
        e.crc = zlib.crc32(chunk, e.crc);
        e.usize += chunk.length;
        cb(null, chunk);
      },
    });
    const sink = new Writable({
      write(chunk, enc, cb) {
        e.csize += chunk.length;
        zip.write(chunk).then(() => cb(), cb);
      },
    });
    await pipeline(source, count, zlib.createDeflateRaw({ level: PACKED.test(name) ? 1 : 6 }), sink);
    // File lớn lên trong lúc đọc, vượt quá chỗ của data descriptor 32 bit: không ghi ra một file ZIP hỏng
    if (!e.zip64 && (e.usize > MAX32 || e.csize > MAX32)) throw new Error(`${name} grew past 4 GB while being read`);
    const d = Buffer.alloc(e.zip64 ? 24 : 16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(e.crc >>> 0, 4);
    if (e.zip64) {
      d.writeBigUInt64LE(BigInt(e.csize), 8);
      d.writeBigUInt64LE(BigInt(e.usize), 16);
    } else {
      d.writeUInt32LE(e.csize, 8);
      d.writeUInt32LE(e.usize, 12);
    }
    await this.write(d);
    this.entries.push(e);
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      // Trường nào tràn 32 bit thì ghi 0xFFFFFFFF và đưa giá trị thật vào extra ZIP64 (theo đúng thứ tự)
      const big = [e.usize > MAX32 - 1 || e.zip64, e.csize > MAX32 - 1 || e.zip64, e.offset > MAX32 - 1];
      const vals = [e.usize, e.csize, e.offset].filter((_, i) => big[i]);
      const extra = vals.length ? Buffer.alloc(4 + 8 * vals.length) : Buffer.alloc(0);
      if (vals.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8 * vals.length, 2);
        vals.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | 45, 4); // tạo trên Unix: giữ quyền file
      h.writeUInt16LE(vals.length ? 45 : 20, 6);
      h.writeUInt16LE(e.dir ? 0x0800 : 0x0808, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.dos.time, 12);
      h.writeUInt16LE(e.dos.date, 14);
      h.writeUInt32LE(e.crc >>> 0, 16);
      h.writeUInt32LE(big[1] ? MAX32 : e.csize, 20);
      h.writeUInt32LE(big[0] ? MAX32 : e.usize, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE(((e.mode << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
      h.writeUInt32LE(big[2] ? MAX32 : e.offset, 42);
      await this.write(Buffer.concat([h, e.name, extra]));
    }
    const size = this.offset - start;
    const count = this.entries.length;
    const zip64 = count > 0xfffe || size > MAX32 - 1 || start > MAX32 - 1;
    if (zip64) {
      const at = this.offset;
      const r = Buffer.alloc(56 + 20);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(44n, 4);
      r.writeUInt16LE((3 << 8) | 45, 12);
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(count), 24);
      r.writeBigUInt64LE(BigInt(count), 32);
      r.writeBigUInt64LE(BigInt(size), 40);
      r.writeBigUInt64LE(BigInt(start), 48);
      r.writeUInt32LE(0x07064b50, 56);
      r.writeBigUInt64LE(BigInt(at), 64);
      r.writeUInt32LE(1, 72);
      await this.write(r);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip64 ? 0xffff : count, 8);
    end.writeUInt16LE(zip64 ? 0xffff : count, 10);
    end.writeUInt32LE(zip64 ? MAX32 : size, 12);
    end.writeUInt32LE(zip64 ? MAX32 : start, 16);
    await this.write(end);
  }
}

module.exports = { ZipStream };
