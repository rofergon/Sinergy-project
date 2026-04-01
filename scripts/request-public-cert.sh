#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/.tmp/public-nginx}"
WEBROOT_DIR="$RUNTIME_DIR/www/certbot"
LETSENCRYPT_DIR="$RUNTIME_DIR/letsencrypt"
CERT_NAME="${CERT_NAME:-sinergy-public}"
CERTBOT_IMAGE="${CERTBOT_IMAGE:-certbot/certbot:v3.2.0}"

if [[ -z "${LETSENCRYPT_EMAIL:-}" ]]; then
  echo "Set LETSENCRYPT_EMAIL before requesting a certificate." >&2
  exit 1
fi

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

ROOT_DOMAIN="$(resolve_public_root_domain)"
APP_HOST="${APP_HOST:-app.$ROOT_DOMAIN}"
BRIDGE_HOST="${BRIDGE_HOST:-bridge.$ROOT_DOMAIN}"
API_HOST="${API_HOST:-api.$ROOT_DOMAIN}"
RPC_HOST="${RPC_HOST:-rpc.$ROOT_DOMAIN}"
WS_HOST="${WS_HOST:-ws.$ROOT_DOMAIN}"
REST_HOST="${REST_HOST:-rest.$ROOT_DOMAIN}"
TM_HOST="${TM_HOST:-tm.$ROOT_DOMAIN}"
INDEXER_HOST="${INDEXER_HOST:-indexer.$ROOT_DOMAIN}"

mkdir -p "$WEBROOT_DIR" "$LETSENCRYPT_DIR"

TLS_MODE=http "$ROOT_DIR/scripts/public-nginx.sh" start >/dev/null

STAGING_ARGS=()
if [[ "${LETSENCRYPT_STAGING:-0}" == "1" ]]; then
  STAGING_ARGS+=(--staging)
fi

docker run --rm \
  -v "$LETSENCRYPT_DIR:/etc/letsencrypt" \
  -v "$WEBROOT_DIR:/var/www/certbot" \
  "$CERTBOT_IMAGE" certonly \
  --webroot \
  -w /var/www/certbot \
  --agree-tos \
  --no-eff-email \
  --email "$LETSENCRYPT_EMAIL" \
  --cert-name "$CERT_NAME" \
  "${STAGING_ARGS[@]}" \
  -d "$APP_HOST" \
  -d "$BRIDGE_HOST" \
  -d "$API_HOST" \
  -d "$RPC_HOST" \
  -d "$WS_HOST" \
  -d "$REST_HOST" \
  -d "$TM_HOST" \
  -d "$INDEXER_HOST"

"$ROOT_DIR/scripts/public-nginx.sh" start >/dev/null
echo "Certificate issued for $CERT_NAME and nginx was restarted in HTTPS mode."
