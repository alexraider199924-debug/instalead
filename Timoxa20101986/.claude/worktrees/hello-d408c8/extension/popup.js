const API_BASE = 'http://localhost:3001/api';

let refreshInterval;

// Listen for messages from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.source !== 'background') return;
  if (msg.type === 'SENT') addLog(`✅ Отправлено лиду #${msg.cl_id}`, 'success');
  if (msg.type === 'FAILED') addLog(`❌ Ошибка для #${msg.cl_id}: ${msg.error}`, 'error');
  if (msg.type === 'IDLE') addLog(msg.message || 'Нет задач');
  refresh();
});

async function checkAPI() {
  try {
    const res = await fetch(`${API_BASE}/../health`, { signal: AbortSignal.timeout(3000) });
    const ok = res.ok;
    document.getElementById('apiDot').className = ok ? 'api-dot ok' : 'api-dot';
    document.getElementById('apiStatus').textContent = ok ? 'Сервер подключён' : 'Сервер недоступен';
    return ok;
  } catch {
    document.getElementById('apiDot').className = 'api-dot';
    document.getElementById('apiStatus').textContent = 'Сервер недоступен (localhost:3001)';
    return false;
  }
}

async function getQueueSize() {
  try {
    const res = await fetch(`${API_BASE}/extension/status`);
    const data = await res.json();
    return data.total_pending || 0;
  } catch {
    return '—';
  }
}

function updateAccountUI(username) {
  const usernameEl = document.getElementById('accountUsername');
  const dotEl = document.getElementById('igStatusDot');
  const textEl = document.getElementById('igStatusText');
  const avatarEmoji = document.getElementById('avatarEmoji');

  if (username) {
    usernameEl.textContent = '@' + username;
    usernameEl.className = 'account-username';
    dotEl.className = 'status-dot green';
    textEl.textContent = 'Готово к работе';
    textEl.className = 'status-text green';
    // Show first letter as avatar
    avatarEmoji.textContent = username[0].toUpperCase();
    avatarEmoji.style.fontFamily = 'sans-serif';
    avatarEmoji.style.fontSize = '18px';
  } else {
    usernameEl.textContent = 'Аккаунт не найден';
    usernameEl.className = 'account-username dimmed';
    dotEl.className = 'status-dot gray';
    textEl.textContent = 'Откройте Instagram в браузере';
    textEl.className = 'status-text gray';
    avatarEmoji.textContent = '👤';
    avatarEmoji.style.fontSize = '16px';
  }
}

async function refresh() {
  const bgState = await chrome.runtime.sendMessage({ type: 'GET_STATE' });

  // Account display
  updateAccountUI(bgState.igUsername || null);

  // Stats
  document.getElementById('statSent').textContent = bgState.stats?.sent ?? 0;
  document.getElementById('statFailed').textContent = bgState.stats?.failed ?? 0;

  // Running status badge
  const badge = document.getElementById('runningBadge');
  const rdot = document.getElementById('rdot');
  const text = document.getElementById('runningText');
  const btnRow = document.getElementById('btnRow');

  if (bgState.running) {
    badge.className = 'running-badge badge-running';
    rdot.className = 'rdot pulse';
    text.textContent = 'Рассылка работает';
    btnRow.innerHTML = '<button class="btn btn-pause" onclick="handlePause()">⏸ Пауза</button>';
  } else if (bgState.paused) {
    badge.className = 'running-badge badge-paused';
    rdot.className = 'rdot';
    text.textContent = 'На паузе';
    btnRow.innerHTML = '<button class="btn btn-start" onclick="handleStart()">▶ Продолжить</button>';
  } else {
    badge.className = 'running-badge badge-idle';
    rdot.className = 'rdot';
    text.textContent = 'Ожидание';
    btnRow.innerHTML = '<button class="btn btn-start" onclick="handleStart()">▶ Запустить рассылку</button>';
  }

  // Current item
  const ci = bgState.currentItem;
  const ciEl = document.getElementById('currentItem');
  if (ci) {
    ciEl.className = 'current-item active';
    document.getElementById('ciUsername').textContent = '@' + ci.username;
    document.getElementById('ciMessage').textContent = ci.message || '...';
  } else {
    ciEl.className = 'current-item';
  }

  // Queue size
  const queue = await getQueueSize();
  document.getElementById('statQueue').textContent = queue;
}

async function handleStart() {
  const apiOk = await checkAPI();
  if (!apiOk) {
    addLog('❌ Сервер недоступен. Запустите backend.', 'error');
    return;
  }
  await chrome.runtime.sendMessage({ type: 'START' });
  addLog('▶ Рассылка запущена');
  await refresh();
}

async function handlePause() {
  await chrome.runtime.sendMessage({ type: 'PAUSE' });
  addLog('⏸ Поставлено на паузу');
  await refresh();
}

async function handleReset() {
  if (!confirm('Сбросить статистику и остановить рассылку?')) return;
  await chrome.runtime.sendMessage({ type: 'RESET' });
  document.getElementById('logContainer').innerHTML = '<div class="log-entry">Сброшено</div>';
  await refresh();
}

function addLog(msg, type = '') {
  const log = document.getElementById('logContainer');
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = `[${time}] ${msg}`;
  log.prepend(entry);
  while (log.children.length > 20) log.removeChild(log.lastChild);
}

// Init
checkAPI();
refresh();
refreshInterval = setInterval(refresh, 3000);
window.addEventListener('unload', () => clearInterval(refreshInterval));
