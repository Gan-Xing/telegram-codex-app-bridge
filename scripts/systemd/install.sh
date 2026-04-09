#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
UNIT_NAME="telegram-codex-app-bridge.service"
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$USER_SYSTEMD_DIR/$UNIT_NAME"
NODE_BIN="$(command -v node)"
# Do not embed full interactive $PATH: WSL often includes /mnt/c/Program Files/... which breaks
# systemd's unquoted Environment=PATH=... (spaces split the assignment). Use a small Linux PATH.
NODE_DIR="$(dirname "$NODE_BIN")"
PATH_VALUE="${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [[ -d "${HOME}/.local/bin" ]]; then
  PATH_VALUE="${HOME}/.local/bin:${PATH_VALUE}"
fi
HOME_VALUE="${HOME:?}"
USER_VALUE="${USER:-}"
LOGNAME_VALUE="${LOGNAME:-$USER_VALUE}"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found (need systemd)" >&2
  exit 1
fi

NO_BUILD=0
NO_START=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --no-start) NO_START=1 ;;
  esac
done

if [[ "$NO_BUILD" -eq 0 ]]; then
  (cd "$ROOT_DIR" && npm run build)
fi

mkdir -p "$USER_SYSTEMD_DIR" "$HOME/.telegram-codex-app-bridge/logs"

cat >"$UNIT_PATH" <<UNIT
[Unit]
Description=Telegram to Codex Desktop bridge (telegram-codex-app-bridge)
Documentation=https://github.com/Gan-Xing/telegram-codex-app-bridge
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
Environment=HOME=$HOME_VALUE
Environment=USER=$USER_VALUE
Environment=LOGNAME=$LOGNAME_VALUE
Environment=PATH=$PATH_VALUE
ExecStart=$NODE_BIN dist/main.js serve
Restart=always
RestartSec=10
TimeoutStopSec=45

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"
if [[ "$NO_START" -eq 0 ]]; then
  systemctl --user restart "$UNIT_NAME" || systemctl --user start "$UNIT_NAME"
fi

echo "Installed $UNIT_PATH"
echo "Status: systemctl --user status $UNIT_NAME"
echo "Logs:   journalctl --user -u $UNIT_NAME -f"
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
  echo ""
  echo "Tip: for this service to start at boot without an interactive login, run once:"
  echo "  loginctl enable-linger $USER"
fi
