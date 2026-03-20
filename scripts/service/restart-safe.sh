#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/service/_common.sh
source "${SCRIPT_DIR}/_common.sh"

if [[ "$(platform_name)" == "win32" ]]; then
  exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT_DIR}/restart-safe.ps1"
fi

BUILD_BEFORE_RESTART="${BUILD_BEFORE_RESTART:-true}"
NOTIFY_TELEGRAM="${NOTIFY_TELEGRAM:-true}"
RESTART_TIMEOUT_SEC="${RESTART_TIMEOUT_SEC:-90}"
RESTART_POLL_SEC="${RESTART_POLL_SEC:-2}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
STATUS_FILE="${STATUS_FILE:-${APP_HOME}/runtime/status.json}"
DETACH="${DETACH:-auto}"
START_NOTIFY="${START_NOTIFY:-true}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"
SAFE_RESTART_UNIT_PREFIX="${SAFE_RESTART_UNIT_PREFIX:-${SERVICE_LABEL}.safe-restart}"
NOTIFY_TARGET="${NOTIFY_TARGET:-auto}"
SAFE_RESTART_CGROUP_FILE="${SAFE_RESTART_CGROUP_FILE:-/proc/$$/cgroup}"

latest_notify_scope_cache="__unset__"
latest_notify_locale_cache="__unset__"

normalize_locale_code() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    zh*) printf 'zh' ;;
    fr*) printf 'fr' ;;
    *) printf 'en' ;;
  esac
}

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

function loadDatabaseSync() {
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...args) => {
    const type = typeof warning === 'string'
      ? (typeof args[0] === 'string' ? args[0] : '')
      : warning && warning.name;
    const message = typeof warning === 'string' ? warning : warning && warning.message;
    if (type === 'ExperimentalWarning' && typeof message === 'string' && message.includes('SQLite is an experimental feature')) {
      return;
    }
    return originalEmitWarning(warning, ...args);
  };
  try {
    return require('node:sqlite').DatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

const dbPath = process.argv[2];
if (!dbPath || !fs.existsSync(dbPath)) {
  process.exit(0);
}

try {
  const DatabaseSync = loadDatabaseSync();
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

read_scope_locale() {
  local scope_id="${1:-}"
  local db_path
  db_path="$(default_store_path)"
  if [[ -z "$scope_id" || ! -f "$db_path" ]]; then
    return 0
  fi
  node - "$db_path" "$scope_id" <<'NODE'
const fs = require('node:fs');

function loadDatabaseSync() {
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...args) => {
    const type = typeof warning === 'string'
      ? (typeof args[0] === 'string' ? args[0] : '')
      : warning && warning.name;
    const message = typeof warning === 'string' ? warning : warning && warning.message;
    if (type === 'ExperimentalWarning' && typeof message === 'string' && message.includes('SQLite is an experimental feature')) {
      return;
    }
    return originalEmitWarning(warning, ...args);
  };
  try {
    return require('node:sqlite').DatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

const dbPath = process.argv[2];
const scopeId = process.argv[3];
if (!dbPath || !scopeId || !fs.existsSync(dbPath)) {
  process.exit(0);
}

try {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare(`
    SELECT locale
    FROM chat_settings
    WHERE chat_id = ?
    LIMIT 1
  `).get(scopeId);
  if (row && row.locale !== null && row.locale !== undefined) {
    process.stdout.write(String(row.locale));
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

resolve_notify_locale() {
  if [[ -n "${NOTIFY_LOCALE:-}" ]]; then
    normalize_locale_code "$NOTIFY_LOCALE"
    return
  fi
  if [[ "$latest_notify_locale_cache" == "__unset__" ]]; then
    local scope_id
    scope_id="$(resolve_notify_scope_id)"
    latest_notify_locale_cache="$(read_scope_locale "$scope_id")"
    if [[ -z "$latest_notify_locale_cache" ]]; then
      latest_notify_locale_cache="en"
    fi
  fi
  normalize_locale_code "$latest_notify_locale_cache"
}

message_text() {
  local locale="$1"
  local key="$2"
  case "${locale}:${key}" in
    zh:restart_started) printf '[bridge] 重启已开始' ;;
    zh:restart_succeeded) printf '[bridge] 重启成功' ;;
    zh:restart_failed) printf '[bridge] 重启失败' ;;
    zh:restart_queued_detached) printf '[bridge] 重启已排队（分离执行）' ;;
    zh:detached_unit_launched) printf '已启动分离单元' ;;
    zh:building_bridge) printf '正在构建 bridge...' ;;
    zh:restarting_service) printf '正在重启服务...' ;;
    zh:time_label) printf '时间' ;;
    zh:run_id_label) printf '运行 ID' ;;
    zh:commit_label) printf '提交' ;;
    zh:unit_label) printf '单元' ;;
    zh:pid_label) printf '进程号' ;;
    zh:status_label) printf '状态' ;;
    zh:timeout_label) printf '超时秒数' ;;
    zh:last_status_updated_at_label) printf '最后状态更新时间' ;;
    zh:running_label) printf '运行中' ;;
    zh:connected_label) printf '已连接' ;;
    fr:restart_started) printf '[bridge] redemarrage lance' ;;
    fr:restart_succeeded) printf '[bridge] redemarrage reussi' ;;
    fr:restart_failed) printf '[bridge] redemarrage echoue' ;;
    fr:restart_queued_detached) printf '[bridge] redemarrage mis en file (detache)' ;;
    fr:detached_unit_launched) printf 'Unite detachee lancee' ;;
    fr:building_bridge) printf 'Construction du bridge...' ;;
    fr:restarting_service) printf 'Redemarrage du service...' ;;
    fr:time_label) printf 'heure' ;;
    fr:run_id_label) printf 'run_id' ;;
    fr:commit_label) printf 'commit' ;;
    fr:unit_label) printf 'unite' ;;
    fr:pid_label) printf 'pid' ;;
    fr:status_label) printf 'statut' ;;
    fr:timeout_label) printf 'timeout_sec' ;;
    fr:last_status_updated_at_label) printf 'derniere_mise_a_jour_statut' ;;
    fr:running_label) printf 'actif' ;;
    fr:connected_label) printf 'connecte' ;;
    en:restart_started) printf '[bridge] restart started' ;;
    en:restart_succeeded) printf '[bridge] restart succeeded' ;;
    en:restart_failed) printf '[bridge] restart failed' ;;
    en:restart_queued_detached) printf '[bridge] restart queued (detached)' ;;
    en:detached_unit_launched) printf 'Detached unit launched' ;;
    en:building_bridge) printf 'Building bridge...' ;;
    en:restarting_service) printf 'Restarting service...' ;;
    en:time_label) printf 'time' ;;
    en:run_id_label) printf 'run_id' ;;
    en:commit_label) printf 'commit' ;;
    en:unit_label) printf 'unit' ;;
    en:pid_label) printf 'pid' ;;
    en:status_label) printf 'status' ;;
    en:timeout_label) printf 'timeout_sec' ;;
    en:last_status_updated_at_label) printf 'last_status_updated_at' ;;
    en:running_label) printf 'running' ;;
    en:connected_label) printf 'connected' ;;
    *) printf '%s' "$key" ;;
  esac
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

