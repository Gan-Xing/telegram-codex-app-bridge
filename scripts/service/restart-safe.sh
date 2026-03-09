#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

BUILD_BEFORE_RESTART="${BUILD_BEFORE_RESTART:-true}"
NOTIFY_TELEGRAM="${NOTIFY_TELEGRAM:-true}"
RESTART_TIMEOUT_SEC="${RESTART_TIMEOUT_SEC:-90}"
RESTART_POLL_SEC="${RESTART_POLL_SEC:-2}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
STATUS_FILE="${STATUS_FILE:-${APP_HOME}/runtime/status.json}"
DETACH="${DETACH:-false}"
START_NOTIFY="${START_NOTIFY:-true}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"
SAFE_RESTART_UNIT_PREFIX="${SAFE_RESTART_UNIT_PREFIX:-com.ganxing.telegram-codex-app-bridge.safe-restart}"
NOTIFY_TARGET="${NOTIFY_TARGET:-auto}"

latest_notify_scope_cache="__unset__"

load_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
      export "${key}=${value}"
    done < <(node - "$ENV_FILE" "$ROOT_DIR" <<'NODE'
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
  fi
}

default_store_path() {
  if [[ -n "${STORE_PATH:-}" ]]; then
    printf '%s' "$STORE_PATH"
    return
  fi
  printf '%s' "${APP_HOME}/data/bridge.sqlite"
}

