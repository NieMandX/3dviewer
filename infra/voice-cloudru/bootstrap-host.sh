#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" = 0
test "$(dpkg --print-architecture)" = amd64
. /etc/os-release
test "$ID:$VERSION_ID" = ubuntu:24.04
cd -- "$(dirname -- "$0")"

# Only install on the new host; never replace an existing Docker installation.
if ! command -v docker >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl uidmap dbus-user-session slirp4netns
  install -d -m 755 /etc/apt/keyrings
  curl --fail --show-error --silent --connect-timeout 15 --max-time 60 \
    --retry 2 --retry-all-errors \
    https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod 644 /etc/apt/keyrings/docker.asc
  install -m 644 docker.sources /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
fi
systemctl enable --now docker
docker version --format '{{.Server.Version}}'
docker compose version
