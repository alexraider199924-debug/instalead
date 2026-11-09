<#
.SYNOPSIS
  Полный деплой Instalead на VPS одной командой.

.DESCRIPTION
  Скрипт делает всё сам: собирает проект, заливает его на сервер, при
  необходимости доустанавливает пакеты и создаёт пользователя, ставит
  зависимости, собирает фронтенд, перезапускает systemd и nginx, проверяет
  /health и выпускает сертификат.

  Он заменяет прежний deploy.ps1, который указывал на 89.169.184.150 и
  требовал SSH-ключ. Ключ по-прежнему поддерживается — если он есть, пароль
  не нужен.

.PARAMETER Server
  Кому и куда подключаться. По умолчанию root@147.45.243.151.

.PARAMETER Domain
  Домен для nginx и CORS. Доменное имя и IP добавляются в server_name
  одновременно, чтобы сайт открывался по IP, пока DNS ещё не переключён.

.PARAMETER Key
  Путь к приватному SSH-ключу. Если не задан и ключа по умолчанию нет,
  пароль берётся из $env:INSTALEAD_SSH_PASSWORD, иначе запрашивается.

.PARAMETER SkipTls
  Не выпускать/не обновлять сертификат certbot. Полезно, когда DNS ещё не
  переключён на этот сервер.

.EXAMPLE
  $env:INSTALEAD_SSH_PASSWORD = 'пароль'
  .\deploy.ps1

.EXAMPLE
  .\deploy.ps1 -Key "$env:USERPROFILE\.ssh\instalead_yandex"
#>
param(
  [string]$Server = 'root@147.45.243.151',
  [string]$Domain = 'instalead.ru',
  [string]$RemoteDir = '/var/www/instalead',
  [string]$Key = '',
  [string]$ServiceUser = 'instalead',
  [switch]$SkipTls
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# IP нужен скрипту на сервере: без него nginx не отвечает на запросы по
# адресу, а DNS домена может ещё сутки указывать на прошлый сервер.
$ServerIp = ($Server -split '@')[-1]

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Archive = Join-Path $env:TEMP "instalead-$stamp.tar.gz"
$RemoteArchive = "/tmp/instalead-$stamp.tar.gz"
$remoteScriptPath = "/tmp/instalead-deploy-$stamp.sh"

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor DarkGray }
function Die($msg)  { Write-Host "!! $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# SSH-транспорт
#
# Ключ предпочтительнее: при его наличии скрипт работает без единого вопроса.
# Парольный вариант сделан через SSH_ASKPASS — встроенный ssh.exe умеет брать
# пароль из вспомогательной программы, что позволяет передать его не через
# командную строку, где он осел бы в истории и в списке процессов.
# ---------------------------------------------------------------------------

$DefaultKey = Join-Path $env:USERPROFILE '.ssh\instalead_yandex'
if (-not $Key -and (Test-Path $DefaultKey)) { $Key = $DefaultKey }

$sshArgs = @()
if ($Key) {
  if (-not (Test-Path $Key)) { Die "SSH-ключ не найден: $Key" }
  $sshArgs += @('-i', $Key)
} else {
  if (-not $env:INSTALEAD_SSH_PASSWORD) {
    $secure = Read-Host -Prompt 'Пароль root на сервере' -AsSecureString
    $env:INSTALEAD_SSH_PASSWORD = [System.Net.NetworkCredential]::new('', $secure).Password
  }
  if (-not $env:INSTALEAD_SSH_PASSWORD) { Die 'Пароль не задан' }

  # Хелпер только выводит значение переменной окружения. Сам пароль в файл не
  # пишется — ни в репозиторий, ни во временный каталог на диск.
  #
  # Вывод идёт через PowerShell, а не через `echo` в bat-файле. cmd разбирает
  # подставленное значение повторно и съедает `^` как символ экранирования:
  # пароль pj^M3Fpm9q уходил как pjM3Fpm9q, и ssh отвечал «Permission denied»
  # на совершенно верный пароль. Символы достаёт PowerShell, для cmd в файле
  # их нет вовсе.
  $askPass = Join-Path $env:TEMP "instalead-askpass-$PID.cmd"
  $askPassBody = "@echo off`r`n" +
    'powershell -NoProfile -Command "[Console]::Out.Write($env:INSTALEAD_SSH_PASSWORD)"' +
    "`r`n"
  [IO.File]::WriteAllText($askPass, $askPassBody, [Text.Encoding]::ASCII)
  $env:SSH_ASKPASS = $askPass
  $env:SSH_ASKPASS_REQUIRE = 'force'
  $env:DISPLAY = 'instalead'
}

# Первый контакт с новым сервером не должен падать на вопросе о ключе.
$sshArgs += @('-o', 'StrictHostKeyChecking=accept-new',
              '-o', 'ConnectTimeout=20',
              '-o', 'ServerAliveInterval=30')

# ---------------------------------------------------------------------------
# 1. Сборка пакета
#
# backend/.env и backend/data исключены намеренно: это состояние сервера, а не
# исходники. Распаковка архива, собранного на машине разработчика, молча
# заменила бы .env пустым, и сервис поднялся бы без API-ключа — это
# выглядит как «сломанный деплой», хотя сломана всего лишь упаковка.
# ---------------------------------------------------------------------------

Step 'Проверка окружения'
foreach ($tool in @('tar', 'node', 'npm', 'ssh', 'scp')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Die "Не найден $tool" }
}
Ok "node $(& node -v)"

