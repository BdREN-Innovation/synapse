#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/scripts/common.sh"

require_root
require_tools
repo_root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$CICD_ROOT/bin" "$CONFIG_DIR" "$CANDIDATE_DIR"/{uploads,logs,images,data} "$STATE_DIR"

for script in common deploy rollback status cleanup sync; do
  install -m 0750 "$repo_root/deploy/scripts/$script.sh" "$CICD_ROOT/bin/$script"
done
install -m 0644 "$repo_root/deploy/server.env.example" "$CONFIG_DIR/deploy.env.example"
install -m 0644 "$repo_root/deploy/compose/candidate.yml" "$COMPOSE_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 "$repo_root/deploy/server.env.example" "$ENV_FILE"
  log "created $ENV_FILE; review it before registering the runner"
fi
if [[ ! -f "$STATE_FILE" ]]; then
  write_state '' '' uninitialized
fi
log 'bootstrap complete; configure candidate/.env and candidate/librechat.yaml before deploying'
log 'the running application, Nginx, PM2, databases, admin panel, and interpreter were not changed'
