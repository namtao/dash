"use strict";
// Giá coin ở thanh trạng thái (cạnh hạn mức Claude): giá theo USDT và % đổi từ 00:00 UTC trên Binance / OKX / Bitget.
// Bấm vào để thêm / sửa / xoá coin, đổi sàn, thị trường (spot / futures) và chu kỳ cập nhật. Lưu trong projects.json.
(() => {
  let data = null; // { exchange, market, refreshSec, coins: [{ symbol, price, change, error }], exchanges, exchangeLabel, fetchedAt }
  let timer = null;

  const fmtPrice = (p) =>
    p >= 100 ? p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(4) : String(Number(p.toPrecision(4)));
  const fmtChange = (c) => `${c > 0 ? "+" : ""}${c.toFixed(2)}%`;
  const dir = (c) => (c >= 0 ? "up" : "down");
  const updated = () => (data?.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString("en-GB") : "-");
  const label = () => `${data?.exchangeLabel || ""} ${data?.market === "spot" ? "Spot" : "Futures"}`;

  function paintStatus() {
    const coins = data?.coins || [];
    W.status("crypto", {
      side: "right",
      order: 4,
      html: coins.length
        ? coins.map((c) => (c.error || c.price == null ? `<span class="sb-coin"><b>${esc(c.symbol)}</b> ${c.error ? "?" : "…"}</span>` : `<span class="sb-coin ${dir(c.change)}"><b>${esc(c.symbol)}</b> ${fmtPrice(c.price)} ${fmtChange(c.change)}</span>`)).join("")
        : `<span class="sb-coin"><b>₿</b> ${data?.error ? "?" : "Add coin"}</span>`,
      title:
        (coins.length ? `${label()} · USDT · change since 00:00 UTC\n` + coins.map((c) => `${c.symbol}: ${c.error ? c.error : c.price == null ? "…" : `$${fmtPrice(c.price)} (${fmtChange(c.change)})`}`).join("\n") + `\nUpdated ${updated()}` : "Track coin prices") +
        (data?.error ? `\n${data.error}` : "") +
        "\nClick to add, edit or remove coins",
      cmd: "crypto.manage",
    });
  }

  // ---------- hộp quản lý coin ----------
  const modalOpen = () => modal().open && $("#crypto-list", modal());

  function paintList() {
    const box = modalOpen();
    if (!box || $("input", box)) return; // đang sửa tên coin thì không vẽ lại
    const coins = data?.coins || [];
    box.innerHTML = coins.length
      ? coins
          .map(
            (c) => `<div class="crypto-row" data-coin="${esc(c.symbol)}">
              <span class="crypto-sym">${esc(c.symbol)}</span>
              ${c.error || c.price == null ? `<span class="crypto-price faint">${esc(c.error || "Loading…")}</span><span></span>` : `<span class="crypto-price">${fmtPrice(c.price)}</span><span class="crypto-chg ${dir(c.change)}">${fmtChange(c.change)}</span>`}
              <span class="crypto-actions"><button class="icon" data-cr="edit" title="Edit symbol">✎</button><button class="icon" data-cr="delete" title="Remove">✕</button></span>
            </div>`
          )
          .join("")
      : `<div class="empty">No coins yet. Add one below.</div>`;
    $("#crypto-meta", modal()).textContent = `${label()} · price in USDT · change since 00:00 UTC · updated ${updated()}${data?.error ? ` · ${data.error}` : ""}`;
  }

  function paint() {
    paintStatus();
    paintList();
  }

  async function save(patch) {
    const r = await guarded(() => api("PUT", "/api/crypto", patch));
    if (!r) return false;
    data = r;
    paint();
    return true;
  }

  const symbols = () => (data?.coins || []).map((c) => c.symbol);
  const clean = (s) => String(s || "").trim().toUpperCase().replace(/[-/]?USDT$/, "");

  function editRow(row) {
    const old = row.dataset.coin;
    const cell = $(".crypto-sym", row);
    cell.innerHTML = `<input class="mono" value="${esc(old)}" maxlength="20" />`;
    const input = $("input", cell);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const sym = clean(input.value);
      input.remove(); // để paintList vẽ lại được
      if (commit && sym && sym !== old) {
        if (symbols().includes(sym)) toast(`${sym} is already in the list`, "error");
        else if (await save({ coins: symbols().map((s) => (s === old ? sym : s)) })) return;
      }
      paintList();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") {
        e.preventDefault(); // Esc chỉ huỷ sửa, không đóng hộp
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function manage() {
    const ex = data?.exchanges || { binance: "Binance", okx: "OKX", bitget: "Bitget" };
    const m = openModal(
      "Coin prices",
      `<div class="form">
        <label class="field"><span>Exchange</span><select id="crypto-exchange">${Object.entries(ex).map(([k, v]) => `<option value="${k}" ${data?.exchange === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
        <label class="field"><span>Market</span><select id="crypto-market"><option value="futures" ${data?.market !== "spot" ? "selected" : ""}>Futures (USDT perpetual)</option><option value="spot" ${data?.market === "spot" ? "selected" : ""}>Spot</option></select></label>
        <label class="field"><span>Refresh (seconds)</span><input id="crypto-refresh" type="number" min="5" max="3600" value="${esc(data?.refreshSec || 15)}" /></label>
      </div>
      <div id="crypto-list" class="crypto-list"></div>
      <form id="crypto-add" class="crypto-add"><input name="sym" class="mono" placeholder="Symbol, e.g. SOL" maxlength="20" autocomplete="off" required /><button class="btn primary">＋ Add</button></form>
      <small id="crypto-meta" class="faint"></small>`,
      `<button class="btn" data-cr="refresh">↻ Refresh</button><button class="btn primary" data-action="close-modal">Done</button>`
    );
    paintList();
    $("#crypto-exchange", m).onchange = (e) => save({ exchange: e.target.value });
    $("#crypto-market", m).onchange = (e) => save({ market: e.target.value });
    $("#crypto-refresh", m).onchange = async (e) => {
      if (await save({ refreshSec: Number(e.target.value) })) schedule();
    };
    $("#crypto-add", m).onsubmit = async (e) => {
      e.preventDefault();
      const input = e.target.sym;
      const sym = clean(input.value);
      if (!sym) return;
      if (symbols().includes(sym)) return toast(`${sym} is already in the list`, "error");
      if (await save({ coins: [...symbols(), sym] })) {
        input.value = "";
        const c = data.coins.find((x) => x.symbol === sym);
        if (c?.error) toast(`${sym}: ${c.error} on ${label()}`, "error");
      }
      input.focus();
    };
    $(".modal-body", m).onclick = (e) => {
      const a = e.target.closest("[data-cr]")?.dataset.cr;
      const row = e.target.closest("[data-coin]");
      if (!a || !row) return;
      if (a === "edit") return editRow(row);
      if (a === "delete") save({ coins: symbols().filter((s) => s !== row.dataset.coin) });
    };
    $(".modal-foot [data-cr=refresh]", m).onclick = () => load(true);
    $("#crypto-add input", m).focus();
  }

  async function load(force) {
    try {
      data = await api("GET", `/api/crypto${force ? "?force=1" : ""}`);
    } catch (e) {
      data = { ...(data || { coins: [] }), error: e.message };
    }
    paint();
  }
  // Server cache theo refreshSec nên nhiều tab dự án cùng hỏi vẫn chỉ tốn một lượt gọi sàn
  function schedule() {
    clearTimeout(timer);
    const next = () => (timer = setTimeout(schedule, Math.max(5, data?.refreshSec || 15) * 1000));
    if (document.hidden) return next();
    load().finally(next);
  }
  document.addEventListener("visibilitychange", () => !document.hidden && schedule());

  W.command("crypto.manage", "Coin prices: add, edit or remove coins…", manage);
  W.command("crypto.refresh", "Coin prices: refresh now", () => load(true));
  W.on("ready", schedule);
})();
