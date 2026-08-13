#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"
require_root

keep=${KEEP_IMAGES:-$(required_env KEEP_IMAGES)}
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || die 'KEEP_IMAGES must be a positive integer'
current=$(state_get CURRENT_SHA '')
previous=$(state_get PREVIOUS_SHA '')
mapfile -t images < <(docker images synapse-candidate --format '{{.Tag}} {{.CreatedAt}}' | sort -k2r | awk '{print $1}')
retained=0
for sha in "${images[@]}"; do
  [[ "$sha" == "$current" || "$sha" == "$previous" ]] && continue
  retained=$((retained + 1))
  (( retained <= keep )) && continue
  validate_sha "$sha"
  docker rmi "$(image_name "$sha")" || true
done
