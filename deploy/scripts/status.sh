#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

printf 'Current slot:  %s\n' "$(state_get ACTIVE_SLOT none)"
printf 'Current SHA:   %s\n' "$(state_get CURRENT_SHA none)"
printf 'Previous slot: %s\n' "$(state_get PREVIOUS_SLOT none)"
printf 'Previous SHA:  %s\n' "$(state_get PREVIOUS_SHA none)"
printf 'Last outcome:  %s\n' "$(state_get LAST_OUTCOME unknown)"
printf 'Updated at:    %s\n' "$(state_get UPDATED_AT unknown)"
docker ps --filter 'name=synapse-' --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
