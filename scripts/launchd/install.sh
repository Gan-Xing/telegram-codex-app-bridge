#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/../service/_common.sh"

if [[ "$(platform_name)" != "darwin" ]]; then
  echo "launchd install is only supported on macOS" >&2
  exit 1
fi

require_node_bin
require_built_bridge
write_runner_script
chmod 755 "$RUNNER_PATH"
mkdir -p "$(dirname "$LAUNCHD_PLIST")" "$APP_LOG_DIR"

cat > "$LAUNCHD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNNER_PATH</string>
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
  <string>$APP_LOG_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$APP_LOG_DIR/launchd.err.log</string>
</dict>
</plist>
PLIST
launchctl unload "$LAUNCHD_PLIST" >/dev/null 2>&1 || true
launchctl load "$LAUNCHD_PLIST"
echo "Installed $LAUNCHD_PLIST"
