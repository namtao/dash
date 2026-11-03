// Giá coin cho thanh trạng thái: lấy từ API public (không cần key) của Binance, OKX, Bitget, tính % đổi
// từ 00:00 UTC. Server gọi thay trình duyệt (không vướng CORS) và cache theo refreshSec, nên nhiều tab
// cùng hỏi chỉ tốn một lượt request.
const store = require("./store");

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
  } catch (e) {
    throw new Error(e.name === "TimeoutError" ? "Timed out" : e.cause?.code || e.message);
  }
  if (!res.ok) throw new Error(res.status === 400 || res.status === 404 ? "Not listed" : `HTTP ${res.status}`);
  return res.json();
}

const pct = (now, open) => (open ? ((now - open) / open) * 100 : 0);

const EXCHANGES = {
  binance: {
    label: "Binance",
    async price(sym, market) {
      const base = market === "futures" ? "https://fapi.binance.com/fapi/v1/klines" : "https://api.binance.com/api/v3/klines";
      const d = (await getJson(`${base}?symbol=${sym}USDT&interval=1d&limit=1`))[0];
      if (!d) throw new Error("Not listed");
      return { price: Number(d[4]), change: pct(Number(d[4]), Number(d[1])) };
    },
  },
  okx: {
    label: "OKX",
    async price(sym, market) {
      const id = market === "futures" ? `${sym}-USDT-SWAP` : `${sym}-USDT`;
      const d = (await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${id}`)).data?.[0];
      if (!d) throw new Error("Not listed");
      // sodUtc0: giá mở đầu ngày 00:00 UTC
      return { price: Number(d.last), change: pct(Number(d.last), Number(d.sodUtc0)) };
    },
  },
  bitget: {
    label: "Bitget",
    async price(sym, market) {
      const url =
        market === "futures"
          ? `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${sym}USDT&productType=USDT-FUTURES`
          : `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}USDT`;
      const d = (await getJson(url)).data?.[0];
      if (!d) throw new Error("Not listed");
      // changeUtc24h: Bitget đã tính sẵn tỉ lệ đổi từ 00:00 UTC
      return { price: Number(d.lastPr), change: Number(d.changeUtc24h) * 100 };
    },
  },
};

const state = { key: "", data: null, fetchedAt: 0, inflight: null, inflightKey: "" };

async function fetchAll(conf) {
  const ex = EXCHANGES[conf.exchange];
  const results = await Promise.allSettled(conf.coins.map((sym) => ex.price(sym, conf.market)));
  return results.map((r, i) =>
    r.status === "fulfilled" && Number.isFinite(r.value.price) ? { symbol: conf.coins[i], ...r.value } : { symbol: conf.coins[i], error: r.reason?.message || "No price" }
  );
}

// Trả về cấu hình hiện tại kèm giá; đổi cấu hình (sàn, thị trường, danh sách coin) thì lấy lại ngay.
async function prices(force = false) {
  const conf = store.load().crypto;
  const key = JSON.stringify(conf);
  const fresh = state.key === key && Date.now() - state.fetchedAt < (force ? 3000 : conf.refreshSec * 1000 - 500);
  if (!fresh && conf.coins.length) {
    // Lượt đang chạy là của cấu hình cũ thì đợi nó xong rồi lấy lại theo cấu hình mới
    if (state.inflight && state.inflightKey !== key) await state.inflight;
    if (!state.inflight) {
      state.inflightKey = key;
      state.inflight = fetchAll(conf)
        .then((data) => Object.assign(state, { key, data, fetchedAt: Date.now() }))
        .finally(() => (state.inflight = null));
    }
    await state.inflight;
  }
  const coins = state.key === key && state.data ? state.data : conf.coins.map((symbol) => ({ symbol }));
  return { ...conf, exchangeLabel: EXCHANGES[conf.exchange].label, exchanges: Object.fromEntries(Object.entries(EXCHANGES).map(([k, v]) => [k, v.label])), coins, fetchedAt: state.key === key ? state.fetchedAt : 0 };
}

module.exports = { prices };
