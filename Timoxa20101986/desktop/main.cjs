const { app, BrowserWindow, shell, dialog, ipcMain, session, safeStorage } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');

let backend = null;
let mainWindow = null;
const profileWindows = new Map();
const proxyLoginHandlers = new Map();
const proxyCredentialsBySession = new Map();
let profilesFile = null;
const PORT = Number(process.env.PORT || 3002);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DEV_URL = 'http://127.0.0.1:5173';
const IS_DEV = process.argv.includes('--dev');

function readProfiles() {
  try { return JSON.parse(fs.readFileSync(profilesFile, 'utf8')); }
  catch { return []; }
}
function writeProfiles(items) {
  fs.mkdirSync(path.dirname(profilesFile), { recursive: true });
  const temp = `${profilesFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(items, null, 2), { mode: 0o600 });
  fs.renameSync(temp, profilesFile);
}
function encryptSecret(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows/macOS secure storage is unavailable.');
  return safeStorage.encryptString(value).toString('base64');
}
function decryptSecret(value) {
  if (!value) return '';
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}
function publicProfile(p) {
  const proxy = p.proxy ? { enabled: !!p.proxy.enabled, type: p.proxy.type, host: p.proxy.host, port: p.proxy.port, authUser: p.proxy.authUser || '', hasAuth: !!p.proxy.authPasswordEncrypted } : { enabled: false };
  return { id: p.id, name: p.name, username: p.username || '', proxy, createdAt: p.createdAt, updatedAt: p.updatedAt };
}
function validateProfileInput(input) {
  const name = String(input?.name || '').trim();
  if (!name || name.length > 60) throw new Error('Укажите название профиля (до 60 символов).');
  const proxy = input.proxy || null;
  if (proxy && proxy.enabled) {
    const type = String(proxy.type || '').toLowerCase();
    const host = String(proxy.host || '').trim();
    const port = Number(proxy.port);
    if (!['http', 'https', 'socks5'].includes(type)) throw new Error('Поддерживаются HTTP, HTTPS и SOCKS5.');
    if (!host || /[\s/@]/.test(host)) throw new Error('Некорректный адрес прокси.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный порт прокси.');
    return { name, username: String(input.username || '').trim().replace(/^@/, ''), proxy: { enabled: true, type, host, port, authUser: String(proxy.authUser || ''), authPasswordEncrypted: encryptSecret(String(proxy.authPassword || '')) } };
  }
  return { name, username: String(input.username || '').trim().replace(/^@/, ''), proxy: { enabled: false } };
}
function getProfileSession(profile) {
  const partition = `persist:instalead-profile-${profile.id}`;
  return session.fromPartition(partition);
}
function configureProfileProxy(profile, ses) {
  const proxy = profile.proxy;
  if (!proxy?.enabled) return ses.setProxy({ mode: 'direct' });
  const scheme = proxy.type === 'https' ? 'https' : proxy.type === 'socks5' ? 'socks5' : 'http';
  const proxyRules = `${scheme}://${proxy.host}:${proxy.port}`;
  return ses.setProxy({ proxyRules, proxyBypassRules: 'localhost;127.0.0.1' }).then(() => {
    proxyCredentialsBySession.set(ses, {
      username: proxy.authUser || '',
      passwordEncrypted: proxy.authPasswordEncrypted || ''
    });
  });
}
app.on('login', (event, webContents, _details, authInfo, callback) => {
  if (!authInfo?.isProxy || !webContents) return;
  const credentials = proxyCredentialsBySession.get(webContents.session);
  if (!credentials?.username) return;
  event.preventDefault();
  callback(credentials.username, decryptSecret(credentials.passwordEncrypted));
});