read_latest_inbound_scope() {
  local db_path
  db_path="$(default_store_path)"
  if [[ ! -f "$db_path" ]]; then
    return 0
  fi
  node - "$db_path" <<'NODE'
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.argv[2];
if (!dbPath || !fs.existsSync(dbPath)) {
  process.exit(0);
}

try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare(`
    SELECT chat_id
    FROM audit_logs
    WHERE direction = 'inbound'
      AND event_type IN ('telegram.message', 'telegram.callback')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get();
  if (row && row.chat_id !== null && row.chat_id !== undefined) {
    process.stdout.write(String(row.chat_id));
  }
  db.close();
} catch {
  process.exit(0);
}
NODE
}

resolve_notify_scope_id() {
  if [[ -n "${NOTIFY_SCOPE_ID:-}" ]]; then
    printf '%s' "$NOTIFY_SCOPE_ID"
    return
  fi
  if [[ "$NOTIFY_TARGET" != "auto" ]]; then
    return
  fi
  if [[ "$latest_notify_scope_cache" == "__unset__" ]]; then
    latest_notify_scope_cache="$(read_latest_inbound_scope)"
  fi
  if [[ -n "$latest_notify_scope_cache" ]]; then
    printf '%s' "$latest_notify_scope_cache"
  fi
}

scope_chat_id() {
  local scope_id="$1"
  if [[ "$scope_id" == *"::"* ]]; then
    printf '%s' "${scope_id%%::*}"
    return
  fi
  printf '%s' "$scope_id"
}

scope_topic_id() {
  local scope_id="$1"
  local topic_part
  if [[ "$scope_id" != *"::"* ]]; then
    return
  fi
  topic_part="${scope_id##*::}"
  if [[ "$topic_part" == "root" || -z "$topic_part" ]]; then
    return
  fi
  printf '%s' "$topic_part"
}

resolve_notify_chat_id() {
  local scope_id
  if [[ -n "${NOTIFY_CHAT_ID:-}" ]]; then
    printf '%s' "$NOTIFY_CHAT_ID"
    return
  fi
  scope_id="$(resolve_notify_scope_id)"
  if [[ -n "$scope_id" ]]; then
    printf '%s' "$(scope_chat_id "$scope_id")"
    return
  fi
  case "$NOTIFY_TARGET" in
    group)
      if [[ -n "${TG_ALLOWED_CHAT_ID:-}" ]]; then
        printf '%s' "$TG_ALLOWED_CHAT_ID"
        return
      fi
      ;;
    auto)
      if [[ -n "${TG_ALLOWED_CHAT_ID:-}" ]]; then
        printf '%s' "$TG_ALLOWED_CHAT_ID"
        return
      fi
      ;;
    private)
      ;;
    *)
      ;;
  esac
  printf '%s' "${TG_ALLOWED_USER_ID:-}"
}

resolve_notify_topic_id() {
  local scope_id
  if [[ -n "${NOTIFY_TOPIC_ID:-}" ]]; then
    printf '%s' "$NOTIFY_TOPIC_ID"
    return
  fi
  scope_id="$(resolve_notify_scope_id)"
  if [[ -n "$scope_id" ]]; then
    printf '%s' "$(scope_topic_id "$scope_id")"
    return
  fi
  if [[ "$NOTIFY_TARGET" == "group" || "$NOTIFY_TARGET" == "auto" ]]; then
    printf '%s' "${TG_ALLOWED_TOPIC_ID:-}"
    return
  fi
  printf '%s' ""
}

telegram_send_message_once() {
  local text="$1"
  local token chat_id topic_id url
  token="${NOTIFY_BOT_TOKEN:-${TG_BOT_TOKEN:-}}"
  chat_id="$(resolve_notify_chat_id)"
  topic_id="$(resolve_notify_topic_id)"
  if [[ -z "$token" || -z "$chat_id" ]]; then
    return 1
  fi

  local response
  url="https://api.telegram.org/bot${token}/sendMessage"
  if [[ -n "$topic_id" && "$chat_id" == -* ]]; then
    response="$(curl -sS -X POST "$url" \
      --data-urlencode "chat_id=${chat_id}" \
      --data-urlencode "message_thread_id=${topic_id}" \
      --data-urlencode "text=${text}" \
      --data-urlencode "disable_web_page_preview=true")" || return 1
    [[ "$response" == *'"ok":true'* ]]
    return
  fi

  response="$(curl -sS -X POST "$url" \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true")" || return 1
  [[ "$response" == *'"ok":true'* ]]
}

notify_telegram() {
  local text="$1"
  if [[ "$NOTIFY_TELEGRAM" != "true" ]]; then
    return 0
  fi

  local attempt
  for attempt in 1 2 3; do
    if telegram_send_message_once "$text"; then
      return 0
    fi
    sleep 1
  done
  return 0
}

run_id_for_unit() {
  printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9.-]/-/g'
}

launch_detached_restart() {
  if [[ "$(platform_name)" != "linux" ]]; then
    echo "DETACH=true currently requires Linux systemd user services." >&2
    exit 1
  fi
  require_systemctl
  if ! command -v systemd-run >/dev/null 2>&1; then
    echo "systemd-run not found; cannot launch detached restart." >&2
    exit 1
  fi

  local unit_name now_iso queued_msg
  unit_name="${SAFE_RESTART_UNIT_PREFIX}-$(run_id_for_unit)"
  now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  queued_msg=$'[bridge] restart queued (detached)\n'
  queued_msg+="time: ${now_iso}"$'\n'
  queued_msg+="run_id: ${RUN_ID}"$'\n'
  queued_msg+="unit: ${unit_name}"
  echo "$queued_msg"
  notify_telegram "$queued_msg"

  systemd-run --user --unit "$unit_name" --collect --quiet \
    --setenv=DETACH=false \
    --setenv=RUN_ID="$RUN_ID" \
    --setenv=BUILD_BEFORE_RESTART="$BUILD_BEFORE_RESTART" \
    --setenv=NOTIFY_TELEGRAM="$NOTIFY_TELEGRAM" \
    --setenv=START_NOTIFY=true \
    --setenv=RESTART_TIMEOUT_SEC="$RESTART_TIMEOUT_SEC" \
    --setenv=RESTART_POLL_SEC="$RESTART_POLL_SEC" \
    --setenv=ENV_FILE="$ENV_FILE" \
    --setenv=STATUS_FILE="$STATUS_FILE" \
    --setenv=NOTIFY_BOT_TOKEN="${NOTIFY_BOT_TOKEN:-}" \
    --setenv=NOTIFY_CHAT_ID="${NOTIFY_CHAT_ID:-}" \
    --setenv=NOTIFY_TOPIC_ID="${NOTIFY_TOPIC_ID:-}" \
    /bin/bash -lc "'${SCRIPT_DIR}/restart-safe.sh'"

  echo "Detached unit launched: ${unit_name}"
}

status_is_healthy() {
  local restart_started_ms="$1"
  node - "$STATUS_FILE" "$restart_started_ms" <<'NODE'
const fs = require('node:fs');

const statusPath = process.argv[2];
const restartStartedMs = Number(process.argv[3] || 0);

try {
  const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const updatedAtMs = typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) : NaN;
  const fresh = Number.isFinite(updatedAtMs) && updatedAtMs >= (restartStartedMs - 1000);
  if (parsed.running === true && parsed.connected === true && fresh) {
    process.exit(0);
  }
} catch {
  // ignore, handled by exit code
}
process.exit(1);
NODE
}

read_status_updated_at() {
  node - "$STATUS_FILE" <<'NODE'
const fs = require('node:fs');
const statusPath = process.argv[2];
try {
  const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  process.stdout.write(String(parsed.updatedAt || 'unknown'));
} catch {
  process.stdout.write('unknown');
}
NODE
}

read_status_summary() {
  node - "$STATUS_FILE" <<'NODE'
const fs = require('node:fs');
const statusPath = process.argv[2];
try {
  const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const running = parsed.running === true ? 'true' : 'false';
  const connected = parsed.connected === true ? 'true' : 'false';
  process.stdout.write(`running=${running} connected=${connected}`);
} catch {
  process.stdout.write('running=unknown connected=unknown');
}
NODE
}

read_service_pid() {
  case "$(platform_name)" in
    linux)
      systemctl --user show -p MainPID --value "$SYSTEMD_UNIT_NAME" 2>/dev/null || echo "unknown"
      ;;
    darwin)
      echo "unknown"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

main() {
  require_supported_platform
  load_env_file
  if [[ "$DETACH" == "true" ]]; then
    launch_detached_restart
    return 0
  fi

  local commit branch now_iso restart_started_ms
  branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  commit="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if [[ "$START_NOTIFY" == "true" ]]; then
    now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local start_msg
    start_msg=$'[bridge] restart started\n'
    start_msg+="time: ${now_iso}"$'\n'
    start_msg+="run_id: ${RUN_ID}"$'\n'
    start_msg+="commit: ${branch}@${commit}"
    echo "$start_msg"
    notify_telegram "$start_msg"
  fi

  if [[ "$BUILD_BEFORE_RESTART" == "true" ]]; then
    echo "Building bridge..."
    (cd "$ROOT_DIR" && npm run build)
  fi

  restart_started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  echo "Restarting service..."
  bash "${SCRIPT_DIR}/restart.sh"

  local deadline epoch_now
  deadline=$(( $(date +%s) + RESTART_TIMEOUT_SEC ))
  while true; do
    if status_is_healthy "$restart_started_ms"; then
      local pid summary
      pid="$(read_service_pid)"
      summary="$(read_status_summary)"
      now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      local success_msg
      success_msg=$'[bridge] restart succeeded\n'
      success_msg+="time: ${now_iso}"$'\n'
      success_msg+="run_id: ${RUN_ID}"$'\n'
      success_msg+="commit: ${branch}@${commit}"$'\n'
      success_msg+="pid: ${pid}"$'\n'
      success_msg+="status: ${summary}"
      echo "$success_msg"
      notify_telegram "$success_msg"
      return 0
    fi
    epoch_now="$(date +%s)"
    if (( epoch_now >= deadline )); then
      break
    fi
    sleep "$RESTART_POLL_SEC"
  done

  now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local failure_msg
  failure_msg=$'[bridge] restart failed\n'
  failure_msg+="time: ${now_iso}"$'\n'
  failure_msg+="run_id: ${RUN_ID}"$'\n'
  failure_msg+="commit: ${branch}@${commit}"$'\n'
  failure_msg+="timeout_sec: ${RESTART_TIMEOUT_SEC}"$'\n'
  failure_msg+="last_status_updated_at: $(read_status_updated_at)"$'\n'
  failure_msg+="status: $(read_status_summary)"
  echo "$failure_msg" >&2
  notify_telegram "$failure_msg"
  exit 1
}

main "$@"
