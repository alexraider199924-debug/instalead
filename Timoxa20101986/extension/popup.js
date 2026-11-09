const API_BASE_PROD = 'https://instalead.ru/api';
const API_BASE_LOCAL = 'http://localhost:5173/api';
const API_BASE_BACKEND = 'http://localhost:3002/api';
let apiBase = API_BASE_LOCAL;
let currentWorkspace = 'default';
let loggedIn = false;
let extensionToken = '';

async function loadExtensionSession() {
  const data = await chrome.storage.local.get(['iwExtensionToken', 'iwDeviceToken', 'iwApiBase']);
  extensionToken = data.iwExtensionToken || data.iwDeviceToken || '';
  apiBase = [API_BASE_LOCAL, API_BASE_BACKEND, API_BASE_PROD].includes(data.iwApiBase) ? data.iwApiBase : API_BASE_LOCAL;
  loggedIn = !!extensionToken;
}

function authHeaders(extra = {}) {
  return extensionToken ? { ...extra, 'X-Extension-Token': extensionToken } : extra;
}

function wsHeaders() {
  return authHeaders({ 'X-Workspace': currentWorkspace });
}

function showLoginView(message = '') {
  loggedIn = false;
  extensionToken = '';
  currentWorkspace = 'default';
  platformAccount = null;
  document.getElementById('appView').classList.add('hidden');
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('loginEmail').style.display = '';
  document.getElementById('loginPassword').style.display = '';
  document.getElementById('btnLogin').textContent = 'Sign in';
  const status = document.getElementById('pairStatus');
  status.textContent = message;
  status.style.color = message ? '#16a34a' : '';
}

// The server decides who is signed in, not the token sitting in storage. A
// revoked token, or one left behind by an interrupted sign-out, fails here
// instead of silently restoring the previous account. Offline is not a failure:
// a flaky connection must not sign the user out of a still-valid session.
async function verifySession() {
  if (!extensionToken) return;
  let res;
  try {
    res = await fetch(apiBase + '/extension/me', {
      headers: wsHeaders(),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    return; // offline — a flaky connection must not sign the user out
  }
  if (res.status === 401) {
    await chrome.runtime.sendMessage({ type: 'LOGOUT' });
    showLoginView('Session expired. Sign in again.');
    return;
  }
  if (!res.ok) return;
  try {
    platformAccount = await res.json();
    updatePlatformUI(platformAccount);
  } catch {}
}

let refreshInterval;
let countdownInterval;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.source !== 'background') return;
  if (msg.type === 'SENT') addLog('Sent to #' + msg.cl_id, 'success');
  if (msg.type === 'FAILED') addLog('Failed #' + msg.cl_id + ': ' + msg.error, 'error');
  if (msg.type === 'IDLE') addLog(msg.message || 'No tasks');
  refresh();
});

