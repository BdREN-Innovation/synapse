#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=${SYNAPSE_ROOT:-/opt/synapse}
CONFIG_DIR="$ROOT_DIR/config"
SHARED_DIR="$ROOT_DIR/shared"
STATE_DIR="$ROOT_DIR/state"
RELEASE_DIR="$ROOT_DIR/releases"
ENV_FILE="$SHARED_DIR/.env"
STATE_FILE="$STATE_DIR/release.env"
LOCK_FILE="$STATE_DIR/deploy.lock"
COMPOSE=(docker compose --env-file "$ENV_FILE")

log() { printf '[synapse] %s\n' "$*"; }
die() { printf '[synapse] ERROR: %s\n' "$*" >&2; exit 1; }

require_root() { [[ ${EUID:-$(id -u)} -eq 0 ]] || die 'run as root'; }
require_tools() { command -v docker >/dev/null || die 'docker is required'; command -v curl >/dev/null || die 'curl is required'; command -v flock >/dev/null || die 'flock is required'; }
validate_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "invalid commit SHA: $1"; }

state_get() {
  local key=$1 default=${2:-}
  [[ -f "$STATE_FILE" ]] || { printf '%s' "$default"; return; }
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0,"=")+1); exit }' "$STATE_FILE"
}

write_state() {
  local active_slot=$1 current_sha=$2 previous_slot=$3 previous_sha=$4 outcome=$5
  mkdir -p "$STATE_DIR"
  local tmp
  tmp=$(mktemp "$STATE_DIR/release.XXXXXX")
  cat >"$tmp" <<EOF
ACTIVE_SLOT=$active_slot
CURRENT_SHA=$current_sha
PREVIOUS_SLOT=$previous_slot
PREVIOUS_SHA=$previous_sha
LAST_OUTCOME=$outcome
UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 600 "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

env_get() {
  local key=$1
  [[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

slot_port() { [[ "$1" == blue ]] && printf '3081' || printf '3082'; }
slot_project() { printf 'synapse-app-%s' "$1"; }

render_slot_compose() {
  local image=$1 slot=$2 port=$3 output=$4
  sed -e "s|__APP_IMAGE__|$image|g" -e "s|__APP_SLOT__|$slot|g" -e "s|__APP_PORT__|$port|g" \
    "$CONFIG_DIR/slot.yml" >"$output"
}

render_caddy() {
  local upstream=$1 output=$CONFIG_DIR/Caddyfile
  local app_domain admin_domain caddy_email
  app_domain=$(env_get APP_DOMAIN)
  admin_domain=$(env_get ADMIN_DOMAIN)
  caddy_email=$(env_get CADDY_EMAIL || true)
  caddy_email=${caddy_email:-admin@$app_domain}
  [[ "$app_domain" =~ ^[A-Za-z0-9.-]+$ ]] || die 'APP_DOMAIN contains invalid characters'
  [[ "$admin_domain" =~ ^[A-Za-z0-9.-]+$ ]] || die 'ADMIN_DOMAIN contains invalid characters'
  [[ "$upstream" =~ ^[A-Za-z0-9_.:-]+$ ]] || die 'invalid Caddy upstream'
  sed -e "s|__APP_DOMAIN__|$app_domain|g" -e "s|__ADMIN_DOMAIN__|$admin_domain|g" \
    -e "s|__ACTIVE_UPSTREAM__|$upstream|g" -e "s|__CADDY_EMAIL__|$caddy_email|g" \
    "$CONFIG_DIR/Caddyfile.tmpl" >"$output"
}

reload_caddy() {
  docker exec synapse-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || die 'Caddy configuration validation failed'
  docker exec synapse-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || die 'Caddy reload failed'
}

wait_ready() {
  local container=$1 port=$2
  local i status
  for i in $(seq 1 90); do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)
    if [[ "$status" == healthy ]] && curl -fsS --max-time 3 "http://127.0.0.1:$port/readyz" >/dev/null; then return 0; fi
    [[ "$status" == exited || "$status" == dead ]] && break
    sleep 2
  done
  docker logs --tail 120 "$container" >&2 || true
  return 1
}

public_smoke() {
  local domain
  domain=$(env_get APP_DOMAIN)
  [[ ${SKIP_PUBLIC_SMOKE:-false} == true ]] && return 0
  curl -fsS --retry 3 --retry-delay 2 --max-time 20 "https://$domain/readyz" >/dev/null
}
