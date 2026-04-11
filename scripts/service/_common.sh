#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
DEFAULT_SERVICE_LABEL="com.ganxing.telegram-codex-app-bridge"
LEGACY_APP_HOME="${HOME}/.telegram-codex-app-bridge"
INSTANCES_APP_HOME="${LEGACY_APP_HOME}/instances"
SERVICE_LABEL_BASE="${SERVICE_LABEL_BASE:-${BRIDGE_SERVICE_LABEL:-$DEFAULT_SERVICE_LABEL}}"

find_node_bin() {
  local candidate
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    printf '%s' "$NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    "${HOME}/.local/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node
  do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  if [[ -d "${HOME}/.local" ]]; then
    while IFS= read -r candidate; do
      if [[ -x "$candidate" ]]; then
        printf '%s' "$candidate"
        return 0
      fi
    done < <(find "${HOME}/.local" -maxdepth 4 -type f -path '*/bin/node' 2>/dev/null | sort)
  fi
  return 1
}

NODE_BIN="$(find_node_bin || true)"
NODE_DIR=""
if [[ -n "$NODE_BIN" ]]; then
  NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
  case ":${PATH}:" in
    *":${NODE_DIR}:"*) ;;
    *) export PATH="${NODE_DIR}:${PATH}" ;;
  esac
fi

