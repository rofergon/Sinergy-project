#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.tmp/cloudflare-tunnel}"
CONTAINER_NAME="${CONTAINER_NAME:-sinergy-cloudflare-tunnel}"
CLOUDFLARED_IMAGE="${CLOUDFLARED_IMAGE:-cloudflare/cloudflared:latest}"
QUICK_LOG="$RUNTIME_DIR/quick.log"
QUICK_ENV="$RUNTIME_DIR/quick.env"
LOCAL_HTTP_PORT="${LOCAL_HTTP_PORT:-8080}"
TUNNEL_BUILD_FRONTENDS="${TUNNEL_BUILD_FRONTENDS:-0}"

mkdir -p "$RUNTIME_DIR"

log() {
  printf '[cloudflare-tunnel] %s\n' "$*"
}

has_exact_line() {
  local needle="$1"

  if command -v rg >/dev/null 2>&1; then
    rg -qx "$needle"
  else
    grep -Fxq "$needle"
  fi
}

resolve_upstream_host() {
  if [[ -n "${UPSTREAM_HOST:-}" ]]; then
    printf '%s\n' "$UPSTREAM_HOST"
    return 0
  fi

  ip route get 1.1.1.1 | awk '/src/ { for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'
}

ensure_proxy() {
  HTTP_PORT="$LOCAL_HTTP_PORT" BUILD_FRONTENDS="$TUNNEL_BUILD_FRONTENDS" "$ROOT_DIR/scripts/public-nginx.sh" start >/dev/null
}

stop_container() {
  if docker ps -a --format '{{.Names}}' | has_exact_line "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
}

extract_quick_url() {
  if command -v rg >/dev/null 2>&1; then
    rg -o "https://[-a-z0-9]+\\.trycloudflare\\.com" "$QUICK_LOG" | tail -n 1
  else
    grep -Eo "https://[-a-z0-9]+\\.trycloudflare\\.com" "$QUICK_LOG" | tail -n 1
  fi
}

write_quick_env() {
  local base_url="$1"
  local ws_url
  ws_url="$(printf '%s' "$base_url" | sed -e 's#^https://#wss://#' -e 's#^http://#ws://#')/ws"

  cat >"$QUICK_ENV" <<EOF
QUICK_TUNNEL_BASE_URL=$base_url
QUICK_TUNNEL_APP_URL=$base_url
QUICK_TUNNEL_API_URL=$base_url/api
QUICK_TUNNEL_RPC_URL=$base_url/rpc
QUICK_TUNNEL_REST_URL=$base_url/rest
QUICK_TUNNEL_TM_URL=$base_url/tm
QUICK_TUNNEL_INDEXER_URL=$base_url/indexer
QUICK_TUNNEL_WS_URL=$ws_url
EOF
}

start_quick_tunnel() {
  local upstream_host
  upstream_host="$(resolve_upstream_host)"
  ensure_proxy
  stop_container
  rm -f "$QUICK_LOG" "$QUICK_ENV"

  log "starting quick tunnel to http://$upstream_host:$LOCAL_HTTP_PORT"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    "$CLOUDFLARED_IMAGE" \
    tunnel --no-autoupdate --url "http://$upstream_host:$LOCAL_HTTP_PORT" > /dev/null

  for _ in $(seq 1 30); do
    docker logs "$CONTAINER_NAME" >"$QUICK_LOG" 2>&1 || true
    local url
    url="$(extract_quick_url || true)"
    if [[ -n "$url" ]]; then
      local ws_url
      ws_url="$(printf '%s' "$url" | sed -e 's#^https://#wss://#' -e 's#^http://#ws://#')/ws"
      write_quick_env "$url"
      log "quick tunnel ready"
      printf '  app:  %s\n' "$url"
      printf '  api:  %s/api\n' "$url"
      printf '  rpc:  %s/rpc\n' "$url"
      printf '  rest: %s/rest\n' "$url"
      printf '  tm:   %s/tm\n' "$url"
      printf '  ws:   %s\n' "$ws_url"
      return 0
    fi
    sleep 1
  done

  echo "Cloudflare quick tunnel URL was not detected in time." >&2
  docker logs "$CONTAINER_NAME" >&2 || true
  exit 1
}

start_named_tunnel() {
  local upstream_host
  upstream_host="$(resolve_upstream_host)"

  if [[ -z "${CF_TUNNEL_TOKEN:-}" ]]; then
    echo "Set CF_TUNNEL_TOKEN to run a named Cloudflare Tunnel." >&2
    exit 1
  fi

  ensure_proxy
  stop_container

  log "starting named tunnel container"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    "$CLOUDFLARED_IMAGE" \
    tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" >/dev/null

  cat <<EOF
Named tunnel started.
Origin expected by this machine: http://$upstream_host:$LOCAL_HTTP_PORT
Configure public hostnames in Cloudflare to point to:
  app      -> http://$upstream_host:$LOCAL_HTTP_PORT
  bridge   -> http://$upstream_host:$LOCAL_HTTP_PORT
  api      -> http://$upstream_host:$LOCAL_HTTP_PORT
  rpc      -> http://$upstream_host:$LOCAL_HTTP_PORT
  ws       -> http://$upstream_host:$LOCAL_HTTP_PORT
  rest     -> http://$upstream_host:$LOCAL_HTTP_PORT
  tm       -> http://$upstream_host:$LOCAL_HTTP_PORT
  indexer  -> http://$upstream_host:$LOCAL_HTTP_PORT
EOF
}

print_status() {
  printf 'container: %s\n' "$(docker ps --format '{{.Names}}' | has_exact_line "$CONTAINER_NAME" && echo active || echo inactive)"
  if [[ -f "$QUICK_ENV" ]]; then
    cat "$QUICK_ENV"
  fi
}

main() {
  local action="${1:-quick}"

  case "$action" in
    quick)
      start_quick_tunnel
      ;;
    named)
      start_named_tunnel
      ;;
    status)
      print_status
      ;;
    stop)
      stop_container
      ;;
    *)
      echo "Usage: $0 [quick|named|status|stop]" >&2
      exit 1
      ;;
  esac
}

main "$@"
