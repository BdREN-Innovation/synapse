#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"
require_root
keep=${KEEP_RELEASES:-5}
current=$(state_get CURRENT_SHA '')
previous=$(state_get PREVIOUS_SHA '')
mapfile -t images < <(docker images 'synapse-api' --format '{{.Tag}} {{.CreatedAt}}' | awk '$1 ~ /^[0-9a-f]{40}$/ { print $0 }' | sort -k2r | awk '{print $1}')
count=0
for sha in "${images[@]}"; do
  [[ "$sha" == "$current" || "$sha" == "$previous" ]] && continue
  count=$((count + 1))
  (( count <= keep )) && continue
  docker rmi "synapse-api:$sha" || true
done