load_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    return
  fi
  if [[ -z "$NODE_BIN" ]]; then
    return
  fi
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    if [[ -z "${!key+x}" ]]; then
      export "${key}=${value}"
    fi
  done < <("$NODE_BIN" - "$ENV_FILE" "$ROOT_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const envPath = process.argv[2];
const rootDir = process.argv[3];

try {
  const dotenv = require(path.join(rootDir, 'node_modules', 'dotenv'));
  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    process.stdout.write(`${key}\u0000${value}\u0000`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to parse ${envPath}: ${message}`);
  process.exit(1);
}
NODE
)
}

sanitize_instance_id() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    return
  fi
  printf '%s' "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

resolve_bridge_engine() {
  local raw="${1:-codex}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    gemini) printf 'gemini' ;;
    claude) printf 'claude' ;;
    *) printf 'codex' ;;
  esac
}

resolve_bridge_instance_id() {
  local raw="${1:-}"
  local engine="${2:-codex}"
  local sanitized
  sanitized="$(sanitize_instance_id "$raw")"
  if [[ -n "$sanitized" ]]; then
    printf '%s' "$sanitized"
    return
  fi
  if [[ "$engine" == "codex" ]]; then
    return
  fi
  printf '%s' "$engine"
}

format_engine_display_name() {
  local engine="${1:-codex}"
  case "$engine" in
    gemini) printf 'Gemini' ;;
    claude) printf 'Claude' ;;
    *) printf 'Codex' ;;
  esac
}

load_env_file

BRIDGE_ENGINE="$(resolve_bridge_engine "${BRIDGE_ENGINE:-codex}")"
BRIDGE_INSTANCE_ID="$(resolve_bridge_instance_id "${BRIDGE_INSTANCE_ID:-}" "$BRIDGE_ENGINE")"
BRIDGE_HOME="${BRIDGE_HOME:-${APP_HOME:-}}"
if [[ -z "$BRIDGE_HOME" ]]; then
  if [[ -n "$BRIDGE_INSTANCE_ID" ]]; then
    BRIDGE_HOME="${INSTANCES_APP_HOME}/${BRIDGE_INSTANCE_ID}"
  else
    BRIDGE_HOME="${LEGACY_APP_HOME}"
  fi
fi
APP_HOME="${BRIDGE_HOME}"
if [[ -n "${SERVICE_LABEL:-}" ]]; then
  SERVICE_LABEL="${SERVICE_LABEL}"
elif [[ -n "$BRIDGE_INSTANCE_ID" ]]; then
  SERVICE_LABEL="${SERVICE_LABEL_BASE}-${BRIDGE_INSTANCE_ID}"
else
  SERVICE_LABEL="${SERVICE_LABEL_BASE}"
fi
ENGINE_DISPLAY_NAME="$(format_engine_display_name "$BRIDGE_ENGINE")"
SERVICE_DESCRIPTION="${SERVICE_DESCRIPTION:-Telegram ${ENGINE_DISPLAY_NAME} App Bridge}"
if [[ -n "$BRIDGE_INSTANCE_ID" ]]; then
  SERVICE_DESCRIPTION="${SERVICE_DESCRIPTION} (${BRIDGE_INSTANCE_ID})"
fi
APP_LOG_DIR="${APP_HOME}/logs"
APP_BIN_DIR="${APP_HOME}/bin"
RUNNER_PATH="${APP_BIN_DIR}/run-bridge.sh"
LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
SYSTEMD_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SYSTEMD_UNIT_NAME="${SYSTEMD_UNIT_NAME:-${SERVICE_LABEL}.service}"
SYSTEMD_UNIT_PATH="${SYSTEMD_UNIT_DIR}/${SYSTEMD_UNIT_NAME}"
PATH_VALUE="${PATH}"
HOME_VALUE="${HOME}"
USER_VALUE="${USER:-$(id -un)}"
LOGNAME_VALUE="${LOGNAME:-$USER_VALUE}"

platform_name() {
  local uname_value
  uname_value="$(uname -s)"
  case "$uname_value" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    CYGWIN*|MINGW*|MSYS*) echo "win32" ;;
    *) echo "unsupported" ;;
  esac
}

require_supported_platform() {
  local platform
  platform="$(platform_name)"
  if [[ "$platform" == "unsupported" ]]; then
    echo "unsupported platform: $(uname -s)" >&2
    exit 1
  fi
}

require_node_bin() {
  if [[ -z "$NODE_BIN" ]]; then
    echo "node not found in PATH" >&2
    exit 1
  fi
}

require_built_bridge() {
  if [[ ! -f "${ROOT_DIR}/dist/main.js" ]]; then
    echo "dist/main.js not found. Run 'npm run build' first." >&2
    exit 1
  fi
}

ensure_app_dirs() {
  mkdir -p "$APP_LOG_DIR" "$APP_BIN_DIR"
}

write_runner_script() {
  ensure_app_dirs
  local root_q node_q main_q env_file_q app_home_q engine_q
  root_q="$(printf '%q' "$ROOT_DIR")"
  node_q="$(printf '%q' "$NODE_BIN")"
  main_q="$(printf '%q' "${ROOT_DIR}/dist/main.js")"
  env_file_q="$(printf '%q' "$ENV_FILE")"
  app_home_q="$(printf '%q' "$APP_HOME")"
  engine_q="$(printf '%q' "$BRIDGE_ENGINE")"
  cat > "$RUNNER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export ENV_FILE=${env_file_q}
export BRIDGE_ENGINE=${engine_q}
export BRIDGE_HOME=${app_home_q}
EOF
  if [[ -n "$BRIDGE_INSTANCE_ID" ]]; then
    local instance_q
    instance_q="$(printf '%q' "$BRIDGE_INSTANCE_ID")"
    cat >> "$RUNNER_PATH" <<EOF
export BRIDGE_INSTANCE_ID=${instance_q}
EOF
  fi
  cat >> "$RUNNER_PATH" <<EOF
cd ${root_q}
exec ${node_q} ${main_q} serve
EOF
}

require_systemctl() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found; systemd user services are unavailable on this host" >&2
    exit 1
  fi
}

require_journalctl() {
  if ! command -v journalctl >/dev/null 2>&1; then
    echo "journalctl not found" >&2
    exit 1
  fi
}

require_launchd_agent() {
  if [[ ! -f "$LAUNCHD_PLIST" ]]; then
    echo "launchd agent is not installed: $LAUNCHD_PLIST" >&2
    exit 1
  fi
}

require_systemd_unit() {
  if [[ ! -f "$SYSTEMD_UNIT_PATH" ]]; then
    echo "systemd user unit is not installed: $SYSTEMD_UNIT_PATH" >&2
    exit 1
  fi
}
