#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

require_root
require_tools
[[ -f "$ENV_FILE" ]] || die "create $ENV_FILE from deploy/server.env.example first"
[[ -f "$CONFIG_DIR/shared.yml" && -f "$CONFIG_DIR/slot.yml" && -f "$CONFIG_DIR/Caddyfile.tmpl" ]] || die 'deployment config is not installed; run bootstrap.sh'

sha=${1:-}
validate_sha "$sha"
image="synapse-api:$sha"
docker image inspect "$image" >/dev/null 2>&1 || die "image $image is not present on this server"

exec 9>"$LOCK_FILE"
flock -n 9 || die 'another deployment or rollback is running'

mkdir -p "$RELEASE_DIR" "$STATE_DIR"
"${COMPOSE[@]}" -f "$CONFIG_DIR/shared.yml" -p synapse up -d

current_slot=$(state_get ACTIVE_SLOT none)
current_sha=$(state_get CURRENT_SHA '')
previous_slot=$current_slot
previous_sha=$current_sha
if [[ "$current_slot" == blue ]]; then new_slot=green; else new_slot=blue; fi
new_port=$(slot_port "$new_slot")
project=$(slot_project "$new_slot")
release_path="$RELEASE_DIR/${sha}-${new_slot}"
mkdir -p "$release_path"
render_slot_compose "$image" "$new_slot" "$new_port" "$release_path/compose.yml"

log "starting $sha in $new_slot on 127.0.0.1:$new_port"
docker compose --env-file "$ENV_FILE" -f "$release_path/compose.yml" -p "$project" down --remove-orphans >/dev/null 2>&1 || true
docker compose --env-file "$ENV_FILE" -f "$release_path/compose.yml" -p "$project" up -d
container="synapse-app-$new_slot"
if ! wait_ready "$container" "$new_port"; then
  docker compose --env-file "$ENV_FILE" -f "$release_path/compose.yml" -p "$project" down || true
  write_state "$current_slot" "$current_sha" "$previous_slot" "$previous_sha" failed-readiness
  die "new $new_slot slot did not become ready"
fi

actual_sha=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" | awk -F= '$1 == "BUILD_COMMIT" { print $2; exit }')
if [[ "$actual_sha" != "$sha" ]]; then
  docker compose --env-file "$ENV_FILE" -f "$release_path/compose.yml" -p "$project" down || true
  write_state "$current_slot" "$current_sha" "$previous_slot" "$previous_sha" failed-metadata
  die "container metadata is $actual_sha, expected $sha"
fi

render_caddy "host.docker.internal:$new_port"
if ! reload_caddy; then
  [[ "$current_slot" == blue || "$current_slot" == green ]] && { render_caddy "host.docker.internal:$(slot_port "$current_slot")"; reload_caddy || true; }
  docker compose --env-file "$ENV_FILE" -f "$release_path/compose.yml" -p "$project" down || true
  write_state "$current_slot" "$current_sha" "$previous_slot" "$previous_sha" failed-proxy
  exit 1
fi

if ! public_smoke; then
  log 'public smoke failed; restoring previous upstream'
  if [[ "$current_slot" == blue || "$current_slot" == green ]]; then
    render_caddy "host.docker.internal:$(slot_port "$current_slot")"
    reload_caddy || true
  else
    render_caddy '127.0.0.1:9'
    reload_caddy || true
  fi
  docker compose --env-file "$ENV_FILE" -f "$release_path/compose.yml" -p "$project" down || true
  write_state "$current_slot" "$current_sha" "$previous_slot" "$previous_sha" failed-public-smoke
  die 'public smoke test failed'
fi

if [[ "$current_slot" == blue || "$current_slot" == green ]]; then
  docker rm -f "synapse-app-$current_slot" >/dev/null 2>&1 || true
fi
write_state "$new_slot" "$sha" "$previous_slot" "$previous_sha" succeeded
log "deployment succeeded: $sha ($new_slot)"
