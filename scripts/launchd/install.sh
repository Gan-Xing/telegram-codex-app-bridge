#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.ganxing.telegram-codex-app-bridge.plist"
NODE_BIN="$(command -v node)"
PATH_VALUE="$PATH"
HOME_VALUE="$HOME"
USER_VALUE="${USER:-ganxing}"
LOGNAME_VALUE="${LOGNAME:-$USER_VALUE}"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ganxing.telegram-codex-app-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT_DIR/dist/main.js</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$PATH_VALUE</string>
    <key>HOME</key>
    <string>$HOME_VALUE</string>
    <key>USER</key>
    <string>$USER_VALUE</string>
    <key>LOGNAME</key>
    <string>$LOGNAME_VALUE</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.telegram-codex-app-bridge/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.telegram-codex-app-bridge/logs/launchd.err.log</string>
</dict>
</plist>
PLIST
launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"
echo "Installed $PLIST"
