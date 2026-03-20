#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

require_supported_platform
case "$(platform_name)" in
  darwin)
    bash "${ROOT_DIR}/scripts/launchd/install.sh"
    ;;
  linux)
    bash "${SCRIPT_DIR}/install-systemd.sh"
    ;;
  win32)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT_DIR}/install.ps1"
    ;;
esac
