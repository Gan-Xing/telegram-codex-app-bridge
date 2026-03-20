#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_supported_platform
case "$(platform_name)" in
  darwin)
    require_launchd_agent
    launchctl bootout "gui/${UID}" "$LAUNCHD_PLIST" >/dev/null 2>&1 || true
    rm -f "$LAUNCHD_PLIST"
    echo "Removed ${LAUNCHD_PLIST}"
    ;;
  linux)
    require_systemctl
    require_systemd_unit
    systemctl --user disable --now "$SYSTEMD_UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "$SYSTEMD_UNIT_PATH"
    systemctl --user daemon-reload
    systemctl --user reset-failed >/dev/null 2>&1 || true
    echo "Removed ${SYSTEMD_UNIT_PATH}"
    ;;
  win32)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT_DIR}/uninstall.ps1"
    ;;
esac