running_inside_bridge_service_cgroup() {
  if [[ "$(platform_name)" != "linux" ]]; then
    return 1
  fi
  if [[ ! -r "$SAFE_RESTART_CGROUP_FILE" ]]; then
    return 1
  fi
  grep -Fq "/${SYSTEMD_UNIT_NAME}" "$SAFE_RESTART_CGROUP_FILE"
}

should_auto_detach() {
  if [[ "$DETACH" != "auto" ]]; then
    return 1
  fi
  if ! command -v systemd-run >/dev/null 2>&1; then
    return 1
  fi
  running_inside_bridge_service_cgroup
}

emit_restart_started() {
  local branch="$1"
  local commit="$2"
  local locale="$3"
  local now_iso start_msg
  now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  start_msg="$(message_text "$locale" restart_started)"$'\n'
  start_msg+="$(message_text "$locale" time_label): ${now_iso}"$'\n'
  start_msg+="$(message_text "$locale" run_id_label): ${RUN_ID}"$'\n'
  start_msg+="$(message_text "$locale" commit_label): ${branch}@${commit}"
  echo "$start_msg"
  notify_telegram "$start_msg"
}

run_id_for_unit() {
  printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9.-]/-/g'
}

launch_detached_restart() {
  local child_start_notify="${1:-true}"
  local announce_detached="${2:-true}"
  if [[ "$(platform_name)" != "linux" ]]; then
    echo "DETACH=true currently requires Linux systemd user services." >&2
    exit 1
  fi
  require_systemctl
  if ! command -v systemd-run >/dev/null 2>&1; then
    echo "systemd-run not found; cannot launch detached restart." >&2
    exit 1
  fi

  local unit_name now_iso queued_msg notify_scope_id notify_chat_id notify_topic_id notify_locale
  unit_name="${SAFE_RESTART_UNIT_PREFIX}-$(run_id_for_unit)"
  notify_scope_id="$(resolve_notify_scope_id)"
  notify_chat_id="$(resolve_notify_chat_id)"
  notify_topic_id="$(resolve_notify_topic_id)"
  notify_locale="$(resolve_notify_locale)"
  if [[ "$announce_detached" == "true" ]]; then
    now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    queued_msg="$(message_text "$notify_locale" restart_queued_detached)"$'\n'
    queued_msg+="$(message_text "$notify_locale" time_label): ${now_iso}"$'\n'
    queued_msg+="$(message_text "$notify_locale" run_id_label): ${RUN_ID}"$'\n'
    queued_msg+="$(message_text "$notify_locale" unit_label): ${unit_name}"
    echo "$queued_msg"
    notify_telegram "$queued_msg"
  fi

  systemd-run --user --unit "$unit_name" --collect --quiet \
    --setenv=DETACH=false \
    --setenv=RUN_ID="$RUN_ID" \
    --setenv=BUILD_BEFORE_RESTART="$BUILD_BEFORE_RESTART" \
    --setenv=NOTIFY_TELEGRAM="$NOTIFY_TELEGRAM" \
    --setenv=START_NOTIFY="$child_start_notify" \
    --setenv=RESTART_TIMEOUT_SEC="$RESTART_TIMEOUT_SEC" \
    --setenv=RESTART_POLL_SEC="$RESTART_POLL_SEC" \
    --setenv=ENV_FILE="$ENV_FILE" \
    --setenv=STATUS_FILE="$STATUS_FILE" \
    --setenv=NOTIFY_TARGET="$NOTIFY_TARGET" \
    --setenv=NOTIFY_SCOPE_ID="$notify_scope_id" \
    --setenv=NOTIFY_LOCALE="$notify_locale" \
    --setenv=NOTIFY_BOT_TOKEN="${NOTIFY_BOT_TOKEN:-}" \
    --setenv=NOTIFY_CHAT_ID="${NOTIFY_CHAT_ID:-$notify_chat_id}" \
    --setenv=NOTIFY_TOPIC_ID="${NOTIFY_TOPIC_ID:-$notify_topic_id}" \
    /bin/bash "${SCRIPT_DIR}/restart-safe.sh"

  echo "$(message_text "$notify_locale" detached_unit_launched): ${unit_name}"
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
  local locale="${1:-en}"
  local running_label connected_label
  running_label="$(message_text "$locale" running_label)"
  connected_label="$(message_text "$locale" connected_label)"
  node - "$STATUS_FILE" "$running_label" "$connected_label" <<'NODE'
const fs = require('node:fs');
const statusPath = process.argv[2];
const runningLabel = process.argv[3] || 'running';
const connectedLabel = process.argv[4] || 'connected';
try {
  const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const running = parsed.running === true ? 'true' : 'false';
  const connected = parsed.connected === true ? 'true' : 'false';
  process.stdout.write(`${runningLabel}=${running} ${connectedLabel}=${connected}`);
} catch {
  process.stdout.write(`${runningLabel}=unknown ${connectedLabel}=unknown`);
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

  local commit branch now_iso restart_started_ms locale
  branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  commit="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  locale="$(resolve_notify_locale)"
  if should_auto_detach; then
    if [[ "$START_NOTIFY" == "true" ]]; then
      emit_restart_started "$branch" "$commit" "$locale"
    fi
    launch_detached_restart false false
    return 0
  fi
  if [[ "$DETACH" == "true" ]]; then
    launch_detached_restart true true
    return 0
  fi
  if [[ "$START_NOTIFY" == "true" ]]; then
    emit_restart_started "$branch" "$commit" "$locale"
  fi

  if [[ "$BUILD_BEFORE_RESTART" == "true" ]]; then
    echo "$(message_text "$locale" building_bridge)"
    (cd "$ROOT_DIR" && npm run build)
  fi

  restart_started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  echo "$(message_text "$locale" restarting_service)"
  bash "${SCRIPT_DIR}/restart.sh"

  local deadline epoch_now
  deadline=$(( $(date +%s) + RESTART_TIMEOUT_SEC ))
  while true; do
    if status_is_healthy "$restart_started_ms"; then
      local pid summary
      pid="$(read_service_pid)"
      summary="$(read_status_summary "$locale")"
      now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      local success_msg
      success_msg="$(message_text "$locale" restart_succeeded)"$'\n'
      success_msg+="$(message_text "$locale" time_label): ${now_iso}"$'\n'
      success_msg+="$(message_text "$locale" run_id_label): ${RUN_ID}"$'\n'
      success_msg+="$(message_text "$locale" commit_label): ${branch}@${commit}"$'\n'
      success_msg+="$(message_text "$locale" pid_label): ${pid}"$'\n'
      success_msg+="$(message_text "$locale" status_label): ${summary}"
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
  failure_msg="$(message_text "$locale" restart_failed)"$'\n'
  failure_msg+="$(message_text "$locale" time_label): ${now_iso}"$'\n'
  failure_msg+="$(message_text "$locale" run_id_label): ${RUN_ID}"$'\n'
  failure_msg+="$(message_text "$locale" commit_label): ${branch}@${commit}"$'\n'
  failure_msg+="$(message_text "$locale" timeout_label): ${RESTART_TIMEOUT_SEC}"$'\n'
  failure_msg+="$(message_text "$locale" last_status_updated_at_label): $(read_status_updated_at)"$'\n'
  failure_msg+="$(message_text "$locale" status_label): $(read_status_summary "$locale")"
  echo "$failure_msg" >&2
  notify_telegram "$failure_msg"
  exit 1
}

main "$@"
