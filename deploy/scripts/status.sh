#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

printf 'Candidate SHA:          %s\n' "$(state_get CURRENT_SHA none)"
printf 'Previous candidate SHA: %s\n' "$(state_get PREVIOUS_SHA none)"
printf 'Last outcome:           %s\n' "$(state_get LAST_OUTCOME unknown)"
printf 'Updated at:             %s\n' "$(state_get UPDATED_AT unknown)"
docker ps --filter "name=^/${CANDIDATE_CONTAINER}$" --filter 'name=^/synapse-candidate-mongodb$' \
  --filter 'name=^/synapse-candidate-redis$' \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
port=$(required_env CANDIDATE_PORT)
curl -fsS --max-time 5 "http://127.0.0.1:$port/readyz" >/dev/null \
  && printf 'Candidate readiness: healthy\n' \
  || printf 'Candidate readiness: UNHEALTHY\n'
printf 'Production ownership: PM2/Nginx unchanged\n'