Step 'Сборка архива'
Push-Location $PSScriptRoot
try {
  & tar --exclude=node_modules --exclude=.git --exclude='*.tar.gz' `
        --exclude=frontend/dist --exclude=backend/data --exclude=backend/.env `
        -czf $Archive backend frontend extension deploy README.md package.json package-lock.json start.sh start.bat
  if ($LASTEXITCODE -ne 0) { Die 'Не удалось собрать архив' }
} finally {
  Pop-Location
}
Ok ("архив {0:N1} МБ" -f ((Get-Item $Archive).Length / 1MB))

# ---------------------------------------------------------------------------
# 2. Удалённый скрипт
#
# Собирается локально и уезжает файлом, а не через stdin. PowerShell при
# перенаправлении текста в нативную команду подставляет CRLF, и bash
# спотыкается о невидимый \r в конце каждой команды.
# ---------------------------------------------------------------------------

$skipTlsArg = if ($SkipTls) { 'yes' } else { 'no' }

# Имя намеренно не $remoteScript: переменные в PowerShell не различают регистр,
# и `$remoteScript` (текст) перезаписал бы `$remoteScriptPath` (путь) — bash
# получил бы текст установщика вместо пути к файлу и спотыкался бы на `set`.
# Маркеры здесь — @@…@@, а не __…__. Ниже, в sed-командах, дословно стоит
# '__DOMAIN__': PowerShell заменяет все вхождения маркера в тексте, и '__DOMAIN__'
# в маске sed превратился бы в 'instalead.ru' — sed искал бы уже подставленное
# значение, ничего не находил, и на сервер ложился конфиг с неразобранным
# __DOMAIN__ вместо имени домена.
$remoteInstaller = @'
set -euo pipefail

APP_DIR="@@APP_DIR@@"
DATA_DIR="/var/lib/instalead/data"
SERVICE_USER="@@SERVICE_USER@@"
STAGE="/tmp/instalead-release"
ARCHIVE="@@ARCHIVE@@"
DOMAIN="@@DOMAIN@@"
SERVER_IP="@@SERVER_IP@@"
SKIP_TLS="__SKIP_TLS__"

say() { printf '    %s\n' "$*"; }

