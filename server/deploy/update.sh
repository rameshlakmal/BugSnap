#!/usr/bin/env bash
# Update a hosted BugSnap server to the latest code:  bash /opt/bugsnap/app/server/deploy/update.sh
set -euo pipefail
APP=/opt/bugsnap/app
BRANCH="${BRANCH:-master}"
sudo -u bugsnap git -C "$APP" fetch --quiet origin "$BRANCH"
sudo -u bugsnap git -C "$APP" reset --quiet --hard "origin/$BRANCH"
(cd "$APP/server" && sudo -u bugsnap npm ci --omit=dev --no-audit --no-fund)
sudo cp "$APP/server/deploy/bugsnap.service" /etc/systemd/system/bugsnap.service
sudo systemctl daemon-reload
sudo systemctl restart bugsnap
sleep 2
systemctl is-active --quiet bugsnap && echo "Updated and running: $(git -C "$APP" log -1 --format='%h %s')" || { echo "Not running. See: sudo journalctl -u bugsnap -n 50"; exit 1; }