function registerProfileIpc() {
  ipcMain.handle('profiles:list', () => readProfiles().map(publicProfile));
  ipcMain.handle('profiles:create', (_event, input) => {
    const profiles = readProfiles();
    const clean = validateProfileInput(input);
    const profile = { id: crypto.randomUUID(), ...clean, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    profiles.push(profile); writeProfiles(profiles);
    return publicProfile(profile);
  });
  ipcMain.handle('profiles:update', (_event, input) => {
    const profiles = readProfiles();
    const index = profiles.findIndex(p => p.id === input?.id);
    if (index < 0) throw new Error('Профиль не найден.');
    const clean = validateProfileInput(input);
    if (clean.proxy?.enabled && !clean.proxy.authPasswordEncrypted && profiles[index].proxy?.authPasswordEncrypted) {
      clean.proxy.authPasswordEncrypted = profiles[index].proxy.authPasswordEncrypted;
    }
    for (const [key, openWindow] of profileWindows) {
      if (key.startsWith(`${input.id}:`) && !openWindow.isDestroyed()) openWindow.close();
    }
    profiles[index] = { ...profiles[index], ...clean, updatedAt: new Date().toISOString() };
    writeProfiles(profiles);
    return publicProfile(profiles[index]);
  });
  ipcMain.handle('profiles:delete', async (_event, id) => {
    const profiles = readProfiles();
    const profile = profiles.find(p => p.id === id);
    if (!profile) return { ok: true };
    for (const [key, win] of profileWindows) {
      if (key.startsWith(`${id}:`)) { if (!win.isDestroyed()) win.close(); profileWindows.delete(key); }
    }
    const ses = getProfileSession(profile);
    await ses.clearStorageData();
    await ses.clearCache();
    writeProfiles(profiles.filter(p => p.id !== id));
    return { ok: true };
  });
  ipcMain.handle('profiles:open', async (_event, id, target = 'instagram') => {
    const destinations = { instagram: { url: 'https://www.instagram.com/', title: 'Instagram' }, fingerprint: { url: 'https://aliasmode.com/ru/fingerprint-test/', title: 'Fingerprint Test' } };
    const destination = destinations[target];
    if (!destination) throw new Error('Неизвестный адрес открытия.');
    const profile = readProfiles().find(p => p.id === id);
    if (!profile) throw new Error('Профиль не найден.');
    const windowKey = `${id}:${target}`;
    const existing = profileWindows.get(windowKey);
    if (existing && !existing.isDestroyed()) { existing.focus(); return { ok: true }; }
    const ses = getProfileSession(profile);
    await configureProfileProxy(profile, ses);
    const win = new BrowserWindow({
      width: 1180, height: 820, minWidth: 760, minHeight: 600,
      title: `${destination.title} — ${profile.name}`,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    profileWindows.set(windowKey, win);
    win.on('closed', () => profileWindows.delete(windowKey));
    await win.loadURL(destination.url);
    return { ok: true };
  });
  ipcMain.handle('profiles:test-proxy', async (_event, input) => {
    const clean = validateProfileInput({ name: 'Proxy test', proxy: input });
    const tempSession = session.fromPartition(`instalead-proxy-test-${crypto.randomUUID()}`);
    try {
      await configureProfileProxy({ id: `test-${crypto.randomUUID()}`, proxy: clean.proxy }, tempSession);
      const response = await tempSession.fetch('https://www.instagram.com/', { method: 'HEAD', redirect: 'follow' });
      return { ok: response.ok || response.status < 500, status: response.status };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      await tempSession.clearStorageData();
      await tempSession.clearCache();
    }
  });
}

function healthCheck() {
  return new Promise(resolve => {
    const req = http.get(`${BASE_URL}/health`, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitForBackend(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthCheck()) return true;
    await new Promise(r => setTimeout(r, 350));
  }
  return false;
}

function startBackend() {
  const backendEntry = path.join(app.getAppPath(), 'backend', 'src', 'index.js');
  backend = fork(backendEntry, [], {
    cwd: path.dirname(backendEntry),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CORS_ORIGINS: `${BASE_URL},http://localhost:5173,http://127.0.0.1:5173`,
      NODE_ENV: 'production',
      INSTALEAD_DATA_DIR: path.join(app.getPath('userData'), 'data'),
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: 'ignore',
    execPath: process.execPath
  });
  backend.on('exit', code => {
    if (!app.isQuitting && code !== 0) {
      dialog.showErrorBox('AS-Agency Desktop', `Локальный backend завершился с кодом ${code}.`);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#0b0d12',
    title: 'AS-Agency Desktop',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(BASE_URL) && !(IS_DEV && url.startsWith(DEV_URL))) event.preventDefault();
  });
  mainWindow.loadURL(IS_DEV ? DEV_URL : BASE_URL);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  profilesFile = path.join(app.getPath('userData'), 'profiles.json');
  registerProfileIpc();
  if (!(await healthCheck())) startBackend();
  const ready = await waitForBackend();
  if (!ready) {
    dialog.showErrorBox('Не удалось запустить AS-Agency', 'Локальный сервер не ответил за 30 секунд. Проверьте зависимости и порт 3002.');
    app.quit();
    return;
  }
  if (IS_DEV) {
    const devReady = await new Promise(resolve => {
      const started = Date.now();
      const poll = async () => {
        try { const r = await fetch(DEV_URL); if (r.ok) return resolve(true); } catch {}
        if (Date.now() - started > 30000) return resolve(false);
        setTimeout(poll, 350);
      };
      poll();
    });
    if (!devReady) { dialog.showErrorBox('AS-Agency Desktop', 'Vite frontend не запустился на порту 5173.'); app.quit(); return; }
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (backend && !backend.killed) backend.kill();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
