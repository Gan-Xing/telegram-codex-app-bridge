#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_supported_platform
case "$(platform_name)" in
  darwin)
    require_launchd_agent
    launchctl bootstrap "gui/${UID}" "$LAUNCHD_PLIST" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/${UID}/${SERVICE_LABEL}"
    ;;
  linux)
    require_systemctl
    require_systemd_unit
    systemctl --user daemon-reload
    systemctl --user start "$SYSTEMD_UNIT_NAME"
    ;;
  win32)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT_DIR}/start.ps1"
    ;;
esac
