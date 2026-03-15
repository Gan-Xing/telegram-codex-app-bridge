#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

if [[ "$(platform_name)" != "linux" ]]; then
  echo "systemd install is only supported on Linux" >&2
  exit 1
fi

require_systemctl
require_node_bin
require_built_bridge
write_runner_script
chmod 755 "$RUNNER_PATH"
mkdir -p "$SYSTEMD_UNIT_DIR"

cat > "$SYSTEMD_UNIT_PATH" <<EOF
[Unit]
Description=${SERVICE_DESCRIPTION}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
ExecStart=${RUNNER_PATH}
Restart=always
RestartSec=2
Environment=PATH=${PATH_VALUE}
Environment=HOME=${HOME_VALUE}
Environment=USER=${USER_VALUE}
Environment=LOGNAME=${LOGNAME_VALUE}

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$SYSTEMD_UNIT_NAME"
echo "Installed ${SYSTEMD_UNIT_PATH}"
