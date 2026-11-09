# 🐛 InstaWorm — Instagram Cold Outreach Platform

Платформа для холодных рассылок в Instagram с AI-генерацией сообщений и браузерным расширением.

---

## Быстрый старт

```bash
./start.sh
```

- **Дашборд**: http://localhost:5173
- **API**: http://localhost:3001

---

## Структура проекта

```
├── backend/          # Node.js + Express + SQLite
├── frontend/         # React + Vite + Tailwind CSS
├── extension/        # Chrome Extension (MV3)
├── sample-leads.csv  # Пример файла лидов
└── start.sh          # Скрипт запуска
```

---

## Функции

### Управление лидами
- Добавление по одному через форму
- Импорт из CSV / Excel (`.csv`, `.xlsx`, `.xls`)
- Поиск, фильтрация по статусу
- Массовое удаление

**Формат CSV:**
```csv
username,full_name,email,niche,bio,notes
fitness_ivan,Иван Иванов,ivan@example.com,Фитнес,,
```
> Обязательная колонка: `username` (или `instagram`, `handle`)

### Кампании
- Создание кампании с выбором лидов
- Шаблон сообщения + AI-генерация
- Планирование запуска по времени
- Управление (старт / пауза / архив)
- Прогресс в реальном времени

### AI Генерация сообщений
- **Claude** (Anthropic) — рекомендуется
- **OpenAI GPT-4o-mini**
- Персонализация под каждого лида (`generate-bulk`)

### Браузерное расширение
Автоматически открывает Instagram DM и отправляет сообщения лидам из очереди.

**Установка:**
1. Откройте `chrome://extensions`
2. Включите **Режим разработчика**
3. Нажмите **"Загрузить распакованное расширение"**
4. Выберите папку `./extension`

**Использование:**
1. Запустите кампанию в дашборде
2. Нажмите кнопку расширения в Chrome
3. Нажмите **Запустить** — расширение начнёт отправлять DM

---

## Настройка AI ключей

Перейдите в **Настройки** и добавьте API ключи:

| Провайдер | Где получить |
|-----------|-------------|
| Claude | [console.anthropic.com](https://console.anthropic.com) |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) |

---

## Стек

- **Backend**: Node.js · Express · SQLite · node-cron
- **Frontend**: React 18 · Vite · Tailwind CSS · Recharts
- **AI**: Anthropic Claude · OpenAI GPT
- **Extension**: Chrome MV3

> Рекомендуемая задержка между сообщениями: **30-60 секунд**.