# --- 1. Пакеты -------------------------------------------------------------
# Некоторые образы провайдеров кладут apt-источники на http://, который с их же
# ноды недоступен: каждый apt-запрос виснет до таймаута. Переключаем на https
# до первого обновления.
if [ -f /etc/apt/sources.list.d/ubuntu.sources ] && grep -q '^URIs: http://' /etc/apt/sources.list.d/ubuntu.sources; then
  say "переключаю apt-зеркала на https"
  sed -i 's|^URIs: http://|URIs: https://|' /etc/apt/sources.list.d/ubuntu.sources
fi
if [ -f /etc/apt/sources.list ] && grep -q ' http://' /etc/apt/sources.list; then
  say "переключаю /etc/apt/sources.list на https"
  sed -i 's| http://| https://|g' /etc/apt/sources.list
fi

export DEBIAN_FRONTEND=noninteractive

# Пакеты — не лучший источник истины, а удобство. У этого сервера apt-зеркало
# timeweb.ru недоступно из его же сети, и повторный деплой обязан продолжаться
# на уже установленных node/nginx/certbot, а не падать на apt-get. Отсутствие
# пакета обнаружится позже, на той команде, которой он нужен, — с внятной
# ошибкой вместо молчаливого пропуска.
if apt-get update -y -qq 2>/dev/null && \
   apt-get install -y -qq git nginx certbot python3-certbot-nginx \
     build-essential curl ca-certificates rsync >/dev/null 2>&1; then
  say "системные пакеты на месте"
else
  say "apt недоступен (зеркало не отвечает) — продолжаю на имеющихся пакетах"
fi

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "ставлю Node.js 20 (сейчас: $(node -v 2>/dev/null || echo нет))"
  if ! (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null && \
        apt-get install -y -qq nodejs >/dev/null 2>&1); then
    say "ВНИМАНИЕ: не удалось обновить Node.js, работаю на $(node -v 2>/dev/null || echo 'отсутствующем')"
  fi
fi
say "node $(node -v)"

# rsync нужен всегда, без него развёртывание невозможно — это единственная
# зависимость, за которой стоит падать.
command -v rsync >/dev/null 2>&1 || { echo "!! нет rsync, ставите вручную: apt-get install rsync"; exit 1; }

# --- 2. Пользователь и каталоги -------------------------------------------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  say "создан системный пользователь $SERVICE_USER"
fi
mkdir -p "$APP_DIR" "$DATA_DIR"
# Базы лежат вне каталога релиза: деплой заменяет $APP_DIR целиком, и данные
# обязаны пережить это без копирования вручную.
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# --- 3. Распаковка ---------------------------------------------------------
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "$ARCHIVE" -C "$STAGE"
rm -f "$ARCHIVE"

if [ -f "$APP_DIR/backend/.env" ]; then
  cp -a "$APP_DIR/backend/.env" /root/instalead.env.bak
  say "текущий .env сохранён в /root/instalead.env.bak"
fi

