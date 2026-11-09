import React, { useState, useEffect, useRef } from 'react';
import {
  Save, CheckCircle, Settings as SettingsIcon, Download, Upload, RotateCcw,
  Database, Clock, Send, Copy, Unlink, RefreshCw
} from 'lucide-react';
import api from '../utils/api.js';
import { getCurrentWorkspace } from '../utils/api.js';

export default function Settings() {
  const [form, setForm] = useState({
    app_name: 'Instalead',
    currency: 'USD',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/settings').then(s => {
      setForm(f => ({
        ...f,
        app_name: s.app_name || 'Instalead',
        currency: s.currency || 'USD',
      }));
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put('/settings', form);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e.error || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-full text-gray-400">Loading...</div>;

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-3 rounded-xl bg-orange-50 text-orange-600">
          <SettingsIcon size={24} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-gray-500 text-sm">Workspace preferences and configuration.</p>
        </div>
      </div>

      {error && (
        <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-6">{error}</div>
      )}
      {saved && (
        <div className="text-green-600 text-sm bg-green-50 border border-green-200 rounded-lg px-4 py-3 flex items-center gap-2 mb-6">
          <CheckCircle size={15} /> Settings saved successfully.
        </div>
      )}

      <div class="card mb-6">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Интеграции</h2>
        <div class="space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Обогащение профилей</label>
            <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-orange-100 text-orange-800 border border-orange-300">
              DOM парсинг через браузер
            </div>
            <p className="text-xs text-gray-500 mt-2">Профили читаются только через DOM открытого Instagram. API-обогащение отключено.</p>
          </div>
        </div>
      </div>

      <div className="card mb-6">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Chrome Extension</h2>
        <p className="text-sm text-gray-600 mb-4">
          Install the Instalead Chrome extension to enable automatic message sending through Instagram.
        </p>
        <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm text-gray-600">
          <div className="font-medium text-gray-700 mb-2">Installation steps:</div>
          <div>1. Open <span className="font-mono text-orange-600 text-xs">chrome://extensions</span> in your browser</div>
          <div>2. Enable <span className="font-medium text-gray-800">Developer mode</span> (top-right toggle)</div>
          <div>3. Click <span className="font-medium text-gray-800">Load unpacked</span></div>
          <div>4. Select the <span className="font-mono text-orange-600 text-xs">/extension</span> folder from the project</div>
        </div>
        <div className="mt-3 bg-gray-50 rounded-lg p-3 text-xs">
          <div className="text-gray-500 mb-1">API endpoint for extension:</div>
          <div className="text-orange-600 font-mono">http://localhost:3002/api/extension/queue</div>
        </div>
      </div>

      <div className="flex justify-end mb-8">
        <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center gap-2">
          <Save size={15} /> {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      <TelegramSection />

      <BackupSection />
    </div>
  );
}

function TelegramSection() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = () => {
    api.get('/telegram/status')
      .then(setStatus)
      .catch(e => setErr(e.error || 'Не удалось получить статус Телеграма'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // The code is short-lived, so the countdown is not decoration — it tells the
  // user whether the code in front of them still works.
  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (!code) return;
    const tick = () => {
      const left = Math.max(0, Math.round((new Date(code.expires_at) - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setCode(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [code]);

  const handleGenerate = async () => {
    setGenerating(true);
    setErr('');
    setMsg('');
    try {
      const out = await api.post('/telegram/link-code');
      setCode(out);
    } catch (e) {
      setErr(e.error || 'Не удалось создать код');
    } finally {
      setGenerating(false);
    }
  };

  const handleUnlink = async (telegramId) => {
    if (!confirm('Отвязать этот чат? Он потеряет доступ к рабочему пространству.')) return;
    setErr('');
    try {
      await api.delete(`/telegram/links/${telegramId}`);
      setMsg('Чат отвязан.');
      load();
    } catch (e) {
      setErr(e.error || 'Не удалось отвязать');
    }
  };

  const botName = status?.bot?.username;

  return (
    <div className="card mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Send size={18} className="text-orange-500" />
        <h2 className="text-sm font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Телеграм</h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Управляйте кампаниями, поиском лидов и входящими сообщениями прямо из Телеграма.
        Бот ставит задачи в очередь — выполняет их по-прежнему расширение Chrome, поэтому оно должно быть запущено.
      </p>

      {err && (
        <div className="text-sm bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4 text-red-700 dark:text-red-300">
          {err}
        </div>
      )}
      {msg && (
        <div className="text-sm bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 mb-4 text-blue-700 dark:text-blue-300">
          {msg}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Загрузка…</p>
      ) : !status?.enabled ? (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 text-sm text-gray-600 dark:text-gray-400">
          <div className="font-medium text-gray-700 dark:text-gray-300 mb-2">Бот не настроен на сервере</div>
          Создайте бота у <span className="font-mono text-orange-600 text-xs">@BotFather</span>, добавьте токен в{' '}
          <span className="font-mono text-orange-600 text-xs">backend/.env</span> как{' '}
          <span className="font-mono text-orange-600 text-xs">TELEGRAM_BOT_TOKEN</span> и перезапустите сервер.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-4 text-sm">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-gray-700 dark:text-gray-300">
              Бот активен{botName ? <> — <span className="font-mono text-orange-600">@{botName}</span></> : ''}
            </span>
          </div>

          {code ? (
            <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4 mb-4">
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                Отправьте этот код боту{botName ? ` @${botName}` : ''} командой /start:
              </div>
              <div className="flex items-center gap-3">
                <span className="text-3xl font-bold tracking-[0.3em] text-orange-600 font-mono">{code.code}</span>
                <button
                  onClick={() => navigator.clipboard?.writeText(code.code)}
                  className="text-gray-400 hover:text-orange-600"
                  title="Скопировать"
                >
                  <Copy size={16} />
                </button>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Действует ещё {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
              </div>
            </div>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="btn-primary flex items-center gap-2 text-sm mb-4"
            >
              <Send size={15} /> {generating ? 'Создаю…' : 'Подключить Телеграм'}
            </button>
          )}

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Привязанные чаты</h3>
              <button onClick={load} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex items-center gap-1">
                <RefreshCw size={12} /> Обновить
              </button>
            </div>
            {!status.links?.length ? (
              <p className="text-sm text-gray-400">Пока никто не подключён.</p>
            ) : (
              <div className="space-y-2">
                {status.links.map(l => (
                  <div key={l.telegram_id} className="flex items-center justify-between bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
                    <div className="text-sm text-gray-700 dark:text-gray-300">
                      {l.username ? `@${l.username}` : `ID ${l.telegram_id}`}
                      <span className="text-xs text-gray-400 ml-2">
                        {new Date(l.linked_at).toLocaleDateString('ru-RU')}
                      </span>
                    </div>
                    <button
                      onClick={() => handleUnlink(l.telegram_id)}
                      className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1"
                    >
                      <Unlink size={12} /> Отвязать
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function BackupSection() {
  const [backups, setBackups] = useState([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoring, setRestoring] = useState(null);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);

  const loadBackups = () => {
    setLoadingBackups(true);
    api.get('/settings/backups')
      .then(d => setBackups(d.backups || []))
      .catch(() => {})
      .finally(() => setLoadingBackups(false));
  };

  useEffect(() => { loadBackups(); }, []);

  const handleExport = () => {
    const ws = getCurrentWorkspace();
    const a = document.createElement('a');
    a.href = `/api/settings/export`;
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/settings/export');
    xhr.setRequestHeader('X-Workspace', ws);
    xhr.responseType = 'blob';
    xhr.onload = () => {
      if (xhr.status === 200) {
        const url = URL.createObjectURL(xhr.response);
        const a = document.createElement('a');
        a.href = url;
        a.download = `instalead_${ws}_${new Date().toISOString().slice(0, 10)}.db`;
        a.click();
        URL.revokeObjectURL(url);
      }
    };
    xhr.send();
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setMsg('');
    try {
      const formData = new FormData();
      formData.append('database', file);
      const ws = getCurrentWorkspace();
      const res = await fetch('/api/settings/import', {
        method: 'POST',
        headers: { 'X-Workspace': ws },
        body: formData
      });
      const data = await res.json();
      if (res.ok) {
        setMsg('Data restored from uploaded file. Reloading...');
        setTimeout(() => window.location.reload(), 1500);
      } else {
        setMsg(data.error || 'Import failed');
      }
    } catch (err) {
      setMsg('Import failed: ' + err.message);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleRestore = async (filename) => {
    if (!confirm('Restore from this backup? Current data will be backed up first.')) return;
    setRestoring(filename);
    setMsg('');
    try {
      await api.post(`/settings/backups/${filename}/restore`);
      setMsg('Restored successfully. Reloading...');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setMsg(err.error || 'Restore failed');
    } finally {
      setRestoring(null);
    }
  };

  const formatDate = (filename) => {
    const m = filename.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return filename;
    return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6]}`;
  };

  return (
    <div className="card mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Database size={18} className="text-orange-500" />
        <h2 className="text-sm font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Data & Backups</h2>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        All data for your account is automatically backed up every hour. You can also manually export/import your data.
      </p>

      {msg && (
        <div className="text-sm bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 mb-4 text-blue-700 dark:text-blue-300">
          {msg}
        </div>
      )}

      <div className="flex gap-3 mb-6">
        <button onClick={handleExport} className="btn-primary flex items-center gap-2 text-sm">
          <Download size={15} /> Export Data
        </button>
        <label className={`btn-secondary flex items-center gap-2 text-sm cursor-pointer ${importing ? 'opacity-50 pointer-events-none' : ''}`}>
          <Upload size={15} /> {importing ? 'Importing...' : 'Import Data'}
          <input ref={fileRef} type="file" accept=".db" onChange={handleImport} className="hidden" />
        </label>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Auto-backups</h3>
          <button onClick={loadBackups} disabled={loadingBackups} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            Refresh
          </button>
        </div>
        {backups.length === 0 ? (
          <p className="text-sm text-gray-400">No backups yet. They are created automatically every hour.</p>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {backups.map(b => (
              <div key={b.filename} className="flex items-center justify-between bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <Clock size={14} className="text-gray-400" />
                  <span className="text-sm text-gray-700 dark:text-gray-300">{formatDate(b.filename)}</span>
                </div>
                <button
                  onClick={() => handleRestore(b.filename)}
                  disabled={restoring === b.filename}
                  className="text-xs text-orange-600 hover:text-orange-700 dark:text-orange-400 flex items-center gap-1"
                >
                  <RotateCcw size={12} />
                  {restoring === b.filename ? 'Restoring...' : 'Restore'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
