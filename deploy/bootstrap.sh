#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/scripts/common.sh"
require_root
require_tools

repo_root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$CONFIG_DIR" "$SHARED_DIR" "$STATE_DIR" "$RELEASE_DIR" "$ROOT_DIR/bin" "$ROOT_DIR/caddy/data" "$ROOT_DIR/caddy/config"
mkdir -p "$SHARED_DIR"/{images,uploads,logs,skill} "$ROOT_DIR/data"/{mongodb,meilisearch,vectordb}

install -m 0644 "$repo_root/deploy/compose/shared.yml" "$CONFIG_DIR/shared.yml"
install -m 0644 "$repo_root/deploy/compose/slot.yml" "$CONFIG_DIR/slot.yml"
install -m 0644 "$repo_root/deploy/caddy/Caddyfile.tmpl" "$CONFIG_DIR/Caddyfile.tmpl"
install -m 0750 "$repo_root/deploy/scripts/deploy.sh" "$ROOT_DIR/bin/deploy"
install -m 0750 "$repo_root/deploy/scripts/rollback.sh" "$ROOT_DIR/bin/rollback"
install -m 0750 "$repo_root/deploy/scripts/status.sh" "$ROOT_DIR/bin/status"
install -m 0750 "$repo_root/deploy/scripts/cleanup.sh" "$ROOT_DIR/bin/cleanup"
install -m 0750 "$repo_root/deploy/scripts/common.sh" "$ROOT_DIR/bin/common.sh"

if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 "$repo_root/deploy/server.env.example" "$ENV_FILE"
  sed -i "s/^APP_DOMAIN=.*/APP_DOMAIN=chat.example.com/; s/^ADMIN_DOMAIN=.*/ADMIN_DOMAIN=admin.chat.example.com/" "$ENV_FILE"
  log "created $ENV_FILE; edit its domains, image digests, secrets, and provider keys"
fi
if [[ ! -f "$SHARED_DIR/librechat.yaml" ]]; then
  install -m 0640 "$repo_root/librechat.example.yaml" "$SHARED_DIR/librechat.yaml"
fi
if [[ ! -f "$STATE_FILE" ]]; then
  write_state none '' none '' uninitialized
fi
render_caddy 'host.docker.internal:3081'
log "bootstrap complete; edit $ENV_FILE, then run: $ROOT_DIR/bin/status"
