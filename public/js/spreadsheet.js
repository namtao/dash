"use strict";
// Excel (.xlsx): xem và sửa ô ngay trong Dash bằng ExcelJS (chạy trong trình duyệt). Ctrl+S ghi cả workbook lại
// qua /api/files/upload (kiểm mtime để không đè thay đổi từ nơi khác), dùng được cho cả thư mục SSH.
// ExcelJS không tính công thức: ô công thức mới sửa hiện công thức, Excel tính lại khi mở file.
(() => {
  const MAX_ROWS = 5000;
  const MAX_COLS = 200;
  const PAD_ROWS = 30; // thêm dòng / cột trống để gõ nối tiếp bảng
  const PAD_COLS = 6;

  const colName = (i) => {
    let s = "";
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  };

  // Giá trị đưa vào ô sửa: công thức hiện "=…", ngày hiện YYYY-MM-DD, còn lại là chữ hiển thị
  function editText(cell) {
    const v = cell.value;
    if (v == null) return "";
    if (v.formula || v.sharedFormula) return `=${v.formula || cell.formula || ""}`;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.hyperlink) return String(v.text ?? v.hyperlink);
    return typeof v === "object" ? cell.text : String(v);
  }

  // Chữ gõ vào -> giá trị ô: "" xoá, "=…" công thức, số thành số, ô ngày giữ kiểu ngày
  function parseInput(text, old) {
    const t = text.trim();
    if (t === "") return null;
    if (t.startsWith("=") && t.length > 1) return { formula: t.slice(1) };
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
    if (old instanceof Date && !Number.isNaN(Date.parse(t))) return new Date(t);
    return text;
  }

  W.mountSheet = async (box, blob, p, { mtime, onChange }) => {
    await W.loadScript("/vendor/exceljs/exceljs.min.js");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blob.arrayBuffer());
    const st = { sheet: 0, r: 0, c: 0, changed: new Map(), mtime, saving: false };
    const ws = () => wb.worksheets[st.sheet];
    const key = (r, c) => `${st.sheet}:${r}:${c}`;

    box.innerHTML = `<div class="sheet-tabs">${wb.worksheets.map((s, i) => `<button class="sheet-tab" data-sheet="${i}">${esc(s.name)}</button>`).join("")}<span class="sheet-hint faint">Double-click or type to edit · Ctrl+S saves</span></div><div class="grid-view sheet-grid" tabindex="0"></div>`;
    const grid = $(".sheet-grid", box);

    function size() {
      const s = ws();
      const rows = Math.min(MAX_ROWS, (s?.actualRowCount ? s.rowCount : 0) + PAD_ROWS);
      const cols = Math.min(MAX_COLS, (s?.actualColumnCount ? s.columnCount : 0) + PAD_COLS);
      return { rows, cols, more: (s?.rowCount || 0) > MAX_ROWS };
    }

    function cellHtml(r, c) {
      const cell = ws().getCell(r + 1, c + 1);
      const v = cell.value;
      const isFormula = v && typeof v === "object" && (v.formula || v.sharedFormula);
      // công thức vừa sửa chưa có kết quả: hiện chính công thức
      const text = isFormula && v.result == null ? editText(cell) : cell.text;
      const cls = [typeof v === "number" || (isFormula && typeof v.result === "number") ? "num" : "", st.changed.has(key(r, c)) ? "changed" : "", st.r === r && st.c === c ? "sel" : ""].join(" ");
      return `<td data-c="${c}" class="${cls}" title="${esc(text)}">${esc(text)}</td>`;
    }

    function paint() {
      $$(".sheet-tab", box).forEach((b, i) => b.classList.toggle("active", i === st.sheet));
      if (!ws()) return (grid.innerHTML = `<div class="empty faint">This workbook has no sheets.</div>`);
      const { rows, cols, more } = size();
      let html = `<table class="rgrid"><thead><tr><th class="rn"></th>${Array.from({ length: cols }, (_, i) => `<th>${colName(i)}</th>`).join("")}</tr></thead><tbody>`;
      for (let r = 0; r < rows; r++) {
        let tds = "";
        for (let c = 0; c < cols; c++) tds += cellHtml(r, c);
        html += `<tr data-r="${r}"><td class="rn">${r + 1}</td>${tds}</tr>`;
      }
      html += `</tbody></table>${more ? `<div class="empty faint">Showing the first ${MAX_ROWS} rows of ${ws().rowCount}. Rows further down are kept when saving.</div>` : ""}`;
      const scroll = [grid.scrollTop, grid.scrollLeft];
      grid.innerHTML = html;
      [grid.scrollTop, grid.scrollLeft] = scroll;
    }

    const td = (r, c) => $(`tr[data-r="${r}"] td[data-c="${c}"]`, grid);
    function repaintCell(r, c) {
      const el = td(r, c);
      if (el) el.outerHTML = cellHtml(r, c);
    }
    function select(r, c, scroll = true) {
      const { rows, cols } = size();
      const [or, oc] = [st.r, st.c];
      st.r = Math.min(rows - 1, Math.max(0, r));
      st.c = Math.min(cols - 1, Math.max(0, c));
      repaintCell(or, oc);
      repaintCell(st.r, st.c);
      if (scroll) td(st.r, st.c)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    function setValue(r, c, text) {
      const cell = ws().getCell(r + 1, c + 1);
      const before = editText(cell);
      if (before === text) return;
      cell.value = parseInput(text, cell.value);
      st.changed.set(key(r, c), true);
      repaintCell(r, c);
      onChange?.();
    }

    function edit(r, c, initial) {
      const el = td(r, c);
      if (!el || $(".cell-input", grid)) return;
      const cell = ws().getCell(r + 1, c + 1);
      el.classList.add("editing");
      el.innerHTML = `<input class="cell-input" spellcheck="false" />`;
      const input = $(".cell-input", el);
      input.value = initial ?? editText(cell);
      input.focus();
      if (initial == null) input.select();
      let done = false;
      const finish = (save, move) => {
        if (done) return;
        done = true;
        if (save) setValue(r, c, input.value);
        else repaintCell(r, c);
        if (move) select(r + move[0], c + move[1]);
        else repaintCell(st.r, st.c);
        grid.focus();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.preventDefault(), finish(true, [e.shiftKey ? -1 : 1, 0]));
        else if (e.key === "Tab") (e.preventDefault(), finish(true, [0, e.shiftKey ? -1 : 1]));
        else if (e.key === "Escape") (e.preventDefault(), finish(false));
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          finish(true);
          api.save();
        }
      });
      input.addEventListener("blur", () => finish(true));
    }

    // Dán bảng chép từ Excel / Google Sheets (cột cách nhau bằng Tab, dòng bằng xuống dòng) từ ô đang chọn
    function paste(text) {
      const rows = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
      rows.forEach((row, i) => row.forEach((v, j) => setValue(st.r + i, st.c + j, v)));
      paint();
    }

    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sheet]");
      if (b) {
        st.sheet = Number(b.dataset.sheet);
        st.r = st.c = 0;
        return paint();
      }
      const cell = e.target.closest("td[data-c]");
      if (cell && !cell.classList.contains("editing")) select(Number(cell.parentElement.dataset.r), Number(cell.dataset.c), false);
    });
    grid.addEventListener("dblclick", (e) => {
      const cell = e.target.closest("td[data-c]");
      if (cell) edit(Number(cell.parentElement.dataset.r), Number(cell.dataset.c));
    });
    grid.addEventListener("keydown", (e) => {
      if (e.target !== grid) return;
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      const mod = e.ctrlKey || e.metaKey;
      if (moves[e.key]) {
        e.preventDefault();
        select(st.r + moves[e.key][0], st.c + moves[e.key][1]);
      } else if (e.key === "Tab") {
        e.preventDefault();
        select(st.r, st.c + (e.shiftKey ? -1 : 1));
      } else if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        edit(st.r, st.c);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        setValue(st.r, st.c, "");
      } else if (mod && e.key.toLowerCase() === "c") {
        navigator.clipboard?.writeText(ws().getCell(st.r + 1, st.c + 1).text);
      } else if (e.key.length === 1 && !mod && !e.altKey) {
        e.preventDefault();
        edit(st.r, st.c, e.key);
      }
    });
    grid.addEventListener("paste", (e) => {
      if (e.target !== grid) return;
      e.preventDefault();
      paste(e.clipboardData.getData("text/plain"));
    });

    async function put(force) {
      wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true }; // Excel tính lại công thức khi mở
      const buf = await wb.xlsx.writeBuffer();
      const res = await fetch(`/api/files/upload?path=${encodeURIComponent(p)}&overwrite=1${force ? "" : `&mtime=${st.mtime}`}`, { method: "PUT", headers: { "X-Dash": "1", "Content-Type": "application/octet-stream" }, body: buf });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) toLogin();
      if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
      return data;
    }

    const api = {
      isDirty: () => st.changed.size > 0,
      async save(force = false) {
        if (!st.changed.size || st.saving) return true;
        if (!store.get("xlsxSaveWarned", false)) {
          const ok = await confirmDialog("Dash rewrites the whole workbook when it saves. Cell values, formulas and most formatting are kept, but charts, pivot tables, images and macros can be lost.\nKeep a copy of important files first.", { title: "Save Excel file", ok: "Save" });
          if (!ok) return false;
          store.set("xlsxSaveWarned", true);
        }
        st.saving = true;
        try {
          const r = await put(force);
          st.mtime = r.mtime;
          st.changed.clear();
          paint();
          onChange?.();
          W.emit("file:saved", p);
          toast(`Saved ${W.base(p)}`, "ok", 1500);
          return true;
        } catch (e) {
          if (e.status === 409 && /changed on disk/.test(e.message)) {
            st.saving = false;
            if (await confirmDialog(`${W.base(p)} was changed on disk since you opened it.\nOverwrite it with your version?`, { title: "File changed on disk", ok: "Overwrite", danger: true })) return api.save(true);
            return false;
          }
          toast(e.message, "error");
          return false;
        } finally {
          st.saving = false;
        }
      },
    };
    paint();
    return api;
  };
})();
