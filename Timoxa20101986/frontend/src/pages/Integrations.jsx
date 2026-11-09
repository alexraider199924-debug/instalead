import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bot, CheckCircle, Eye, EyeOff, KeyRound,
  Link2, Loader2, MessageSquare, Save, Search, Zap, ExternalLink
} from 'lucide-react';
import api from '../utils/api.js';

// Shortcuts are only a convenience: the field below accepts any OpenRouter
// model id typed by hand (vendor/model), including models added after release.
const MODEL_PRESETS = [
  { id: 'openai/gpt-4o-mini', label: 'OpenAI GPT-4o mini — рекомендуется' },
  { id: 'openai/gpt-4o', label: 'OpenAI GPT-4o' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Anthropic Claude 3.5 Sonnet' },
  { id: 'anthropic/claude-sonnet-4', label: 'Anthropic Claude Sonnet 4' },
  { id: 'google/gemini-2.0-flash-001', label: 'Google Gemini 2.0 Flash' },
  { id: 'stealth/space-bunny-alpha', label: 'Stealth Space Bunny Alpha' }
];

// The three worth a single click — the cheap default, the strongest Sonnet and
// the in-house model. Everything else stays reachable through the datalist.
const QUICK_MODELS = [
  'openai/gpt-4o-mini',
  'anthropic/claude-sonnet-4',
  'stealth/space-bunny-alpha'
];

const MODEL_ID_PATTERN = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;

const FEATURES = [
  { icon: Search, title: 'Lead Finder', desc: 'Квалификация лидов через AI-анализ профилей' },
  { icon: MessageSquare, title: 'Campaigns', desc: 'Персонализация сообщений для каждого лида' },
  { icon: Bot, title: 'Inbox Agent', desc: 'Автоматические ответы на входящие' }
];

// Notice tones mirror the banners on the Settings page, so a saved/errored state
// here reads identically to one anywhere else in the app.
const NOTICE = {
  ok: 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/25 text-green-700 dark:text-green-300',
  error: 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/25 text-red-700 dark:text-red-300',
  info: 'bg-orange-50 dark:bg-orange-500/10 border-orange-200 dark:border-orange-500/25 text-orange-700 dark:text-orange-300'
};

function Notice({ tone, icon: Icon, children }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${NOTICE[tone]}`}>
      <Icon size={15} className="mt-0.5 flex-shrink-0" />
      <span classís="min-w-0 break-words">{children}</span>
    </div>
  );
}

function FeatureItem({ icon: Icon, title, desc }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 p-3">
      <div className="w-8 h-8 rounded-lg bg-orange-50 dark:bg-orange-500/10 flex items-center justify-center flex-shrink-0">
        <Icon size={16} className="text-orange-600 dark:text-orange-400" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{title}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{desc}</div>
      </div>
    </div>
  );
}

function StatusBadge({ connected }) {
  return connected ? (
    <span className="badge-green gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />Подключено
    </span>
  ) : (
    <span className="badge-gray">Не подключено</span>
  );
}

export default function Integrations() {
  const [settings, setSettings] = useState({});
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saveError, setSaveError] = useState('');
  const [modelSaved, setModelSaved] = useState(false);

  // The autosave effect below reads the whole settings object, but only the
  // model should trigger it. A ref keeps that read out of the dependency list,
  // so typing in the API-key field never re-arms the model save.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const lastSavedModel = useRef(undefined);

  useEffect(() => {
    api.get('/settings').then(loaded => {
      setSettings(loaded);
      // What arrives is already the saved state, so it is not a change to save.
      lastSavedModel.current = loaded?.openrouter_model;
    }).catch(console.error);
  }, []);

  // Picking a model is a choice, not a draft: leaving the tab with a model
  // selected but unsaved is how the field kept snapping back to the default on
  // return. The change is committed on its own after a short pause, so the value
  // survives without a button press — and the button is still there for the key.
  useEffect(() => {
    const model = settings.openrouter_model;
    if (!model) return;
    if (model === lastSavedModel.current) return;
    // A half-typed id is not worth sending; it would be rejected and the user
    // would see an error for something they were still in the middle of writing.
    if (!MODEL_ID_PATTERN.test(String(model).trim())) return;

    const timer = setTimeout(async () => {
      try {
        await api.put('/settings', { ...settingsRef.current, openrouter_model: model });
        lastSavedModel.current = model;
        setSaveError('');
        setModelSaved(true);
        setTimeout(() => setModelSaved(false), 2000);
      } catch (e) {
        setSaveError(e?.error || e?.message || 'Не удалось сохранить модель');
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [settings.openrouter_model]);

  const save = async () => {
    setSaving(true);
    setTestResult(null);
    setSaveError('');
    try {
      await api.put('/settings', settings);
      lastSavedModel.current = settings.openrouter_model;
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(e?.error || e?.message || 'Не удалось сохранить настройки');
    }
    setSaving(false);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post('/settings/test-openrouter', {
        openrouter_api_key: settings.openrouter_api_key,
        openrouter_model: settings.openrouter_model
      });
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e?.error || e?.message || 'Не удалось выполнить проверку' });
    }
    setTesting(false);
  };

  const isMasked = settings.openrouter_api_key === '***masked***';
  const hasKey = settings.openrouter_api_key && settings.openrouter_api_key !== '' && settings.openrouter_api_key !== '***masked***';

  const modelValue = settings.openrouter_model || 'openai/gpt-4o-mini';
  const modelTouched = settings.openrouter_model !== undefined && settings.openrouter_model !== '';
  const modelInvalid = modelTouched && !MODEL_ID_PATTERN.test(modelValue.trim());

  const keyValue = isMasked ? '' : (settings.openrouter_api_key || '');

  return (
    <div className="p-6 sm:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-xl bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400">
          <Link2 size={24} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Интеграции</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-0.5">Подключите AI для генерации сообщений</p>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm"
              style={{ backgroundImage: 'var(--accent-gradient)' }}
            >
              <Link2 className="text-white" size={22} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">OpenRouter</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">Один API ключ — доступ к десяткам AI-моделей</p>
            </div>
          </div>
          <StatusBadge connected={hasKey || isMasked} />
        </div>

        <div className="border-t border-gray-100 dark:border-gray-800 my-5" />

        <h3 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
          Где используется
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {FEATURES.map(f => <FeatureItem key={f.title} {...f} />)}
        </div>

        <div className="border-t border-gray-100 dark:border-gray-800 my-5" />

        <h3 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-4">
          Подключение
        </h3>

        <div className="mb-4">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5 block" htmlFor="openrouter-model">
            AI-модель
          </label>
          <input
            id="openrouter-model"
            className={`input font-mono text-sm ${modelInvalid ? 'border-red-400 dark:border-red-500' : ''}`}
            list="openrouter-model-list"
            value={modelValue}
            onChange={e => setSettings(prev => ({ ...prev, openrouter_model: e.target.value }))}
            placeholder="vendor/model — например stealth/space-bunny-alpha"
            spellCheck={false}
          />
          <datalist id="openrouter-model-list">
            {MODEL_PRESETS.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </datalist>

          <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
            {QUICK_MODELS.map(id => {
              const active = modelValue.trim() === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSettings(prev => ({ ...prev, openrouter_model: id }))}
                  className={`font-mono text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                    active
                      ? 'border-orange-300 dark:border-orange-500/40 bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-300'
                      : 'border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-200'
                  }`}
                >
                  {id}
                </button>
              );
            })}
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2.5">
            Можно выбрать из списка или вписать любой ID модели OpenRouter в формате <code className="font-mono text-gray-600 dark:text-gray-300">vendor/model</code>.
            Если модель вернула 403, попробуйте другую модель или другой ключ и нажмите «Проверить».
          </p>
          {modelInvalid && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-2 flex items-center gap-1">
              <AlertTriangle size={12} /> Некорректный ID модели: ожидается vendor/model
            </p>
          )}
        </div>

        <div className="mb-5">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5 block" htmlFor="openrouter-key">
            API-ключ
          </label>
          <div className="relative">
            <input
              id="openrouter-key"
              type={showKey ? 'text' : 'password'}
              className="input font-mono text-sm pr-11"
              value={keyValue}
              onChange={e => setSettings(prev => ({ ...prev, openrouter_api_key: e.target.value }))}
              placeholder={isMasked ? '•••••••••••••••• — ключ сохранён' : 'sk-or-...'}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title={showKey ? 'Скрыть ключ' : 'Показать ключ'}
              aria-label={showKey ? 'Скрыть ключ' : 'Показать ключ'}
            >
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 flex items-center gap-1.5">
            <KeyRound size={12} className="flex-shrink-0" />
            {isMasked
              ? 'Ключ уже сохранён. Введите новый, чтобы заменить его — после сохранения значение снова будет скрыто.'
              : 'Ключ хранится в вашем рабочем пространстве и отправляется только в OpenRouter.'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving || modelInvalid}
            className="btn-primary flex items-center gap-2"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
          <button
            type="button"
            onClick={testConnection}
            disabled={testing || modelInvalid}
            className="btn-secondary flex items-center gap-2 whitespace-nowrap"
          >
            {testing ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
            {testing ? 'Проверяю…' : 'Проверить'}
          </button>
        </div>

        {(testResult || saved || modelSaved || saveError) && (
          <div className="mt-4 space-y-2">
            {saveError && (
              <Notice tone="error" icon={AlertTriangle}>{saveError}</Notice>
            )}
            {testResult && (
              <Notice tone={testResult.ok ? 'ok' : 'error'} icon={testResult.ok ? CheckCircle : AlertTriangle}>
                {testResult.ok
                  ? `Модель ${testResult.model} ответила: ${testResult.reply}`
                  : `Проверка не прошла (${testResult.model || 'модель не задана'}): ${testResult.error}`}
              </Notice>
            )}
            {saved && (
              <Notice tone="ok" icon={CheckCircle}>Настройки OpenRouter сохранены</Notice>
            )}
            {modelSaved && !saved && (
              <Notice tone="ok" icon={CheckCircle}>Модель {modelValue} сохранена и будет использоваться во всех ИИ-функциях</Notice>
            )}
          </div>
        )}

        <div className="mt-6 pt-4 border-t border-gray-100 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
            Обогащение профилей
          </h3>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-orange-100 text-orange-800 border border-orange-300">
            DOM парсинг через браузер
          </div>
          <p className="text-xs text-gray-500 mt-2">Instagram-профили читаются только через DOM открытого браузера. API-обогащение отключено.</p>
        </div>

        <div className="card">
          <h2 className="text-sm font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-4">
            Как получить ключ
          </h2>
          <ol className="space-y-2.5 text-sm text-gray-600 dark:text-gray-300">
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-300 text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">1</span>
              <span>Создайте API-ключ в личном кабинете OpenRouter.</span>
            </li>
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-300 text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">2</span>
              <span>Вставьте ключ в поле «API-ключ» и нажмите «Сохранить».</span>
            </li>
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-300 text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">3</span>
              <span>Нажмите «Проверить» — модель ответит коротким тестовым сообщением.</span>
            </li>
          </ol>
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-600 dark:text-orange-400 hover:underline mt-4"
          >
            Открыть OpenRouter <ExternalLink size={13} />
          </a>
        </div>
      </div>
    </div>
  );
}
