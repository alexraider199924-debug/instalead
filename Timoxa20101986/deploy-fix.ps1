# Deploys the current working tree to the production server.
#   .\deploy-fix.ps1
#
# Wraps deploy-fix.sh: packs the project, uploads it, then runs backup ->
# staging build -> atomic switch -> verification on the server. The previous
# release is kept under /var/www/instalead-prev-<timestamp> for a one-command
# rollback.

$ErrorActionPreference = "Stop"

$KEY   = "$env:USERPROFILE\.ssh\instalead_yandex"
$SERVER = "root@147.45.243.151"
$ARCHIVE = "instalead.tar.gz"

if (-not (Test-Path $KEY)) { throw "SSH key not found: $KEY" }

Write-Host "==> Packing project..." -ForegroundColor Cyan
# node_modules, the built frontend, the local database and every .env are
# deliberately excluded: they are build output or server state, and shipping a
# developer's .env would overwrite the live secrets with empty ones.
Remove-Item $ARCHIVE -ErrorAction SilentlyContinue
tar --exclude=node_modules --exclude=frontend/dist --exclude=backend/data --exclude=backend/.env --exclude=backend/.env.bak --exclude=.env --exclude=*.tar.gz --exclude=.claude `
    -czf $ARCHIVE backend frontend extension deploy README.md package.json package-lock.json start.sh start.bat
if ($LASTEXITCODE -ne 0) { throw "tar failed" }
Write-Host "    archive: $((Get-Item $ARCHIVE).Length) bytes, $((tar -tzf $ARCHIVE | Measure-Object).Count) files" -ForegroundColor DarkGray

Write-Host "==> Uploading..." -ForegroundColor Cyan
scp -q -i $KEY ".\$ARCHIVE" "${SERVER}:/tmp/instalead.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }
scp -q -i $KEY ".\deploy-fix.sh" "${SERVER}:/tmp/deploy-fix.sh"
if ($LASTEXITCODE -ne 0) { throw "scp of deploy script failed" }

Write-Host "==> Deploying on server (backup, build, switch)..." -ForegroundColor Cyan
ssh -i $KEY $SERVER "chmod +x /tmp/deploy-fix.sh; bash /tmp/deploy-fix.sh"
if ($LASTEXITCODE -ne 0) { throw "remote deploy failed - the previous release is still in place" }

Write-Host "==> Deployed." -ForegroundColor Green
Write-Host "    Reload the extension at chrome://extensions so the new logs take effect." -ForegroundColor Yellow
