#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.tmp/testnet-runtime}"

START_FRONTENDS="${START_FRONTENDS:-1}"
START_STRATEGY_AGENT="${START_STRATEGY_AGENT:-1}"
WEB_HOST="${WEB_HOST:-0.0.0.0}"
BRIDGE_HOST="${BRIDGE_HOST:-0.0.0.0}"

ROLLUP_RPC_URL="${ROLLUP_RPC_URL:-http://127.0.0.1:26657/status}"
EXECUTOR_STATUS_URL="${EXECUTOR_STATUS_URL:-http://127.0.0.1:3000/status}"
MATCHER_HEALTH_URL="${MATCHER_HEALTH_URL:-http://127.0.0.1:8787/health}"
STRATEGY_AGENT_URL="${STRATEGY_AGENT_URL:-http://127.0.0.1:8790/agent/capabilities}"
WEB_URL="${WEB_URL:-http://127.0.0.1:5173}"
BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:5174}"

mkdir -p "$RUNTIME_DIR"

log() {
  printf '[testnet-stack] %s\n' "$*"
}

has_exact_line() {
  local needle="$1"

  if command -v rg >/dev/null 2>&1; then
    rg -qx "$needle"
  else
    grep -Fxq "$needle"
  fi
}

is_http_ready() {
  local url="$1"
  curl -fsS "$url" >/dev/null 2>&1
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-30}"
  local sleep_seconds="${4:-1}"

  for ((i = 1; i <= attempts; i++)); do
    if is_http_ready "$url"; then
      log "$label ready at $url"
      return 0
    fi
    sleep "$sleep_seconds"
  done

  log "warning: $label did not become ready at $url"
  return 1
}

is_port_listening() {
  local port="$1"
  ss -ltn "( sport = :$port )" | grep -q ":$port"
}

ensure_matcher_service() {
  local unit_dir="${HOME}/.config/systemd/user"
  local unit_file="${unit_dir}/sinergy-matcher.service"
  mkdir -p "$unit_dir"

  cat >"$unit_file" <<EOF
[Unit]
Description=Sinergy matcher
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR/services/matcher
ExecStart=/bin/bash -lc 'set -a && if [ -f ./.env.testnet ]; then . ./.env.testnet; fi && set +a && exec node --import tsx src/index.ts'
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
}

start_rollup() {
  if systemctl --user is-active --quiet minitiad.service; then
    log "rollup service already active"
  else
    log "starting rollup service"
    weave rollup start --detach
  fi

  wait_for_http "$ROLLUP_RPC_URL" "rollup rpc"
}

start_executor() {
  if systemctl --user is-active --quiet opinitd.executor.service; then
    log "executor service already active"
  else
    log "starting executor service"
    weave opinit restart executor >/dev/null 2>&1 || weave opinit start executor --detach
  fi

  wait_for_http "$EXECUTOR_STATUS_URL" "executor status" || true
}

start_relayer() {
  if docker ps --format '{{.Names}}' | has_exact_line 'weave-relayer'; then
    log "relayer container already active"
    return 0
  fi

  if docker ps -a --format '{{.Names}}' | has_exact_line 'weave-relayer'; then
    log "starting existing relayer container"
    docker start weave-relayer >/dev/null
  else
    log "starting relayer via weave"
    weave relayer start --detach
  fi
}

start_background_process() {
  local name="$1"
  local port="$2"
  local command="$3"
  local log_file="$RUNTIME_DIR/${name}.log"
  local pid_file="$RUNTIME_DIR/${name}.pid"

  if is_port_listening "$port"; then
    log "$name already listening on :$port"
    return 0
  fi

  if [[ -f "$pid_file" ]]; then
    local existing_pid
    existing_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      log "$name process already running with pid $existing_pid"
      return 0
    fi
    rm -f "$pid_file"
  fi

  log "starting $name"
  nohup bash -lc "$command" </dev/null >"$log_file" 2>&1 &
  echo "$!" >"$pid_file"
}

start_matcher() {
  ensure_matcher_service

  if systemctl --user is-active --quiet sinergy-matcher.service; then
    log "matcher service already active"
  else
    log "starting matcher service"
    systemctl --user restart sinergy-matcher.service
  fi

  wait_for_http "$MATCHER_HEALTH_URL" "matcher health"
}

start_strategy_agent() {
  start_background_process \
    "strategy-agent" \
    "8790" \
    "cd '$ROOT_DIR/services/strategy-agent' && npm run dev"

  wait_for_http "$STRATEGY_AGENT_URL" "strategy agent" 30 1 || true
}

start_web() {
  start_background_process \
    "web" \
    "5173" \
    "cd '$ROOT_DIR' && HOST='$WEB_HOST' npm run dev:web:testnet"

  wait_for_http "$WEB_URL" "web app" 30 1 || true
}

start_bridge() {
  start_background_process \
    "bridge" \
    "5174" \
    "cd '$ROOT_DIR' && HOST='$BRIDGE_HOST' npm run dev:bridge:testnet"

  wait_for_http "$BRIDGE_URL" "bridge app" 30 1 || true
}

print_status() {
  log "service summary"
  printf '  rollup:   %s\n' "$(systemctl --user is-active minitiad.service 2>/dev/null || echo inactive)"
  printf '  executor: %s\n' "$(systemctl --user is-active opinitd.executor.service 2>/dev/null || echo inactive)"
  printf '  relayer:  %s\n' "$(docker ps --format '{{.Names}}' | has_exact_line 'weave-relayer' && echo active || echo inactive)"
  printf '  matcher:  %s\n' "$(systemctl --user is-active sinergy-matcher.service 2>/dev/null || echo inactive) / $(is_http_ready "$MATCHER_HEALTH_URL" && echo ready || echo unavailable)"
  printf '  agent:    %s\n' "$(is_http_ready "$STRATEGY_AGENT_URL" && echo ready || echo unavailable)"
  printf '  web:      %s\n' "$(is_http_ready "$WEB_URL" && echo ready || echo unavailable)"
  printf '  bridge:   %s\n' "$(is_http_ready "$BRIDGE_URL" && echo ready || echo unavailable)"
}

main() {
  local action="${1:-start}"

  case "$action" in
    start)
      start_rollup
      start_executor
      start_relayer
      start_matcher
      if [[ "$START_STRATEGY_AGENT" == "1" ]]; then
        start_strategy_agent
      fi
      if [[ "$START_FRONTENDS" == "1" ]]; then
        start_web
        start_bridge
      fi
      print_status
      ;;
    status)
      print_status
      ;;
    *)
      echo "Usage: $0 [start|status]" >&2
      exit 1
      ;;
  esac
}

main "$@"
