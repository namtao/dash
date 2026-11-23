"use strict";
// Diff gọn cho điện thoại (thay diff editor của Monaco, quá chật trên màn hẹp): một cột, mỗi dòng một số thứ tự,
// dấu +/−, tự xuống dòng, chỉ hiện các đoạn thay đổi kèm 3 dòng ngữ cảnh; phần không đổi gấp lại, chạm để mở.
// Dòng bị sửa (xoá rồi thêm liền nhau) tô riêng phần chữ khác nhau.
(() => {
  const CTX = 3;
  const MAX_D = 4000; // quá số bước này (file viết lại gần hết) thì coi cả phần giữa là xoá rồi thêm, khỏi tốn bộ nhớ

  const lines = (s) => {
    if (!s) return [];
    const a = String(s).split("\n");
    if (a[a.length - 1] === "") a.pop();
    return a;
  };

  // Myers O(ND) trên dòng. Trả về [{t: " " | "-" | "+", a: số dòng cũ, b: số dòng mới, s}]
  function diffLines(oldText, newText) {
    const A = lines(oldText), B = lines(newText);
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
    const mid = myers(a, b) || [...a.map(() => "-"), ...b.map(() => "+")];
    const out = [];
    let i = 0, j = 0;
    for (let k = 0; k < pre; k++, i++, j++) out.push({ t: " ", a: i + 1, b: j + 1, s: A[i] });
    for (const t of mid) {
      if (t === " ") out.push({ t, a: ++i, b: ++j, s: A[i - 1] });
      else if (t === "-") out.push({ t, a: ++i, b: 0, s: A[i - 1] });
      else out.push({ t, a: 0, b: ++j, s: B[j - 1] });
    }
    for (let k = 0; k < suf; k++, i++, j++) out.push({ t: " ", a: i + 1, b: j + 1, s: A[i] });
    return out;
  }

  // Trả về dãy " " / "-" / "+" (đủ để dựng lại), hoặc null khi vượt MAX_D
  function myers(a, b) {
    const n = a.length, m = b.length, max = n + m;
    if (!n || !m) return [...a.map(() => "-"), ...b.map(() => "+")];
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
      if (d > MAX_D) return null;
      trace.push(v.slice(off - d - 1, off + d + 2)); // chỉ giữ k trong [-d-1, d+1]: bộ nhớ O(D²)
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) x++, y++;
        v[off + k] = x;
        if (x >= n && y >= m) return backtrack(trace, n, m);
      }
    }
    return null;
  }

  function backtrack(trace, n, m) {
    const ops = [];
    let x = n, y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const snap = trace[d], at = (k) => snap[k + d + 1];
      const k = x - y;
      const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const px = d ? at(pk) : 0, py = d ? px - pk : 0;
      while (x > px && y > py) ops.push(" "), x--, y--;
      if (d) ops.push(x === px ? "+" : "-");
      x = px;
      y = py;
    }
    return ops.reverse();
  }

  // Nhóm dòng thành các đoạn thay đổi (kèm ngữ cảnh) và các khoảng không đổi bị gấp ở giữa
  function hunks(ops) {
    const keep = new Uint8Array(ops.length);
    ops.forEach((o, i) => {
      if (o.t === " ") return;
      for (let k = Math.max(0, i - CTX); k <= Math.min(ops.length - 1, i + CTX); k++) keep[k] = 1;
    });
    const parts = [];
    for (let i = 0; i < ops.length; ) {
      const shown = keep[i];
      let j = i;
      while (j < ops.length && keep[j] === shown) j++;
      parts.push({ shown: Boolean(shown), from: i, to: j });
      i = j;
    }
    return parts;
  }

  // Phần chữ khác nhau giữa dòng cũ và dòng mới (bỏ đầu và đuôi giống nhau). null khi hai dòng khác hẳn.
  function changedSpan(x, y) {
    let p = 0;
    while (p < x.length && p < y.length && x[p] === y[p]) p++;
    let s = 0;
    while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
    if (p + s < Math.min(x.length, y.length) * 0.3) return null;
    return [p, s];
  }
  const marked = (str, span) => {
    if (!span) return esc(str);
    const [p, s] = span;
    const mid = str.slice(p, str.length - s);
    return esc(str.slice(0, p)) + (mid ? `<mark>${esc(mid)}</mark>` : "") + esc(str.slice(str.length - s));
  };

  function lineHtml(o, span) {
    const cls = o.t === "+" ? "add" : o.t === "-" ? "del" : "";
    const no = o.t === "-" ? o.a : o.b;
    return `<div class="pd-l ${cls}"><span class="pd-n">${no}</span><span class="pd-s">${o.t === " " ? "" : o.t === "+" ? "+" : "−"}</span><span class="pd-t">${marked(o.s, span) || " "}</span></div>`;
  }

  function rangeHtml(ops, from, to) {
    let html = "";
    for (let i = from; i < to; ) {
      if (ops[i].t !== "-") {
        html += lineHtml(ops[i++]);
        continue;
      }
      // khối xoá rồi khối thêm liền nhau: ghép cặp từng dòng để tô phần chữ đổi
      let d = i;
      while (d < to && ops[d].t === "-") d++;
      let e = d;
      while (e < to && ops[e].t === "+") e++;
      const dels = ops.slice(i, d), adds = ops.slice(d, e);
      const spans = dels.map((o, k) => (adds[k] ? changedSpan(o.s, adds[k].s) : null));
      html += dels.map((o, k) => lineHtml(o, spans[k])).join("");
      html += adds.map((o, k) => lineHtml(o, spans[k])).join("");
      i = e;
    }
    return html;
  }

  // Vẽ diff vào el. Trả về số đoạn thay đổi.
  function render(el, original, modified) {
    const ops = diffLines(original, modified);
    const parts = hunks(ops);
    const add = ops.filter((o) => o.t === "+").length, del = ops.filter((o) => o.t === "-").length;
    const n = parts.filter((p) => p.shown).length;
    if (!add && !del) {
      el.innerHTML = `<div class="empty">No changes</div>`;
      return 0;
    }
    el.innerHTML =
      `<div class="pd-sum"><span>${n} change${n === 1 ? "" : "s"}</span><b class="pd-plus">+${add}</b><b class="pd-minus">−${del}</b></div>` +
      parts
        .map((p, i) =>
          p.shown
            ? `<div class="pd-hunk">${rangeHtml(ops, p.from, p.to)}</div>`
            : `<button class="pd-gap" data-gap="${i}">⋯ ${p.to - p.from} unchanged line${p.to - p.from === 1 ? "" : "s"}</button>`,
        )
        .join("");
    el.onclick = (e) => {
      const g = e.target.closest("[data-gap]");
      if (!g) return;
      const p = parts[+g.dataset.gap];
      g.outerHTML = `<div class="pd-hunk pd-ctx">${rangeHtml(ops, p.from, p.to)}</div>`;
    };
    return n;
  }

  // Cuộn tới đoạn thay đổi kế tiếp / trước đó, chừa chỗ cho dòng tóm tắt dính ở trên
  function step(el, dir) {
    const pad = (el.querySelector(".pd-sum")?.offsetHeight || 0) + 6;
    const top = el.scrollTop + pad;
    // .code-editor là offsetParent (position: relative) nên offsetTop tính từ đầu vùng cuộn
    const hs = [...el.querySelectorAll(".pd-hunk:not(.pd-ctx)")].map((h) => h.offsetTop);
    const to = dir > 0 ? hs.find((y) => y > top + 4) : [...hs].reverse().find((y) => y < top - 4);
    if (to != null) el.scrollTo({ top: Math.max(0, to - pad), behavior: "smooth" });
  }

  W.mobileDiff = { render, step, diffLines };
})();
