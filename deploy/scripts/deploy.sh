#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

require_root
require_tools
sha=${1:-}
workspace=${2:-}
validate_sha "$sha"
[[ -n "$workspace" ]] || die 'checked-out repository path is required'
workspace=$(realpath "$workspace")
[[ -d "$workspace/.git" ]] || die "not a Git checkout: $workspace"
validate_production_checkout "$workspace"
[[ $(git -C "$workspace" rev-parse HEAD) == "$sha" ]] || die 'workspace SHA does not match requested SHA'
validate_candidate_files

exec 9>"$LOCK_FILE"
flock -n 9 || die 'another candidate deployment or rollback is running'

image=$(image_name "$sha")
current_sha=$(state_get CURRENT_SHA '')
previous_sha=$current_sha
candidate_port=$(required_env CANDIDATE_PORT)
preflight_port=$(required_env PREFLIGHT_PORT)
[[ "$candidate_port" =~ ^[0-9]+$ && "$preflight_port" =~ ^[0-9]+$ ]] || die 'candidate ports must be numeric'

log "building immutable candidate image $image"
docker build \
  --file "$workspace/Dockerfile.multi" \
  --target api-build \
  --build-arg BUILD_COMMIT="$sha" \
  --build-arg BUILD_BRANCH=production \
  --build-arg "BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --tag "$image" \
  "$workspace"

start_candidate_services
if [[ "$(env_get RUN_USAGE_POLICY_MIGRATION)" == true ]]; then
  run_candidate_migration "$image" --dry-run
  run_candidate_migration "$image"
fi

log "preflighting $image on 127.0.0.1:$preflight_port"
run_candidate "$PREFLIGHT_CONTAINER" "$image" "$preflight_port" no
if ! wait_ready "$PREFLIGHT_CONTAINER" "$preflight_port"; then
  remove_container "$PREFLIGHT_CONTAINER"
  write_state "$current_sha" "$(state_get PREVIOUS_SHA '')" failed-preflight
  die 'candidate image failed preflight; current PM2 production and candidate remain unchanged'
fi
remove_container "$PREFLIGHT_CONTAINER"

log "activating candidate $image on 127.0.0.1:$candidate_port"
remove_container "$CANDIDATE_CONTAINER"
run_candidate "$CANDIDATE_CONTAINER" "$image" "$candidate_port" unless-stopped
if ! wait_ready "$CANDIDATE_CONTAINER" "$candidate_port"; then
  remove_container "$CANDIDATE_CONTAINER"
  if [[ -n "$current_sha" ]] && docker image inspect "$(image_name "$current_sha")" >/dev/null 2>&1; then
    run_candidate "$CANDIDATE_CONTAINER" "$(image_name "$current_sha")" "$candidate_port" unless-stopped
    wait_ready "$CANDIDATE_CONTAINER" "$candidate_port" || true
  fi
  write_state "$current_sha" "$(state_get PREVIOUS_SHA '')" failed-activation
  die 'candidate activation failed; previous candidate was restored where possible'
fi

write_state "$sha" "$previous_sha" candidate-ready
log "candidate ready: $image at http://127.0.0.1:$candidate_port"
log 'PM2 production, Nginx, and the interpreter server were not changed'
