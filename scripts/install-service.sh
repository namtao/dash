#!/usr/bin/env bash
# Cài Dash thành systemd user service: tự chạy khi đăng nhập, tự khởi động lại khi lỗi (thay cho tmux).
#   bash scripts/install-service.sh            cài + bật + chạy
#   bash scripts/install-service.sh --uninstall
set -euo pipefail

DIR=$(cd "$(dirname "$0")/.." && pwd)
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

PORT=$(node -e "try{console.log(require('$DIR/projects.json').settings.port||8899)}catch{console.log(8899)}")
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
