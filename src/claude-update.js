// Tự cập nhật Claude Code CLI (`claude update`): chạy sau khi Dash khởi động một lúc rồi mỗi 24 giờ,
// nếu bật claudeAutoUpdate. Cũng chạy được bằng tay từ Settings / command palette.
const { execFile } = require("child_process");
const store = require("./store");

const DAY = 24 * 60 * 60 * 1000;
const state = { version: "", lastCheck: 0, lastOutput: "", error: "", running: null };
let binary = () => "claude";

function run(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(binary(), args, { timeout, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (err) return reject(new Error(out || err.message));
      resolve(out);
    });
  });
}

async function readVersion() {
  try {
    state.version = (await run(["--version"], 15000)).split("\n")[0];
  } catch (e) {
    state.version = "";
    state.error = e.message;
  }
  return state.version;
}

function update() {
  state.running ||= run(["update"], 5 * 60 * 1000)
    .then((out) => {
      state.lastOutput = out;
      state.error = "";
    })
    .catch((e) => {
      state.error = e.message;
    })
    .then(readVersion)
    .finally(() => {
      state.lastCheck = Date.now();
      state.running = null;
    });
  return state.running.then(status);
}

const status = () => ({ version: state.version, lastCheck: state.lastCheck, output: state.lastOutput, error: state.error, running: Boolean(state.running), auto: store.load().workspace.claudeAutoUpdate });

function schedule(findBinary) {
  if (findBinary) binary = () => findBinary() || "claude";
  readVersion();
  const tick = () => {
    if (store.load().workspace.claudeAutoUpdate && Date.now() - state.lastCheck > DAY - 60000) update();
  };
  setTimeout(tick, 2 * 60 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}

module.exports = { status, update, schedule, readVersion };
