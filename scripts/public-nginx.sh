#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.tmp/public-nginx}"
CONF_DIR="$RUNTIME_DIR/conf.d"
WEBROOT_DIR="$RUNTIME_DIR/www/certbot"
LETSENCRYPT_DIR="$RUNTIME_DIR/letsencrypt"
CONTAINER_NAME="${CONTAINER_NAME:-sinergy-public-nginx}"
CERT_NAME="${CERT_NAME:-sinergy-public}"
NGINX_IMAGE="${NGINX_IMAGE:-nginx:1.27-alpine}"
HTTP_PORT="${HTTP_PORT:-8080}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
BUILD_FRONTENDS="${BUILD_FRONTENDS:-1}"

mkdir -p "$CONF_DIR" "$WEBROOT_DIR" "$LETSENCRYPT_DIR"

log() {
  printf '[public-nginx] %s\n' "$*"
}

has_exact_line() {
  local needle="$1"

  if command -v rg >/dev/null 2>&1; then
    rg -qx "$needle"
  else
    grep -Fxq "$needle"
  fi
}

resolve_public_root_domain() {
  if [[ -n "${PUBLIC_ROOT_DOMAIN:-}" ]]; then
    printf '%s\n' "$PUBLIC_ROOT_DOMAIN"
    return 0
  fi

  local public_ip
  public_ip="$(curl -4 -fsS https://ifconfig.me 2>/dev/null || true)"
  if [[ -z "$public_ip" ]]; then
    echo "Unable to resolve public IP. Set PUBLIC_ROOT_DOMAIN manually." >&2
    exit 1
  fi

  printf '%s\n' "${public_ip}.sslip.io"
}

resolve_upstream_host() {
  if [[ -n "${UPSTREAM_HOST:-}" ]]; then
    printf '%s\n' "$UPSTREAM_HOST"
    return 0
  fi

  ip route get 1.1.1.1 | awk '/src/ { for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'
}

resolve_hosts() {
  local root_domain
  root_domain="$(resolve_public_root_domain)"
  UPSTREAM_HOST="$(resolve_upstream_host)"

  APP_HOST="${APP_HOST:-app.$root_domain}"
  BRIDGE_HOST="${BRIDGE_HOST:-bridge.$root_domain}"
  API_HOST="${API_HOST:-api.$root_domain}"
  RPC_HOST="${RPC_HOST:-rpc.$root_domain}"
  WS_HOST="${WS_HOST:-ws.$root_domain}"
  REST_HOST="${REST_HOST:-rest.$root_domain}"
  TM_HOST="${TM_HOST:-tm.$root_domain}"
  INDEXER_HOST="${INDEXER_HOST:-indexer.$root_domain}"
}

render_template() {
  local template_path="$1"
  local output_path="$2"

  sed \
    -e "s|__APP_HOST__|$APP_HOST|g" \
    -e "s|__BRIDGE_HOST__|$BRIDGE_HOST|g" \
    -e "s|__API_HOST__|$API_HOST|g" \
    -e "s|__RPC_HOST__|$RPC_HOST|g" \
    -e "s|__WS_HOST__|$WS_HOST|g" \
    -e "s|__REST_HOST__|$REST_HOST|g" \
    -e "s|__TM_HOST__|$TM_HOST|g" \
    -e "s|__INDEXER_HOST__|$INDEXER_HOST|g" \
    -e "s|__UPSTREAM_HOST__|$UPSTREAM_HOST|g" \
    -e "s|__CERT_NAME__|$CERT_NAME|g" \
    "$template_path" >"$output_path"
}

cert_available() {
  [[ -f "$LETSENCRYPT_DIR/live/$CERT_NAME/fullchain.pem" ]] &&
    [[ -f "$LETSENCRYPT_DIR/live/$CERT_NAME/privkey.pem" ]]
}

choose_template() {
  local requested_mode="${TLS_MODE:-auto}"

  case "$requested_mode" in
    auto)
      if cert_available; then
        printf '%s\n' "$ROOT_DIR/infra/nginx/sinergy-https.conf.template"
      else
        printf '%s\n' "$ROOT_DIR/infra/nginx/sinergy-http.conf.template"
      fi
      ;;
    http)
      printf '%s\n' "$ROOT_DIR/infra/nginx/sinergy-http.conf.template"
      ;;
    https)
      if ! cert_available; then
        echo "TLS_MODE=https but no certificate was found in $LETSENCRYPT_DIR/live/$CERT_NAME" >&2
        exit 1
      fi
      printf '%s\n' "$ROOT_DIR/infra/nginx/sinergy-https.conf.template"
      ;;
    *)
      echo "Unsupported TLS_MODE=$requested_mode. Use auto, http, or https." >&2
      exit 1
      ;;
  esac
}