# Снимок рабочих баз до всего, что может их задеть. Деплой сервис
# перезапускает, а в каталоге данных лежат базы нескольких рабочих
# пространств; снимок стоит несколько секунд и снимает единственный класс
# потерь, который вообще способен вызвать этот скрипт.
if ls "$DATA_DIR"/*.db >/dev/null 2>&1; then
  mkdir -p "$DATA_DIR/backups"
  BACKUP="$DATA_DIR/backups/pre-deploy-$(date +%Y%m%d-%H%M%S).tar.gz"
  # Именно cd, а не `tar -C`: оболочка раскрывает маску `./*.db` ДО запуска
  # tar, то есть в каталоге, где работает скрипт, а не в каталоге данных.
  # С `-C` маска не находила ничего, tar падал, а бэкап не появлялся — при
  # этом деплой продолжался как ни в чём не бывало.
  if (cd "$DATA_DIR" && tar -czf "$BACKUP" --exclude=./backups ./*.db) 2>/dev/null; then
    say "бэкап баз: $BACKUP ($(du -h "$BACKUP" | cut -f1))"
  else
    say "ВНИМАНИЕ: не удалось сделать бэкап баз — продолжаю без него"
  fi
fi

# --delete убирает файлы, исчезнувшие из проекта, но оставляет .env и данные.
# Без него удалённый модуль продолжал бы лежать в релизе и импортироваться.
#
# frontend/dist в исключениях обязателен по другой причине: в архив он не
# попадает (собирается локально), и --delete снёс бы на сервере рабочий бандл.
# Упало бы что-то дальше — сайт остался бы без index.html и отдавал 404 при
# вполне здоровом бэкенде. Исключение от deletion держит прошлый бандл на
# месте до того момента, когда новый уже собран.
rsync -a --delete \
  --exclude 'backend/.env' \
  --exclude 'backend/data' \
  --exclude 'frontend/dist' \
  --exclude 'node_modules' \
  "$STAGE/" "$APP_DIR/"
rm -rf "$STAGE"

# --- 4. Конфигурация приложения -------------------------------------------
if [ ! -f "$APP_DIR/backend/.env" ]; then
  say "создаю backend/.env из шаблона"
  sed "s|YOUR_DOMAIN|$DOMAIN|g" "$APP_DIR/backend/.env.production.example" > "$APP_DIR/backend/.env"
  # Пока DNS не переключён, сайт открыт по IP. Без этого в списке источников
  # CORS фронтенд с IP-адреса получает 403 и выглядит полностью сломанным.
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=https://$DOMAIN,https://www.$DOMAIN,http://$SERVER_IP|" "$APP_DIR/backend/.env"
  sed -i "s|^OPENROUTER_SITE_URL=.*|OPENROUTER_SITE_URL=https://$DOMAIN|" "$APP_DIR/backend/.env"
fi

install -m 644 "$APP_DIR/deploy/instalead-backend.service" /etc/systemd/system/instalead-backend.service
sed "s|__DOMAIN__|$DOMAIN|g; s|__SERVER_IP__|$SERVER_IP|g" \
  "$APP_DIR/deploy/nginx.instalead.conf" > /etc/nginx/sites-available/instalead
ln -sf /etc/nginx/sites-available/instalead /etc/nginx/sites-enabled/instalead
rm -f /etc/nginx/sites-enabled/default

# TLS-блок живёт отдельным файлом и ставится только когда сертификат уже есть.
#
# Строка выше перезаписывает sites-available/instalead целиком, а до
# первого прогона в этом файле жил блок `listen 443`, который когда-то добавил
# certbot. Основной конфиг его не содержит, поэтому без этого блока nginx
# перестаёт слушать 443 — а фронт стоит за Cloudflare, который ходит на
# origin по HTTPS и отдаёт посетителям 521. На самом сервере при этом всё
# «работает»: /health по IP отвечает 200. Именно так сайт и лежал.
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  sed "s|__DOMAIN__|$DOMAIN|g" \
    "$APP_DIR/deploy/nginx-tls.instalead.conf" > /etc/nginx/sites-available/instalead-tls
  ln -sf /etc/nginx/sites-available/instalead-tls /etc/nginx/sites-enabled/instalead-tls
  say "TLS-конфиг установлен"
else
  rm -f /etc/nginx/sites-enabled/instalead-tls
  say "сертификата пока нет — HTTPS появится после certbot"
fi
nginx -t

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# --- 5. Зависимости и сборка ----------------------------------------------
say "ставлю зависимости backend"
cd "$APP_DIR/backend"
npm ci --omit=dev >/dev/null

say "собираю frontend"
cd "$APP_DIR/frontend"
npm ci >/dev/null
npm run build >/dev/null
say "готов бандл на $(du -sh "$APP_DIR/frontend/dist" | cut -f1)"

# --- 6. Запуск -------------------------------------------------------------
systemctl daemon-reload
systemctl enable instalead-backend >/dev/null 2>&1 || true
systemctl restart instalead-backend

# Порт поднимается не мгновенно: ждём, а не падаем на первом же curl.
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3002/health >/dev/null 2>&1; then break; fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:3002/health >/dev/null 2>&1; then
  echo "!! backend не отвечает на /health. Последние строки лога:"
  journalctl -u instalead-backend --no-pager -n 30
  exit 1
fi
say "backend отвечает на /health"

systemctl reload nginx

# --- 7. TLS ----------------------------------------------------------------
if [ "$SKIP_TLS" = "yes" ]; then
  say "TLS пропущен (--SkipTls)"
elif [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  say "обновляю сертификат"
  certbot renew --quiet >/dev/null 2>&1 || say "certbot renew не отработал, сертификат прежний"
else
  say "выпускаю сертификат для $DOMAIN"
  if certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos \
      --register-unsafely-without-email --redirect >/dev/null 2>&1; then
    say "сертификат получен"
  else
    say "certbot не смог получить сертификат — домен, скорее всего, ещё не указывает на $SERVER_IP"
    say "после переключения DNS: certbot --nginx -d $DOMAIN -d www.$DOMAIN"
  fi
fi

echo "OK"
'@

$remoteInstaller = $remoteInstaller `
  -replace '@@APP_DIR@@',      $RemoteDir `
  -replace '@@SERVICE_USER@@', $ServiceUser `
  -replace '@@ARCHIVE@@',      $RemoteArchive `
  -replace '@@DOMAIN@@',       $Domain `
  -replace '@@SERVER_IP@@',    $ServerIp `
  -replace '@@SKIP_TLS@@',     $skipTlsArg

# Контрольная проверка: если хоть один маркер не подставился, на сервер уедет
# конфиг с буквальным @@…@@ и nginx откажется стартовать — лучше понять это
# здесь, чем после распаковки на боевой машине.
if ($remoteInstaller -match '@@[A-Z_]+@@') {
  Die "остались неподставленные маркеры: $($Matches[0])"
}

$localScript = Join-Path $env:TEMP "instalead-deploy-$stamp.sh"
[IO.File]::WriteAllText($localScript, ($remoteInstaller -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))

# ---------------------------------------------------------------------------
# 3. Загрузка и запуск
# ---------------------------------------------------------------------------

Step "Загрузка на $Server"
# Оба файла одной командой. Два отдельных вызова scp означали две сессии и две
# точки отказа на пути, который и так упирается в один SSH-пароль; заодно
# скрипт не может уехать без архива или наоборот.
& scp @sshArgs $Archive $localScript "${Server}:/tmp/"
if ($LASTEXITCODE -ne 0) { Die "scp не удался (код $LASTEXITCODE)" }

Step 'Установка и перезапуск на сервере'
& ssh @sshArgs $Server "bash $remoteScriptPath; rc=`$?; rm -f $remoteScriptPath; exit `$rc"
$remoteExit = $LASTEXITCODE

Remove-Item $Archive, $localScript -Force -ErrorAction SilentlyContinue
if ($env:SSH_ASKPASS) { Remove-Item $env:SSH_ASKPASS -Force -ErrorAction SilentlyContinue }

if ($remoteExit -ne 0) {
  Write-Host ''
  Die "Деплой не завершился (код $remoteExit). Логи: journalctl -u instalead-backend -n 50"
}

Step 'Проверка снаружи'
foreach ($url in @("http://$ServerIp/health", "http://$ServerIp/")) {
  $code = try {
    (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop).StatusCode
  } catch {
    if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'нет ответа' }
  }
  Ok "$url → $code"
}

Write-Host ''
Write-Host "Готово. Сайт: http://$ServerIp  ·  Домен: https://$Domain" -ForegroundColor Green
Write-Host "Логи: ssh $Server 'journalctl -u instalead-backend -f'" -ForegroundColor DarkGray