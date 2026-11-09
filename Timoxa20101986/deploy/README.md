# Развёртывание Instalead

## Обычный путь: одна команда

```powershell
$env:INSTALEAD_SSH_PASSWORD = 'пароль root'
.\deploy.ps1
```

`deploy.ps1` в корне проекта делает всё сам: собирает архив, заливает его на
сервер, при необходимости ставит пакеты и Node.js, создаёт пользователя и
каталоги, снимает бэкап баз, обновляет зависимости, пересобирает фронтенд,
перезапускает сервис и nginx, обновляет сертификат и проверяет `/health`.
Повторные запуски безопасны: `.env` и каталог данных не перезаписываются.

Ключ, если он есть, предпочтительнее пароля:

```powershell
.\deploy.ps1 -Key "$env:USERPROFILE\.ssh\instalead_yandex"
```

Полезные ключи: `-Server`, `-Domain`, `-SkipTls`.

Скрипт лежит в UTF-8 **с BOM** — без него Windows PowerShell 5.1 читает
кириллицу как ANSI и не может разобрать файл. Запуск:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

---

## Ручная установка

Ниже инструкция для Ubuntu 22.04/24.04 на виртуальной машине. Нужны SSH-доступ к VM, домен и возможность изменить DNS-записи.

## 1. Что подготовить в Yandex Cloud

1. Создайте/используйте VM с публичным IPv4.
2. Разрешите во входной группе безопасности TCP `22`, `80`, `443`. Порт `3002` наружу не открывайте.
3. Узнайте публичный IP VM.
4. В DNS домена создайте:
   - `A @ -> PUBLIC_IP`;
   - при необходимости `A www -> PUBLIC_IP`.
   Дождитесь обновления DNS.
5. Подготовьте SSH-ключ. Парольный SSH лучше отключить после проверки доступа.

## 2. Установка пакетов на VM

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Создайте отдельного пользователя и каталог:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin instalead
sudo mkdir -p /var/www/instalead
# Persistent DB directory: never put this inside a directory replaced by deploys.
sudo mkdir -p /var/lib/instalead/data
sudo chown -R instalead:instalead /var/lib/instalead
sudo chown -R "$USER":"$USER" /var/www/instalead
```

## 3. Загрузка проекта

Вариант через Git:

```bash
cd /var/www/instalead
git clone YOUR_REPOSITORY_URL .
```

Вариант без Git: на локальном ПК архивируйте проект без `node_modules`, `frontend/dist` и секретов, затем загрузите:

```bash
scp instalead.tar.gz USER@SERVER_IP:/tmp/
ssh USER@SERVER_IP
sudo mkdir -p /var/www/instalead
sudo tar -xzf /tmp/instalead.tar.gz -C /var/www/instalead
```

На сервер не загружайте локальные `backend/.env`, реальные ключи и чужие базы, если не хотите переносить данные. Перед миграцией сделайте backup.

Установите зависимости и соберите frontend:

```bash
cd /var/www/instalead/backend
npm ci
cp .env.production.example .env
nano .env

cd /var/www/instalead/frontend
npm ci
npm run build
```

В `backend/.env` замените `YOUR_DOMAIN` на настоящий домен:

```env
PORT=3002
NODE_ENV=production
CORS_ORIGINS=https://YOUR_DOMAIN
COOKIE_SECURE=true
TELEGRAM_BOT_TOKEN=
```

## 4. Создание admin-аккаунта

Перед запуском настройте постоянный каталог для БД. Unit-файл задаёт `INSTALEAD_DATA_DIR=/var/lib/instalead/data`; он должен существовать, быть доступен пользователю `instalead` и оставаться вне каталога релиза. При первой миграции со старой установки сначала остановите backend и скопируйте существующие базы, не создавая пустые вместо них:

```bash
sudo systemctl stop instalead-backend
sudo cp -a /var/www/instalead/backend/data/. /var/lib/instalead/data/  # если исходная папка существует
sudo chown -R instalead:instalead /var/lib/instalead/data
```

Если приложение уже запускалось и создало пустую `users.db`, не перезаписывайте её вслепую: сравните файлы и сначала сделайте резервную копию обоих наборов данных. Новое расположение само по себе не восстановит аккаунты, потерянные в ephemeral-хранилище или не перенесённые при прошлых деплоях.

Сначала запустите backend временно или выполните provisioning-команду после установки зависимостей:

```bash
cd /var/www/instalead/backend
node scripts/create-admin.mjs 'YOUR_ADMIN_EMAIL' 'USE_A_LONG_RANDOM_PASSWORD'
```

Пароль не помещайте в Git, shell history и документацию. Если база `backend/data/users.db` уже переносилась с локального ПК, сначала проверьте существующего admin.

## 5. Запуск backend через systemd

```bash
sudo cp /var/www/instalead/deploy/instalead-backend.service /etc/systemd/system/
sudo chown -R instalead:instalead /var/www/instalead
sudo systemctl daemon-reload
sudo systemctl enable --now instalead-backend
sudo systemctl status instalead-backend
curl http://127.0.0.1:3002/health
```

Если `.env` или данные были созданы от root, исправьте владельца:

```bash
sudo chown -R instalead:instalead /var/www/instalead/backend/data /var/www/instalead/backend/.env
```

## 6. Nginx и домен

Конфиг использует плейсхолдеры `__DOMAIN__` и `__SERVER_IP__` — их подставляет
`deploy.ps1`. Для ручной установки:

```bash
sudo sed "s|__DOMAIN__|example.com|g; s|__SERVER_IP__|203.0.113.10|g" \
  /var/www/instalead/deploy/nginx.instalead.conf \
  | sudo tee /etc/nginx/sites-available/instalead
