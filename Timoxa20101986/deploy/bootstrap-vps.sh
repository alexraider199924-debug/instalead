#!/usr/bin/env bash
# One-time bootstrap for a fresh Instalead VPS.
# Safe to re-run: every step checks before it acts.
#
#   scp deploy/bootstrap-vps.sh tim@HOST:/tmp/
#   ssh -i ~/.ssh/instalead_yandex tim@HOST 'bash /tmp/bootstrap-vps.sh'
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/instalead}"
DATA_DIR="${DATA_DIR:-/var/lib/instalead/data}"
SERVICE_USER="${SERVICE_USER:-instalead}"
DEPLOY_USER="$(id -un)"

echo "==> Installing packages"

# Some provider images ship apt sources pointing at http:// mirrors that are
# unreachable on port 80 from their own nodes, which makes every apt call hang
# and time out. Prefer https:// for the distro mirror before the first update.
for f in /etc/apt/sources.list.d/ubuntu.sources; do
  if [ -f "$f" ] && grep -q '^URIs: http://' "$f"; then
    echo "    switching $f to https"
    sed -i 's|^URIs: http://|URIs: https://|' "$f"
  fi
done
if [ -f /etc/apt/sources.list ] && grep -q ' http://' /etc/apt/sources.list; then
  cp /etc/apt/sources.list /etc/apt/sources.list.bak
  sed -i 's| http://| https://|g' /etc/apt/sources.list
fi

sudo apt update -y
sudo apt install -y git nginx certbot python3-certbot-nginx \
  build-essential curl ca-certificates

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "==> Installing Node.js 20 (found: $(node -v 2>/dev/null || echo none))"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

echo "==> Creating service user and directories"
if ! sudo id -u "$SERVICE_USER" >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
sudo mkdir -p "$APP_DIR" "$DATA_DIR"
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
sudo chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

# The systemd unit runs the backend as $SERVICE_USER and reads .env from the
# app directory, so both must stay readable to it.
sudo chmod 755 "$APP_DIR"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/backend/.env" 2>/dev/null || true

echo "==> Versions"
echo "    node    $(node -v)"
echo "    npm     $(npm -v)"
echo "    nginx   $(nginx -v 2>&1)"

echo "==> Done. Next: ./deploy-vps.ps1 -Server <user>@<host>"
echo "    Open ports 80/443 in the provider firewall if not already open."