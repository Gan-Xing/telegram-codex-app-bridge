#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

LINES="${LINES:-200}"
FOLLOW="${FOLLOW:-true}"

require_supported_platform
case "$(platform_name)" in
  darwin)
    ensure_app_dirs
    touch "${APP_LOG_DIR}/launchd.out.log" "${APP_LOG_DIR}/launchd.err.log"
    if [[ "$FOLLOW" == "false" ]]; then
      tail -n "$LINES" "${APP_LOG_DIR}/launchd.out.log" "${APP_LOG_DIR}/launchd.err.log"
    else
      tail -n "$LINES" -f "${APP_LOG_DIR}/launchd.out.log" "${APP_LOG_DIR}/launchd.err.log"
    fi
    ;;
  linux)
    require_systemctl
    require_journalctl
    require_systemd_unit
    if [[ "$FOLLOW" == "false" ]]; then
      journalctl --user -u "$SYSTEMD_UNIT_NAME" -n "$LINES" --no-pager
    else
      journalctl --user -u "$SYSTEMD_UNIT_NAME" -n "$LINES" -f
    fi
    ;;
  win32)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT_DIR}/logs.ps1"
    ;;
esac
