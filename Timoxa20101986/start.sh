#!/bin/bash

echo "🐛 InstaWorm — Starting..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js не установлен. Установите Node.js 18+"
    exit 1
fi

# Install deps if needed
if [ ! -d "backend/node_modules" ]; then
    echo "📦 Устанавливаем зависимости бэкенда..."
    cd backend && npm install && cd ..
fi

if [ ! -d "frontend/node_modules" ]; then
    echo "📦 Устанавливаем зависимости фронтенда..."
    cd frontend && npm install && cd ..
fi

# Start backend
echo "🚀 Запускаем Backend (порт 3002)..."
cd backend && node src/index.js &
BACKEND_PID=$!
cd ..

sleep 2

# Start frontend dev server
echo "🌐 Запускаем Frontend (порт 5173)..."
cd frontend && npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "✅ InstaWorm запущен!"
echo "   Дашборд:  http://localhost:5173"
echo "   API:      http://localhost:3002"
echo ""
echo "📌 Для браузерного расширения:"
echo "   1. Откройте chrome://extensions"
echo "   2. Включите 'Режим разработчика'"
echo "   3. 'Загрузить распакованное расширение' → папка ./extension"
echo ""
echo "Нажмите Ctrl+C для остановки"

# Wait and cleanup
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo ''; echo 'Остановлено.'" INT TERM
wait
