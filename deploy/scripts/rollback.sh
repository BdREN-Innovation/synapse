#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"
require_root
target=${1:-$(state_get PREVIOUS_SHA '')}
[[ -n "$target" ]] || die 'no previous release is recorded'
validate_sha "$target"
"$(dirname "$0")/deploy.sh" "$target"
