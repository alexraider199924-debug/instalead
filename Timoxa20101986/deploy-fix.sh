#!/bin/bash
# Full deployment: backup -> build in staging -> atomic switch -> verify.
# Safe to re-run. The previous release stays on disk under /var/www/instalead-prev-*.
set -e

REPO=/var/www/instalead
NEXT=/var/www/instalead-next
ARCHIVE=/tmp/instalead.tar.gz
TS=$(date +%F-%H%M%S)
PREV=/var/www/instalead-prev-$TS

say() { echo; echo "=== $* ==="; }

# --- 1. Backup ------------------------------------------------------------
# The backend keeps SQLite in memory (sql.js) and rewrites the files, so a tar
# taken while it runs can capture a half-written database.
say "Backup $TS"
systemctl stop instalead-backend
sleep 2
trap 'systemctl start instalead-backend 2>/dev/null || true' ERR
tar -czf "/root/instalead-backup-$TS.tar.gz" -C /var/lib instalead/data
cp "$REPO/backend/.env" /root/instalead.env.backup
systemctl start instalead-backend
sleep 3
trap - ERR
systemctl is-active instalead-backend
ls -la "/root/instalead-backup-$TS.tar.gz"

# --- 2. Stage -------------------------------------------------------------
# Built beside the live release, so the site keeps serving the old frontend
# until the switch instead of going dark for the duration of npm ci.
say "Staging build"
rm -rf "$NEXT"
mkdir -p "$NEXT"
tar -xzf "$ARCHIVE" -C "$NEXT"

# Neither the archive nor the release carries these: data lives in
# /var/lib/instalead/data and the secrets only ever exist on the server.
cp "$REPO/backend/.env" "$NEXT/backend/.env"
if ! grep -q '^OPENROUTER_SITE_URL=' "$NEXT/backend/.env"; then
  printf 'OPENROUTER_SITE_URL=https://instalead.ru\nOPENROUTER_APP_TITLE=Instalead\n' >> "$NEXT/backend/.env"
fi
chmod 640 "$NEXT/backend/.env"

cd "$NEXT/backend" && npm ci --no-audit --no-fund 2>&1 | tail -3
cd "$NEXT/frontend" && npm ci --no-audit --no-fund 2>&1 | tail -3
cd "$NEXT/frontend" && npm run build 2>&1 | tail -8
test -f "$NEXT/frontend/dist/index.html" || { echo "BUILD FAILED"; exit 1; }
chown -R instalead:instalead "$NEXT"

# --- 3. Switch ------------------------------------------------------------
say "Switching release"
systemctl stop instalead-backend
trap 'systemctl start instalead-backend 2>/dev/null || true' ERR

mv "$REPO" "$PREV"
mv "$NEXT" "$REPO"
chown -R instalead:instalead "$REPO"
chmod 640 "$REPO/backend/.env"

systemctl start instalead-backend
sleep 4

if ! systemctl is-active --quiet instalead-backend; then
  echo "service failed to start — rolling back to $PREV" >&2
  journalctl -u instalead-backend --no-pager -n 30 >&2 || true
  mv "$REPO" "$NEXT"
  mv "$PREV" "$REPO"
  systemctl start instalead-backend
  exit 1
fi

nginx -t 2>&1 | tail -1
systemctl reload nginx
trap - ERR

# --- 4. Verify ------------------------------------------------------------
say "Verification"
systemctl is-active instalead-backend
curl -s -m 15 -o /dev/null -w "backend health: %{http_code}\n" http://127.0.0.1:3002/health
curl -s -m 15 -o /dev/null -w "site:           %{http_code}\n" https://instalead.ru/
echo "bundle: $(curl -s -m 15 https://instalead.ru/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)"
echo "previous release: $PREV"
echo
echo "Done. Enrichment changes are live."
