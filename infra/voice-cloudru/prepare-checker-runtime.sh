#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" = 0
test "$(id -u lpm-checker)" = 1001
cd -- "$(dirname -- "$0")"

install -d -m 700 /var/backups/lpmview-checker/runtime /etc/lpmview-checker
runtime=/opt/lpmview/checker/runtime/node22
if ! test -x "$runtime/bin/node"; then
  version=v22.23.4
  archive="node-$version-linux-x64.tar.xz"
  download=/var/backups/lpmview-checker/runtime
  curl -fsS --retry 2 --retry-all-errors --connect-timeout 15 --max-time 180 \
    "https://nodejs.org/dist/$version/$archive" -o "$download/$archive"
  curl -fsS --retry 2 --retry-all-errors --connect-timeout 15 --max-time 60 \
    "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$download/SHASUMS256.txt"
  (cd "$download" && grep "  $archive\$" SHASUMS256.txt | sha256sum --check --strict -)
  install -d -m 755 "$runtime"
  tar -xJf "$download/$archive" --strip-components=1 -C "$runtime"
fi
"$runtime/bin/node" --version

install -d -m 700 /var/lib/lpmview-checker-data
install -d -m 755 /var/lib/lpmview-checker
install -d -m 700 -o lpm-checker -g lpm-checker /var/lib/lpmview-checker/work
disk=/var/lib/lpmview-checker-data/workspace.ext4
if ! test -e "$disk"; then
  test -z "$(ls -A /var/lib/lpmview-checker/work)"
  fallocate -l 16G "$disk"
  chmod 600 "$disk"
  mkfs.ext4 -q "$disk"
fi
unit=$(systemd-escape --path --suffix=mount /var/lib/lpmview-checker/work)
install -m 644 checker-work.mount "/etc/systemd/system/$unit"
systemctl daemon-reload
systemctl enable --now "$unit"
chown lpm-checker:lpm-checker /var/lib/lpmview-checker/work
chmod 700 /var/lib/lpmview-checker/work
install -d -m 700 -o lpm-checker -g lpm-checker \
  /var/lib/lpmview-checker/work/jobs /var/lib/lpmview-checker/work/tmp

# Install but do not enable services until the target database has been restored.
install -m 644 ../../services/model-checker/deploy/lpmview-checker-*.service /etc/systemd/system/
install -m 644 ../../services/model-checker/deploy/lpmview-checker-health.timer /etc/systemd/system/
systemctl daemon-reload
findmnt --target /var/lib/lpmview-checker/work -o TARGET,FSTYPE,OPTIONS,SIZE
