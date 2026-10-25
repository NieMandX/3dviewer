#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" = 0
cd -- "$(dirname -- "$0")"
if ! id lpm-checker >/dev/null 2>&1; then
  if getent passwd 1001 >/dev/null; then
    printf 'UID 1001 is occupied; review the existing checker systemd units first.\n' >&2
    exit 1
  fi
  useradd --create-home --uid 1001 --user-group --shell /usr/sbin/nologin lpm-checker
fi
test "$(id -u lpm-checker)" = 1001
test "$(id -Gn lpm-checker)" = lpm-checker
install -d -m 755 /etc/systemd/system/user-1001.slice.d /etc/systemd/system/user@1001.service.d
install -m 644 checker-slice.conf /etc/systemd/system/user-1001.slice.d/lpmview-limits.conf
install -m 644 checker-delegate.conf /etc/systemd/system/user@1001.service.d/lpmview-delegate.conf
systemctl daemon-reload
loginctl enable-linger lpm-checker
systemctl start user@1001.service
runuser -u lpm-checker -- env HOME=/home/lpm-checker XDG_RUNTIME_DIR=/run/user/1001 \
  dockerd-rootless-setuptool.sh install --force
runuser -u lpm-checker -- env HOME=/home/lpm-checker XDG_RUNTIME_DIR=/run/user/1001 \
  DOCKER_HOST=unix:///run/user/1001/docker.sock docker info \
  --format '{{json .SecurityOptions}} {{.CgroupVersion}} {{.CgroupDriver}}'
install -d -m 755 /opt/lpmview/checker/service
cp -a ../../services/model-checker/. /opt/lpmview/checker/service/
chown -R root:root /opt/lpmview/checker/service
chmod -R go-w /opt/lpmview/checker/service
install -d -m 700 -o lpm-checker -g lpm-checker /var/lib/lpmview-checker/probes
# No database credentials, queue worker, API unit, or health timer is enabled here.