async function checkAPI() {
  try {
    const healthBase = apiBase.replace(/\/api$/, '');
    const res = await fetch(`${healthBase}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getQueueSize() {
  try {
    const res = await fetch(`${apiBase}/extension/status`, { headers: wsHeaders() });
    const data = await res.json();
    return data.total_pending || 0;
  } catch {
    return '-';
  }
}

function updateAccountUI(username) {
  const usernameEl = document.getElementById('accountUsername');
  const dotEl = document.getElementById('igStatusDot');
  const textEl = document.getElementById('igStatusText');
  const avatarLetter = document.getElementById('avatarLetter');

  if (username) {
    usernameEl.textContent = '@' + username;
    dotEl.className = 'dot';
    textEl.textContent = 'Connected';
    avatarLetter.textContent = username[0].toUpperCase();
  } else {
    usernameEl.textContent = 'Not connected';
    dotEl.className = 'dot';
    dotEl.style.background = '#c8c8d0';
    textEl.textContent = 'Open Instagram';
    avatarLetter.textContent = '?';
  }
}

let platformAccount = null;

// Platform identity is resolved from the token, never from local storage: only
// the server can say which account is actually signed in.
function updatePlatformUI(me) {
  const emailEl = document.getElementById('accountEmail');
  if (!emailEl) return;
  emailEl.textContent = me && me.email ? me.email : 'Signed in';
  emailEl.title = me && me.email ? me.email : '';
}

function updateCountdown(nextMessageAt) {
  const box = document.getElementById('countdownBox');
  if (!box) return;
  const timeEl = document.getElementById('countdownTime');
  const subEl = document.getElementById('countdownSub');

  if (!nextMessageAt) {
    box.className = 'countdown-box';
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    return;
  }

  box.className = 'countdown-box active';

  function tick() {
    const remaining = Math.max(0, Math.floor((nextMessageAt - Date.now()) / 1000));
    if (remaining <= 0) {
      timeEl.textContent = '00:00';
      subEl.textContent = 'Sending now...';
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      return;
    }
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    timeEl.textContent = String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    subEl.textContent = 'Random delay for safety';
  }

  tick();
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(tick, 1000);
}

function updateOpenButton() {
  const btn = document.getElementById('btnOpen');
  // refresh() runs every 3s and a single missing element here used to throw
  // and take the whole popup — including the Instagram status — down with it.
  if (!btn) return;
  btn.href = 'https://instalead.ru';
}

async function refresh() {
  const bgState = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (!loggedIn) {
    document.getElementById('loginView').classList.remove('hidden');
    document.getElementById('appView').classList.add('hidden');
    return;
  }
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  currentWorkspace = bgState.workspace || 'default';
  updateOpenButton();

  updateAccountUI(bgState.igUsername || null);

  document.getElementById('statSent').textContent = bgState.stats?.sent ?? 0;
  document.getElementById('statFailed').textContent = bgState.stats?.failed ?? 0;

  const statusEl = document.getElementById('campaignStatus');
  const dotEl = document.getElementById('csDot');
  const textEl = document.getElementById('csText');
  const btnRow = document.getElementById('btnRow');

  if (bgState.running) {
    statusEl.className = 'campaign running';
    dotEl.className = 'dot';
    textEl.className = '';
    textEl.textContent = 'Campaign running';
    btnRow.innerHTML = '<button class="action" data-action="pause">Pause</button>';
  } else if (bgState.paused) {
    statusEl.className = 'campaign';
    dotEl.className = 'dot';
    dotEl.style.background = '#d97706';
    textEl.className = '';
    textEl.textContent = 'Paused';
    btnRow.innerHTML = '<button class="action" data-action="start">Resume</button>';
  } else {
    statusEl.className = 'campaign';
    dotEl.className = 'dot';
    dotEl.style.background = '#c8c8d0';
    textEl.className = '';
    textEl.textContent = 'Idle';
    btnRow.innerHTML = '<button class="action" data-action="start">Start campaign</button>';
  }

  const queue = await getQueueSize();
  document.getElementById('statQueue').textContent = queue;
}

async function handleStart() {
  const apiOk = await checkAPI();
  if (!apiOk) {
    addLog('Server unavailable', 'error');
    return;
  }
  await chrome.runtime.sendMessage({ type: 'START' });
  addLog('Campaign started');
  await refresh();
}

async function handlePause() {
  await chrome.runtime.sendMessage({ type: 'PAUSE' });
  addLog('Paused');
  await refresh();
}

async function handleReset() {
  if (!confirm('Reset statistics and stop campaign?')) return;
  await chrome.runtime.sendMessage({ type: 'RESET' });
  document.getElementById('logContainer').innerHTML = '<div class="log-entry">Reset</div>';
  await refresh();
}

async function handleRefresh() {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (tabs.length > 0) {
    await chrome.tabs.reload(tabs[0].id);
    addLog('Refreshing Instagram...');
  } else {
    addLog('No Instagram tab found', 'error');
  }
  setTimeout(refresh, 3000);
}

function addLog(msg, type = '') {
  const log = document.getElementById('logContainer');
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  const time = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = '[' + time + '] ' + msg;
  log.prepend(entry);
  while (log.children.length > 20) log.removeChild(log.lastChild);
}

async function loginExtension() {
  const btn = document.getElementById('btnLogin');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const status = document.getElementById('pairStatus');
  if (!email || !password) {
    status.textContent = 'Enter email and password';
    status.style.color = '#dc2626';
    btn.disabled = false; btn.textContent = 'Sign in';
    return;
  }
  try {
    // Keep every async login step inside the same error boundary. If the
    // background service worker is temporarily unavailable, the button must
    // return to an actionable state instead of looking like it did nothing.
    const bg = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    const candidates = [apiBase, ...[API_BASE_LOCAL, API_BASE_BACKEND, API_BASE_PROD].filter(base => base !== apiBase)];
    let res = null;
    let data = {};
    let lastError = null;
    for (const base of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        res = await fetch(base + '/extension/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, username: bg?.igUsername || null }),
          signal: controller.signal
        });
        data = {};
        try { data = await res.json(); } catch {}
        if (res.ok && data.token) {
          apiBase = base;
          await chrome.storage.local.set({ iwApiBase: apiBase });
          try { await chrome.runtime.sendMessage({ type: 'SET_API_BASE', apiBase }); } catch {}
          break;
        }
        lastError = new Error(data.error || 'Login failed (' + res.status + ')');
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
      res = null;
    }
    if (!res || !res.ok || !data.token) {
      if (lastError?.name === 'AbortError') throw new Error('Timeout — servers not responding');
      throw lastError || new Error('Login failed');
    }
    extensionToken = data.token;
    loggedIn = true;
    await chrome.storage.local.set({ iwExtensionToken: data.token, iwDeviceToken: data.token, iwWorkspace: data.workspace, iwApiBase: apiBase });
    await chrome.runtime.sendMessage({ type: 'SET_DEVICE_TOKEN', token: data.token });
    currentWorkspace = data.workspace;
    platformAccount = { ...(data.user || {}), workspace: data.workspace };
    updatePlatformUI(platformAccount);
    status.textContent = 'Connected';
    status.style.color = '#16a34a';
    document.getElementById('loginEmail').style.display = 'none';
    document.getElementById('loginPassword').style.display = 'none';
    document.getElementById('btnLogin').textContent = 'Logged in';
    // Login is already successful at this point. A non-critical UI refresh
    // must not turn a successful authentication into a visible login failure.
    try {
      await refresh();
    } catch (refreshError) {
      console.warn('[Instalead] post-login refresh failed:', refreshError);
    }
    btn.disabled = true;
  } catch (e) {
    status.textContent = e.name === 'AbortError'
      ? 'Timeout — servers not responding'
      : (e?.message || 'Login failed');
    status.style.color = '#dc2626';
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

async function pairExtension() {
  const input = document.getElementById('pairCode');
  const status = document.getElementById('pairStatus');
  if (!input || !status) return;
  const code = input.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    status.textContent = 'Enter the 8-character code from Instalead';
    status.style.color = '#dc2626';
    return;
  }
  const bg = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (!bg?.igUsername) {
    status.textContent = 'Open Instagram and wait for account detection first';
    status.style.color = '#dc2626';
    return;
  }
  try {
    const res = await fetch(apiBase + '/extension/pair/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, username: bg.igUsername })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Pairing failed');
    await chrome.storage.local.set({ iwExtensionToken: data.token, iwDeviceToken: data.token, iwWorkspace: data.workspace, iwApiBase: apiBase });
    await chrome.runtime.sendMessage({ type: 'SET_DEVICE_TOKEN', token: data.token });
    extensionToken = data.token;
    loggedIn = true;
    status.textContent = 'Paired securely with Instalead';
    status.style.color = '#16a34a';
    currentWorkspace = data.workspace;
    await refresh();
  } catch (e) {
    status.textContent = e.message;
    status.style.color = '#dc2626';
  }
}

async function handleLogout() {
  if (!confirm('Sign out of Instalead on this device?')) return;
  // Revoke server-side first. If the network call fails we still clear local
  // state — the token stays valid until it expires, but the user asked to leave
  // and leaving the UI populated would be worse than a lingering token.
  try {
    if (extensionToken) {
      await fetch(apiBase + '/extension/logout', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' })
      });
    }
  } catch (e) {
    addLog('Server unreachable, signed out locally only', 'error');
  }
  await chrome.runtime.sendMessage({ type: 'LOGOUT' });
  showLoginView('Signed out');
  await refresh();
}

document.getElementById('btnLogin').addEventListener('click', loginExtension);
document.getElementById('btnRow').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'start') await handleStart();
  if (btn.dataset.action === 'pause') await handlePause();
});

document.getElementById('btnReset').addEventListener('click', handleReset);
document.getElementById('btnRefresh').addEventListener('click', handleRefresh);
document.getElementById('btnLogout').addEventListener('click', handleLogout);

loadExtensionSession().then(() => { verifySession(); checkAPI(); refresh(); });
refreshInterval = setInterval(refresh, 3000);
window.addEventListener('unload', () => {
  clearInterval(refreshInterval);
  if (countdownInterval) clearInterval(countdownInterval);
});
