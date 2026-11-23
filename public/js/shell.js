"use strict";
// Khung ngoài của Dash: mỗi tab dự án là một khung (iframe) chạy workbench riêng (index.html?w=<id>), nên tab editor,
// terminal, phiên Claude và thư mục của từng dự án không lẫn vào nhau. "main" là tab Overview, luôn có, không đóng được.
// Thanh tab do workbench trong khung tự vẽ trên title bar; khung gọi window.parent.DashShell để mở / chuyển / đóng.
(() => {
  const KEY = "dash:shellTabs";
  const frames = new Map(); // id -> iframe
  const subscribers = new Map(); // window của khung -> hàm vẽ lại
  let state = { tabs: ["main"], active: "main" };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved?.tabs?.length) state = { tabs: ["main", ...saved.tabs.filter((t) => t !== "main")], active: saved.active || "main" };
  } catch {}
  if (!state.tabs.includes(state.active)) state.active = "main";

  const save = () => localStorage.setItem(KEY, JSON.stringify(state));
  const api = (method, url) =>
    fetch(url, { method, headers: { "X-Dash": "1" } }).then((r) => {
      if (r.status === 401) location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      return r.json();
    });

  function notify() {
    save();
    for (const [win, fn] of subscribers) {
      try {
        if (win.closed) throw new Error("gone");
        fn({ tabs: [...state.tabs], active: state.active });
      } catch {
        subscribers.delete(win);
      }
    }
  }

  function frameFor(id) {
    let f = frames.get(id);
    if (!f) {
      f = document.createElement("iframe");
      f.src = `/index.html?w=${encodeURIComponent(id)}`;
      f.title = id;
      f.allow = "clipboard-read; clipboard-write";
      f.addEventListener("load", () => {
        try {
          f.contentWindow.__dashHidden = state.active !== id;
          if (state.active === id) document.title = f.contentDocument.title;
        } catch {}
      });
      document.body.append(f);
      frames.set(id, f);
    }
    return f;
  }

  function activate(id) {
    if (!state.tabs.includes(id)) return;
    state.active = id;
    const f = frameFor(id);
    for (const [fid, el] of frames) {
      el.classList.toggle("hidden", fid !== id);
      try {
        el.contentWindow.__dashHidden = fid !== id;
      } catch {}
    }
    try {
      document.title = f.contentDocument?.title || "Dash";
      f.contentWindow.focus();
    } catch {}
    notify();
  }

  function open(id) {
    if (!state.tabs.includes(id)) {
      const at = state.tabs.indexOf(state.active) + 1;
      state.tabs.splice(at || state.tabs.length, 0, id);
    }
    activate(id);
  }

  // Đóng tab dự án: hỏi nếu còn file chưa lưu; terminal và phiên Claude của dự án được đóng theo để không sót tiến trình.
  async function close(id) {
    if (id === "main" || !state.tabs.includes(id)) return;
    const f = frames.get(id);
    let dirty = false;
    try {
      dirty = Boolean(f?.contentWindow.W?.tabs.some((t) => t.inst?.isDirty?.()));
    } catch {}
    const [terms, sessions] = await Promise.all([api("GET", `/api/terminals?ws=${encodeURIComponent(id)}`).catch(() => []), api("GET", `/api/claude/sessions?ws=${encodeURIComponent(id)}`).catch(() => [])]);
    const parts = [];
    if (dirty) parts.push("unsaved changes will be lost");
    if (terms.length) parts.push(`${terms.length} terminal(s) will be closed`);
    if (sessions.length) parts.push(`${sessions.length} Claude conversation(s) will be closed`);
    if (parts.length && !(await ask(`Close the project tab "${id}"?\n\n${parts.map((p) => `• ${p}`).join("\n")}`))) return;
    await Promise.all([...terms.map((t) => api("DELETE", `/api/terminals/${t.id}`)), ...sessions.map((c) => api("DELETE", `/api/claude/sessions/${c.id}`))].map((p) => p.catch(() => {})));
    const i = state.tabs.indexOf(id);
    state.tabs.splice(i, 1);
    f?.remove();
    frames.delete(id);
    if (state.active === id) activate(state.tabs[Math.min(i, state.tabs.length - 1)] || "main");
    else notify();
  }

  // Hỏi bằng hộp thoại của workbench đang hiện (cùng giao diện), không dùng confirm() của trình duyệt
  function ask(message) {
    for (const fid of [state.active, "main"]) {
      try {
        const fn = frames.get(fid)?.contentWindow.confirmDialog;
        if (fn) return fn(message, { title: "Close project tab", ok: "Close", danger: true });
      } catch {}
    }
    return Promise.resolve(true);
  }

  function cycle(dir) {
    const i = state.tabs.indexOf(state.active);
    activate(state.tabs[(i + dir + state.tabs.length) % state.tabs.length]);
  }

  window.DashShell = {
    open,
    close,
    activate,
    cycle,
    state: () => ({ tabs: [...state.tabs], active: state.active }),
    subscribe(win, fn) {
      subscribers.set(win, fn);
      fn({ tabs: [...state.tabs], active: state.active });
    },
    setTitle(win, title) {
      for (const [id, f] of frames) if (f.contentWindow === win && id === state.active) document.title = title;
    },
  };

  // Mở bằng /#open=<id> (vd. từ bookmark) thì chuyển ngay tới dự án đó
  const m = location.hash.match(/^#open=(.+)$/);
  const w = new URLSearchParams(location.search).get("w");
  if (m || (w && w !== "main")) {
    history.replaceState(null, "", "/");
    open(m ? decodeURIComponent(m[1]) : w);
  } else activate(state.active);
})();

// Nền của khung ngoài theo theme sáng/tối
window.addEventListener("storage", (e) => {
  if (e.key === "dash:theme") document.documentElement.classList.toggle("light", JSON.parse(e.newValue || '"dark"') !== "dark");
});