build_frontends() {
  if [[ "$BUILD_FRONTENDS" != "1" ]]; then
    return 0
  fi

  log "building static testnet frontends"
  npm run build:testnet -w @sinergy/web >/dev/null
  npm run build:testnet -w @sinergy/bridge >/dev/null
}

start_proxy() {
  resolve_hosts

  local template_path="$1"
  local conf_path="$CONF_DIR/default.conf"
  build_frontends
  render_template "$template_path" "$conf_path"

  if docker ps -a --format '{{.Names}}' | has_exact_line "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi

  log "starting nginx container"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p "${HTTP_PORT}:80" \
    -p "${HTTPS_PORT}:443" \
    -v "$conf_path:/etc/nginx/conf.d/default.conf:ro" \
    -v "$ROOT_DIR/apps/web/dist:/srv/web:ro" \
    -v "$ROOT_DIR/apps/bridge/dist:/srv/bridge:ro" \
    -v "$WEBROOT_DIR:/var/www/certbot" \
    -v "$LETSENCRYPT_DIR:/etc/letsencrypt:ro" \
    "$NGINX_IMAGE" >/dev/null

  log "public hosts"
  printf '  local http port:  %s\n' "$HTTP_PORT"
  printf '  local https port: %s\n' "$HTTPS_PORT"
  printf '  app:     http%s://%s\n' "$(cert_available && printf s || true)" "$APP_HOST"
  printf '  bridge:  http%s://%s\n' "$(cert_available && printf s || true)" "$BRIDGE_HOST"
  printf '  api:     http%s://%s\n' "$(cert_available && printf s || true)" "$API_HOST"
  printf '  rpc:     http%s://%s\n' "$(cert_available && printf s || true)" "$RPC_HOST"
  printf '  ws:      ws%s://%s\n' "$(cert_available && printf s || true)" "$WS_HOST"
  printf '  rest:    http%s://%s\n' "$(cert_available && printf s || true)" "$REST_HOST"
  printf '  tm:      http%s://%s\n' "$(cert_available && printf s || true)" "$TM_HOST"
  printf '  indexer: http%s://%s\n' "$(cert_available && printf s || true)" "$INDEXER_HOST"
}

print_status() {
  resolve_hosts

  printf 'container: %s\n' "$(docker ps --format '{{.Names}}' | has_exact_line "$CONTAINER_NAME" && echo active || echo inactive)"
  printf 'mode:      %s\n' "$(cert_available && echo https || echo http)"
  printf 'http port: %s\n' "$HTTP_PORT"
  printf 'https port:%s\n' "$HTTPS_PORT"
  printf 'upstream:  %s\n' "$UPSTREAM_HOST"
  printf 'app:       %s\n' "$APP_HOST"
  printf 'bridge:    %s\n' "$BRIDGE_HOST"
  printf 'api:       %s\n' "$API_HOST"
  printf 'rpc:       %s\n' "$RPC_HOST"
  printf 'ws:        %s\n' "$WS_HOST"
  printf 'rest:      %s\n' "$REST_HOST"
  printf 'tm:        %s\n' "$TM_HOST"
  printf 'indexer:   %s\n' "$INDEXER_HOST"
}

stop_proxy() {
  if docker ps -a --format '{{.Names}}' | has_exact_line "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
    log "stopped $CONTAINER_NAME"
  else
    log "container $CONTAINER_NAME is not running"
  fi
}

print_env() {
  resolve_hosts

  cat <<EOF
PUBLIC_ROOT_DOMAIN=$(resolve_public_root_domain)
UPSTREAM_HOST=$UPSTREAM_HOST
APP_HOST=$APP_HOST
BRIDGE_HOST=$BRIDGE_HOST
API_HOST=$API_HOST
RPC_HOST=$RPC_HOST
WS_HOST=$WS_HOST
REST_HOST=$REST_HOST
TM_HOST=$TM_HOST
INDEXER_HOST=$INDEXER_HOST
EOF
}

main() {
  local action="${1:-start}"
  local template_path

  case "$action" in
    start)
      template_path="$(choose_template)"
      start_proxy "$template_path"
      ;;
    status)
      print_status
      ;;
    stop)
      stop_proxy
      ;;
    print-env)
      print_env
      ;;
    *)
      echo "Usage: $0 [start|status|stop|print-env]" >&2
      exit 1
      ;;
  esac
}

main "$@"
