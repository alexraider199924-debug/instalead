import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, Save, CheckCircle } from 'lucide-react';
import api from '../utils/api.js';

function KeyField({ label, value, onChange, placeholder, hint }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="text-xs text-gray-400 mb-1 block">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          className="input pr-10 font-mono text-sm"
          placeholder={placeholder}
          value={value}
          onChange={e => onChange(e.target.value)}
        />
        <button type="button" onClick={() => setShow(s => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      {hint && <p className="text-xs text-gray-600 mt-1">{hint}</p>}
    </div>
  );
}

export default function Settings() {
  const [form, setForm] = useState({
    anthropic_api_key: '',
    openai_api_key: '',
    default_ai_provider: 'claude',
    app_name: 'InstaWorm'
  });
  const [keyStatus, setKeyStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/settings'),
      api.get('/settings/check-keys')
    ]).then(([s, k]) => {
      setForm(f => ({
        ...f,
        default_ai_provider: s.default_ai_provider || 'claude',
        app_name: s.app_name || 'InstaWorm'
      }));
      setKeyStatus(k);
    }).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = { ...form };
      if (!payload.anthropic_api_key || payload.anthropic_api_key === '***masked***') delete payload.anthropic_api_key;
      if (!payload.openai_api_key || payload.openai_api_key === '***masked***') delete payload.openai_api_key;
      await api.put('/settings', payload);
      const k = await api.get('/settings/check-keys');
      setKeyStatus(k);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e.error || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-full text-gray-600">Загрузка...</div>;

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Настройки</h1>
        <p className="text-gray-500 text-sm mt-1">Конфигурация AI и платформы</p>
      </div>

      {error && <div className="text-red-400 text-sm bg-red-900/20 rounded-lg px-4 py-3">{error}</div>}
      {saved && (
        <div className="text-green-400 text-sm bg-green-900/20 rounded-lg px-4 py-3 flex items-center gap-2">
          <CheckCircle size={15} /> Настройки сохранены
        </div>
      )}

      {/* AI API Keys */}
      <div className="card space-y-4">
        <h2 className="text-base font-semibold text-white">AI Провайдеры</h2>

        <div className="space-y-1">
          <KeyField
            label="Anthropic API Key (Claude)"
            value={form.anthropic_api_key}
            onChange={v => setForm(f => ({ ...f, anthropic_api_key: v }))}
            placeholder={keyStatus.anthropic_api_key ? '••••••• (настроен)' : 'sk-ant-...'}
            hint="Получить ключ: console.anthropic.com"
          />
          <div className={`text-xs flex items-center gap-1 ${keyStatus.anthropic_api_key ? 'text-green-500' : 'text-gray-600'}`}>
            <CheckCircle size={11} /> {keyStatus.anthropic_api_key ? 'Ключ настроен' : 'Ключ не настроен'}
          </div>
        </div>

        <div className="space-y-1">
          <KeyField
            label="OpenAI API Key (GPT)"
            value={form.openai_api_key}
            onChange={v => setForm(f => ({ ...f, openai_api_key: v }))}
            placeholder={keyStatus.openai_api_key ? '••••••• (настроен)' : 'sk-...'}
            hint="Получить ключ: platform.openai.com/api-keys"
          />
          <div className={`text-xs flex items-center gap-1 ${keyStatus.openai_api_key ? 'text-green-500' : 'text-gray-600'}`}>
            <CheckCircle size={11} /> {keyStatus.openai_api_key ? 'Ключ настроен' : 'Ключ не настроен'}
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">AI провайдер по умолчанию</label>
          <select className="input" value={form.default_ai_provider}
            onChange={e => setForm(f => ({ ...f, default_ai_provider: e.target.value }))}>
            <option value="claude">Claude (Anthropic)</option>
            <option value="openai">GPT-4o-mini (OpenAI)</option>
          </select>
        </div>
      </div>

      {/* General */}
      <div className="card space-y-4">
        <h2 className="text-base font-semibold text-white">Общие</h2>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Название приложения</label>
          <input className="input" value={form.app_name}
            onChange={e => setForm(f => ({ ...f, app_name: e.target.value }))} />
        </div>
      </div>

      {/* Extension */}
      <div className="card space-y-3">
        <h2 className="text-base font-semibold text-white">Браузерное расширение</h2>
        <p className="text-sm text-gray-400">
          Установите расширение InstaWorm в Chrome для автоматической отправки сообщений.
        </p>
        <div className="bg-gray-800 rounded-lg p-3 space-y-1 text-xs text-gray-400 font-mono">
          <div># В папке /extension:</div>
          <div>1. Откройте chrome://extensions</div>
          <div>2. Включите "Режим разработчика"</div>
          <div>3. "Загрузить распакованное расширение"</div>
          <div>4. Выберите папку /extension</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-xs">
          <div className="text-gray-500 mb-1">API эндпоинт для расширения:</div>
          <div className="text-brand-400 font-mono">http://localhost:3001/api/extension/queue</div>
        </div>
      </div>

      <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center gap-2">
        <Save size={15} /> {saving ? 'Сохранение...' : 'Сохранить настройки'}
      </button>
    </div>
  );
}
