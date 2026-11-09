#!/usr/bin/env bash
# One-time setup of a BugSnap server on Ubuntu 24.04 (e.g. an Oracle Cloud Always Free VM).
#
#   curl -fsSL https://raw.githubusercontent.com/rameshlakmal/BugSnap/master/server/deploy/setup.sh -o setup.sh
#   bash setup.sh <your-domain>          e.g. bash setup.sh 129-154-10-20.sslip.io
#
# Installs Node 22, ffmpeg and Caddy (automatic HTTPS), opens ports 80/443, runs BugSnap as a
# service that starts on boot. Safe to run again: it updates instead of reinstalling.
set -euo pipefail

DOMAIN="${1:?Usage: bash setup.sh <domain>   (for example 129-154-10-20.sslip.io)}"
REPO="${REPO:-https://github.com/rameshlakmal/BugSnap.git}"
BRANCH="${BRANCH:-master}"
APP=/opt/bugsnap/app
DATA=/opt/bugsnap/data
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "System packages (ffmpeg, git)"
sudo apt-get update -y
sudo apt-get install -y ffmpeg git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent iptables-persistent

step "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

step "Caddy (HTTPS certificates are automatic)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

step "Firewall: allow web traffic (Oracle's Ubuntu image blocks it by default)"
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
done
sudo netfilter-persistent save

step "BugSnap code"
id bugsnap >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /opt/bugsnap --shell /usr/sbin/nologin bugsnap
sudo mkdir -p "$DATA"
sudo chown -R bugsnap:bugsnap /opt/bugsnap
if [ -d "$APP/.git" ]; then
  sudo -u bugsnap git -C "$APP" fetch --quiet origin "$BRANCH"
  sudo -u bugsnap git -C "$APP" reset --quiet --hard "origin/$BRANCH"
else
  sudo -u bugsnap git clone --quiet --branch "$BRANCH" "$REPO" "$APP"
fi
(cd "$APP/server" && sudo -u bugsnap npm ci --omit=dev --no-audit --no-fund)

step "Settings (server/.env)"
ENV="$APP/server/.env"
if [ ! -f "$ENV" ]; then
  sudo -u bugsnap tee "$ENV" >/dev/null <<EOF
# BugSnap server settings. After editing: sudo systemctl restart bugsnap
PORT=4800
HOST=127.0.0.1
PUBLIC_BASE_URL=https://$DOMAIN
DATA_DIR=$DATA
REQUIRE_LOGIN=1

# Copy these from server/.env on your computer:
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
VIEWER_URL=
DRIVE_API_KEY=
EOF
  sudo chmod 600 "$ENV"
  echo "Created $ENV. Fill in the Google and player values from your computer's server/.env."
else
  sudo -u bugsnap sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$DOMAIN|" "$ENV"
  echo "Kept existing $ENV"
fi

step "Service (starts on boot, restarts if it stops)"
sudo cp "$APP/server/deploy/bugsnap.service" /etc/systemd/system/bugsnap.service
sudo systemctl daemon-reload
sudo systemctl enable --quiet bugsnap
sudo systemctl restart bugsnap

step "HTTPS for $DOMAIN"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:4800
}
EOF
sudo systemctl reload caddy || sudo systemctl restart caddy

sleep 2
step "Done"
systemctl is-active --quiet bugsnap && echo "BugSnap is running." || { echo "BugSnap did not start. See: sudo journalctl -u bugsnap -n 50"; exit 1; }
cat <<EOF

Next:
  1. Add yourself:   cd $APP/server && sudo -u bugsnap npm run user add <your-name>
  2. Restart:        sudo systemctl restart bugsnap
  3. Open https://$DOMAIN in your browser (the first visit may take a minute while the HTTPS
     certificate is issued), then put https://$DOMAIN and your access key in BugSnap Settings.
EOF
