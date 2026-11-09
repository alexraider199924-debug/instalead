param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Key = "$env:USERPROFILE\.ssh\instalead_yandex",
  [string]$RemoteDir = "/var/www/instalead",
  [string]$DeployUser = "tim",
  [string]$Archive = "instalead.tar.gz"
)

# Deploys to any host. First-time server setup (packages, user, nginx,
# systemd unit, TLS) is a separate one-off — see deploy/README.md.
#   .\deploy-vps.ps1 -Server tim@203.0.113.10

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Key)) { throw "SSH key not found: $Key" }

Write-Host "==> Packaging project..." -ForegroundColor Cyan
# backend/.env is server state, not source. It carries the OpenRouter key and
# the Telegram bot token, and unpacking a tarball built from a developer's
# machine silently replaces it with an empty one — the service then starts with
# no API key and no bot, which looks like a broken deploy rather than a lost
# file. The server keeps its own copy and it is restored after extraction.
tar --exclude=node_modules --exclude=frontend\dist --exclude=backend\data --exclude=backend/.env `
    -czf $Archive backend frontend extension deploy README.md package.json package-lock.json start.sh start.bat
if ($LASTEXITCODE -ne 0) { throw "tar failed" }

Write-Host "==> Uploading to $Server ..." -ForegroundColor Cyan
scp -i $Key ".\$Archive" "${Server}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }

Write-Host "==> Installing and restarting..." -ForegroundColor Cyan
ssh -i $Key $Server @"
set -e
tar -xzf /tmp/$Archive -C $RemoteDir
rm -f /tmp/$Archive
if [ -f /root/instalead.env.backup ] && [ -f $RemoteDir/backend/.env.bak ]; then
  cp $RemoteDir/backend/.env.bak /root/instalead.env.backup
fi
if [ -f /root/instalead.env.backup ]; then
  cp /root/instalead.env.backup $RemoteDir/backend/.env
  echo 'restored .env from backup'
fi
sudo chown -R $DeployUser`:$DeployUser $RemoteDir
cd $RemoteDir/backend && npm ci
cd $RemoteDir/frontend && npm ci && npm run build
sudo systemctl restart instalead-backend
sudo systemctl reload nginx
sudo systemctl status instalead-backend --no-pager -l | head -n 12
"@
if ($LASTEXITCODE -ne 0) { throw "remote install failed" }

Write-Host "==> Done: $Server updated" -ForegroundColor Green