sudo ln -s /etc/nginx/sites-available/instalead /etc/nginx/sites-enabled/instalead
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Проверьте `http://YOUR_DOMAIN`, затем включите HTTPS:

```bash
sudo certbot --nginx -d YOUR_DOMAIN -d www.YOUR_DOMAIN
sudo certbot renew --dry-run
```

> **HTTPS живёт отдельным конфигом.** После выпуска сертификата добавьте
> `deploy/nginx-tls.instalead.conf` — в основном конфиге блока `listen 443`
> нет, и без этого nginx перестанет слушать 443. Если домен за Cloudflare,
> посетители получат 521, хотя бэкенд будет полностью здоров. Именно это и
> делает автоматический `deploy.ps1`: он ставит TLS-блок сам, когда
> сертификат уже есть, и не трогает nginx, если `nginx -t` не проходит.
>
> ```bash
> sudo sed "s|__DOMAIN__|example.com|g" /var/www/instalead/deploy/nginx-tls.instalead.conf \
>   | sudo tee /etc/nginx/sites-available/instalead-tls
> sudo ln -s /etc/nginx/sites-available/instalead-tls /etc/nginx/sites-enabled/instalead-tls
> sudo nginx -t && sudo systemctl reload nginx
> ```

После HTTPS проверьте, что в `.env` стоит `CORS_ORIGINS=https://YOUR_DOMAIN` и `COOKIE_SECURE=true`, затем:

```bash
sudo systemctl restart instalead-backend
```

## 7. Chrome extension

Текущая extension жёстко использует `http://localhost:3002`. Для удалённого сервера нужно перед релизом заменить API URL в:

- `extension/background.js`;
- `extension/content.js`;
- `extension/popup.js`.

Используйте `https://YOUR_DOMAIN/api`, затем заново загрузите папку extension в `chrome://extensions`. Не открывайте backend-порт `3002` наружу. Для автоматической замены URL из корня проекта можно выполнить:

```bash
chmod +x deploy/configure-extension.sh
deploy/configure-extension.sh ./extension https://YOUR_DOMAIN
```

Скрипт изменяет копию extension. Сохраните локальный вариант для разработки или повторно настройте его на `http://localhost:3002` при необходимости.

## 8. Обновление проекта

```bash
cd /var/www/instalead
git pull
cd backend && npm ci
cd ../frontend && npm ci && npm run build
sudo chown -R instalead:instalead /var/www/instalead
sudo systemctl restart instalead-backend
sudo systemctl reload nginx
```

Перед обновлением базы:

```bash
sudo tar -czf /root/instalead-backup-$(date +%F-%H%M).tar.gz /var/www/instalead/backend/data
```

## 9. Диагностика

```bash
sudo journalctl -u instalead-backend -f
sudo nginx -t
curl -I https://YOUR_DOMAIN
curl https://YOUR_DOMAIN/health
```

Частые причины проблем: DNS ещё не обновился, `CORS_ORIGINS` не совпадает с адресом браузера, `.env` недоступен пользователю systemd, frontend не пересобран, extension всё ещё смотрит на localhost.
