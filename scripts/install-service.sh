#!/usr/bin/env bash
# Cài Dash thành service của user: tự chạy khi đăng nhập, tự khởi động lại khi lỗi (thay cho tmux).
# Linux dùng systemd user service, macOS dùng LaunchAgent của launchd.
#   bash scripts/install-service.sh            cài + bật + chạy
#   bash scripts/install-service.sh --uninstall
set -euo pipefail

DIR=$(cd "$(dirname "$0")/.." && pwd)
port() { node -e "try{console.log(require('$DIR/projects.json').settings.port||8899)}catch{console.log(8899)}"; }

if [[ $(uname) == Darwin ]]; then
  LABEL=local.dash
  PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
  DOMAIN=gui/$(id -u)
  if [[ ${1:-} == "--uninstall" ]]; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $PLIST"
    exit 0
  fi

  NODE=$(command -v node) || { echo "node not found in PATH" >&2; exit 1; }
  [[ -d $DIR/node_modules ]] || (cd "$DIR" && npm install)
  xml() { local s=${1//&/&amp;}; s=${s//</&lt;}; printf '%s' "${s//>/&gt;}"; }
  mkdir -p "$(dirname "$PLIST")" "$DIR/logs"
  # PATH của shell hiện tại được ghi vào plist để lệnh dự án tìm thấy conda, npm, uv… như khi chạy trong terminal.
  # AbandonProcessGroup: launchd chỉ dừng Dash; Dash tự dừng lệnh thường và terminal, còn lệnh "background" được giữ lại.
  cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "$NODE")</string><string>$(xml "$DIR/server.js")</string></array>
  <key>WorkingDirectory</key><string>$(xml "$DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$PATH")</string>
    <key>LANG</key><string>$(xml "${LANG:-en_US.UTF-8}")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>StandardOutPath</key><string>$(xml "$DIR/logs/dash-service.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$DIR/logs/dash-service.log")</string>
</dict>
</plist>
PLIST_END
  plutil -lint "$PLIST" >/dev/null
  echo "Installed $PLIST"

  PORT=$(port)
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && sleep 1 || true
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT is already used (Dash is probably still running in a terminal)."
    echo "Stop that copy, then run:"
    echo "  launchctl bootstrap $DOMAIN $PLIST"
    exit 0
  fi
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Dash: http://127.0.0.1:$PORT   ·   logs: tail -f $DIR/logs/dash-service.log"
  exit 0
fi

UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
UNIT=$UNIT_DIR/dash.service

if [[ ${1:-} == "--uninstall" ]]; then
  systemctl --user disable --now dash.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Removed dash.service"
  exit 0
fi

NODE=$(command -v node) || { echo "node not found in PATH" >&2; exit 1; }
[[ -d $DIR/node_modules ]] || (cd "$DIR" && npm install)

mkdir -p "$UNIT_DIR"
# PATH của shell hiện tại được ghi vào unit để lệnh dự án tìm thấy conda, npm, uv… như khi chạy trong terminal.
cat > "$UNIT" <<EOF
[Unit]
Description=Dash local workspace (terminals, git, Claude, databases)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/server.js
Restart=on-failure
RestartSec=3
# Chỉ dừng tiến trình Dash; Dash tự dừng lệnh thường và terminal, còn lệnh "background" của dự án được giữ lại.
KillMode=process
TimeoutStopSec=20
Environment=PATH=$PATH
Environment=LANG=${LANG:-C.UTF-8}
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable dash.service >/dev/null
echo "Installed $UNIT"

PORT=$(port)
if ss -ltn "( sport = :$PORT )" | grep -q LISTEN && ! systemctl --user is-active --quiet dash.service; then
  echo "Port $PORT is already used (Dash is probably still running in tmux)."
  echo "Stop that copy (Ctrl+C in its tmux window, or: tmux kill-session -t dash), then run:"
  echo "  systemctl --user start dash"
  exit 0
fi
systemctl --user restart dash.service
sleep 1
systemctl --user --no-pager --lines=3 status dash.service | head -5
echo "Dash: http://127.0.0.1:$PORT   ·   logs: journalctl --user -u dash -f"
