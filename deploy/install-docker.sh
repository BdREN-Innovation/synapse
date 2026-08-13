#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[install-docker] %s\n' "$*"
}

die() {
  printf '[install-docker] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID:-$(id -u)} -eq 0 ]] || die 'run this script with sudo or as root'
command -v apt-get >/dev/null || die 'apt-get is required'
command -v systemctl >/dev/null || die 'systemctl is required'

source /etc/os-release
[[ "${ID:-}" == ubuntu ]] || die "Ubuntu is required; detected ${ID:-unknown}"

docker_suite=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
[[ -n "$docker_suite" ]] || die 'could not determine Ubuntu codename'
[[ "$docker_suite" == noble ]] || die "Ubuntu 24.04 noble is required; detected $docker_suite"

docker_arch=$(dpkg --print-architecture)
case "$docker_arch" in
  amd64|arm64) ;;
  *) die "unsupported architecture: $docker_arch" ;;
esac

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

log 'installing repository prerequisites'
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl

log 'configuring Docker repository signing key'
install -m 0755 -d /etc/apt/keyrings
key_tmp=$(mktemp)
trap 'rm -f "$key_tmp"' EXIT
curl --fail --silent --show-error --location \
  https://download.docker.com/linux/ubuntu/gpg >"$key_tmp"
test -s "$key_tmp" || die 'Docker repository key download was empty'
install -m 0644 "$key_tmp" /etc/apt/keyrings/docker.asc

log "configuring Docker repository for $docker_suite/$docker_arch"
printf '%s\n' \
  'Types: deb' \
  'URIs: https://download.docker.com/linux/ubuntu' \
  "Suites: $docker_suite" \
  'Components: stable' \
  "Architectures: $docker_arch" \
  'Signed-By: /etc/apt/keyrings/docker.asc' \
  >/etc/apt/sources.list.d/docker.sources

log 'installing Docker Engine, Buildx, and Compose'
apt-get update
apt-get install -y --no-install-recommends \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

log 'enabling Docker services'
systemctl enable --now containerd.service
systemctl enable --now docker.service

systemctl is-active --quiet containerd.service || die 'containerd is not active'
systemctl is-active --quiet docker.service || die 'Docker is not active'

log 'Docker installation verified'
docker --version
docker compose version
docker info --format 'Server: {{.ServerVersion}} | Root Dir: {{.DockerRootDir}}'

log 'running Docker smoke test'
docker run --rm hello-world >/dev/null

log 'installation complete'
log 'the Docker group was not modified; CI/CD will use its restricted root command'
