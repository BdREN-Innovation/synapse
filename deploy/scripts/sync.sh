#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

require_root
repo_root=${1:-}
[[ -n "$repo_root" ]] || die 'repository path is required'
repo_root=$(realpath "$repo_root")
[[ -d "$repo_root/.git" ]] || die "not a Git checkout: $repo_root"
validate_production_checkout "$repo_root"

temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
git -C "$repo_root" archive --format=tar HEAD deploy/scripts deploy/compose/candidate.yml deploy/server.env.example | tar -xf - -C "$temp_dir"

for script in common deploy rollback status cleanup sync; do
  install -m 0750 "$temp_dir/deploy/scripts/$script.sh" "$CICD_ROOT/bin/$script"
done
install -m 0644 "$temp_dir/deploy/server.env.example" "$CONFIG_DIR/deploy.env.example"
install -m 0644 "$temp_dir/deploy/compose/candidate.yml" "$COMPOSE_FILE"
log "deployment assets synchronized from $repo_root"
