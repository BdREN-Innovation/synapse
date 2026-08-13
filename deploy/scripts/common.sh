#!/usr/bin/env bash
set -Eeuo pipefail

CICD_ROOT=${SYNAPSE_CICD_ROOT:-/home/bdren/synapse}
CONFIG_DIR="$CICD_ROOT/config"
CANDIDATE_DIR="$CICD_ROOT/candidate"
STATE_DIR="$CICD_ROOT/state"
ENV_FILE="$CONFIG_DIR/deploy.env"
STATE_FILE="$STATE_DIR/release.env"
LOCK_FILE="$STATE_DIR/deploy.lock"
COMPOSE_FILE="$CONFIG_DIR/candidate.yml"
CANDIDATE_CONTAINER=synapse-candidate
PREFLIGHT_CONTAINER=synapse-candidate-preflight

log() { printf '[synapse-cicd] %s\n' "$*"; }
die() { printf '[synapse-cicd] ERROR: %s\n' "$*" >&2; exit 1; }
require_root() { [[ ${EUID:-$(id -u)} -eq 0 ]] || die 'run as root'; }
require_tools() {
  local tool
  for tool in curl docker flock git realpath tar; do
    command -v "$tool" >/dev/null || die "$tool is required"
  done
  docker compose version >/dev/null || die 'Docker Compose plugin is required'
}
validate_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "invalid commit SHA: $1"; }

env_get() {
  local key=$1
  [[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}
required_env() {
  local key=$1 value
  value=$(env_get "$key")
  [[ -n "$value" ]] || die "$key is required in $ENV_FILE"
  printf '%s' "$value"
}

validate_production_checkout() {
  local workspace=$1 expected_slug remote head deploy_branch expected_head
  expected_slug=$(required_env EXPECTED_REPOSITORY_SLUG)
  deploy_branch=$(env_get DEPLOY_BRANCH)
  deploy_branch=${deploy_branch:-production}
  [[ "$deploy_branch" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid DEPLOY_BRANCH: $deploy_branch"
  remote=$(git -C "$workspace" remote get-url origin)
  [[ "$remote" == "https://github.com/$expected_slug.git" || "$remote" == "git@github.com:$expected_slug.git" ]] \
    || die "unexpected repository remote: $remote"
  head=$(git -C "$workspace" rev-parse HEAD)
  expected_head=$(git -C "$workspace" rev-parse "refs/remotes/origin/$deploy_branch") \
    || die "origin/$deploy_branch is not available; run git fetch origin $deploy_branch"
  [[ "$head" == "$expected_head" ]] || die "checkout does not exactly match origin/$deploy_branch"
  git -C "$workspace" diff --quiet || die 'checkout has modified tracked files'
  git -C "$workspace" diff --cached --quiet || die 'checkout has staged changes'
}

state_get() {
  local key=$1 default=${2:-}
  [[ -f "$STATE_FILE" ]] || { printf '%s' "$default"; return; }
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0,"=")+1); exit }' "$STATE_FILE"
}
write_state() {
  local current_sha=$1 previous_sha=$2 outcome=$3
  local tmp
  mkdir -p "$STATE_DIR"
  tmp=$(mktemp "$STATE_DIR/release.XXXXXX")
  cat >"$tmp" <<EOF
CURRENT_SHA=$current_sha
PREVIOUS_SHA=$previous_sha
LAST_OUTCOME=$outcome
UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 600 "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

image_name() { printf 'synapse-candidate:%s' "$1"; }
candidate_env() { required_env CANDIDATE_ENV_FILE; }
candidate_config() { required_env CANDIDATE_CONFIG_FILE; }

validate_candidate_files() {
  local candidate_env_file candidate_config_file
  candidate_env_file=$(candidate_env)
  candidate_config_file=$(candidate_config)
  [[ -f "$candidate_env_file" ]] || die "missing candidate environment: $candidate_env_file"
  [[ -f "$candidate_config_file" ]] || die "missing candidate configuration: $candidate_config_file"
  [[ $(stat -c '%a' "$candidate_env_file") == 600 ]] || die 'candidate .env must have mode 600'
}

start_candidate_services() {
  docker compose -f "$COMPOSE_FILE" -p synapse-candidate-services up -d --wait --wait-timeout 120
}

remove_container() {
  docker rm -f "$1" >/dev/null 2>&1 || true
}

run_candidate() {
  local name=$1 image=$2 port=$3 restart_policy=$4
  local env_file config_file
  env_file=$(candidate_env)
  config_file=$(candidate_config)
  remove_container "$name"
  docker run -d \
    --name "$name" \
    --restart "$restart_policy" \
    --network synapse-candidate \
    -p "127.0.0.1:$port:3080" \
    --env-file "$env_file" \
    -e HOST=0.0.0.0 \
    -e PORT=3080 \
    -e NODE_ENV=production \
    -e MONGO_URI=mongodb://candidate-mongodb:27017/SynapseCandidate \
    -e USE_REDIS=true \
    -e USE_REDIS_STREAMS=true \
    -e REDIS_URI=redis://candidate-redis:6379 \
    -e REDIS_KEY_PREFIX=synapse-candidate \
    -e LIBRECHAT_LOG_DIR=/app/api/logs \
    -e SEARCH=false \
    -v "$env_file:/app/.env:ro" \
    -v "$config_file:/app/librechat.yaml:ro" \
    -v "$CANDIDATE_DIR/uploads:/app/uploads" \
    -v "$CANDIDATE_DIR/logs:/app/api/logs" \
    -v "$CANDIDATE_DIR/images:/app/client/public/images" \
    -v "$CANDIDATE_DIR/data:/app/data" \
    "$image" >/dev/null
}

wait_ready() {
  local container=$1 port=$2 attempts
  attempts=$(required_env READY_ATTEMPTS)
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || die 'READY_ATTEMPTS must be a positive integer'
  for ((i = 1; i <= attempts; i++)); do
    [[ $(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true) == true ]] || break
    curl -fsS --max-time 5 "http://127.0.0.1:$port/readyz" >/dev/null && return 0
    sleep 2
  done
  docker logs --tail 150 "$container" >&2 || true
  return 1
}

run_candidate_migration() {
  local image=$1 env_file config_file
  shift
  env_file=$(candidate_env)
  config_file=$(candidate_config)
  docker run --rm \
    --network synapse-candidate \
    --env-file "$env_file" \
    -e MONGO_URI=mongodb://candidate-mongodb:27017/SynapseCandidate \
    -e USE_REDIS=true \
    -e REDIS_URI=redis://candidate-redis:6379 \
    -e REDIS_KEY_PREFIX=synapse-candidate \
    -v "$env_file:/app/.env:ro" \
    -v "$config_file:/app/librechat.yaml:ro" \
    --workdir /app \
    "$image" node config/migrate-usage-policies.js "$@"
}
