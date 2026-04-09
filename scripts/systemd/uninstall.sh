#!/usr/bin/env bash
set -euo pipefail
UNIT_NAME="telegram-codex-app-bridge.service"
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$USER_SYSTEMD_DIR/$UNIT_NAME"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found" >&2
  exit 1
fi

systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl --user daemon-reload
echo "Removed $UNIT_PATH"
