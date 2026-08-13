#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

require_root
require_tools
target=${1:-$(state_get PREVIOUS_SHA '')}
[[ -n "$target" ]] || die 'no previous candidate image is recorded'
validate_sha "$target"
image=$(image_name "$target")
docker image inspect "$image" >/dev/null 2>&1 || die "candidate image is missing: $image"
validate_candidate_files
start_candidate_services

exec 9>"$LOCK_FILE"
flock -n 9 || die 'another candidate deployment or rollback is running'
current_sha=$(state_get CURRENT_SHA '')
port=$(required_env CANDIDATE_PORT)
remove_container "$CANDIDATE_CONTAINER"
run_candidate "$CANDIDATE_CONTAINER" "$image" "$port" unless-stopped
if ! wait_ready "$CANDIDATE_CONTAINER" "$port"; then
  remove_container "$CANDIDATE_CONTAINER"
  if [[ -n "$current_sha" ]]; then
    run_candidate "$CANDIDATE_CONTAINER" "$(image_name "$current_sha")" "$port" unless-stopped
    wait_ready "$CANDIDATE_CONTAINER" "$port" || true
  fi
  die 'candidate rollback target failed; prior candidate was restored where possible'
fi
write_state "$target" "$current_sha" candidate-rolled-back
log "candidate rollback succeeded: $target"
