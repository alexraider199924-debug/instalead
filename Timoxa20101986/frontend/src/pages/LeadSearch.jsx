import React, { useState, useEffect, useCallback } from 'react';
import {
  Sparkles, Search, Play, Pause, X, Trash2, AlertTriangle, Clock, Shield,
  RefreshCw, CheckCircle2, Info, Download, UserPlus, MapPin, Hash, Type, Ban,
} from 'lucide-react';
import api, { getCurrentWorkspace } from '../utils/api.js';

const TARGET_PRESETS = [50, 100, 200, 400];
const ENRICH_PRESETS = [0, 50, 100, 200];

const STATUS_MAP = {
  pending: { label: 'Ожидает', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
  running: { label: 'Идёт поиск', cls: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400' },
  paused: { label: 'Приостановлен', cls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' },
  completed: { label: 'Завершён', cls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' },
  failed: { label: 'Ошибка', cls: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400' },
  cancelled: { label: 'Отменён', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-500' },
};

const PHASE_LABELS = {
  discover: 'Поиск кандидатов',
  enrich: 'Сбор био и статистики',
  score: 'Оценка через AI',
  done: 'Готово',
};

const CONFIDENCE_MAP = {
  high: { label: 'точно', cls: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' },
  medium: { label: 'вероятно', cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400' },
  none: { label: 'неизвестно', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-500' },
};

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} мин`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours} ч ${rem} мин` : `${hours} ч`;
}

function formatNumber(n) {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString('ru-RU');
}

function scoreColor(score) {
  if (score === null || score === undefined) return 'text-gray-400';
  if (score >= 80) return 'text-green-600 dark:text-green-400';
  if (score >= 60) return 'text-amber-600 dark:text-amber-400';
  return 'text-gray-400';
}

// Editable list of plan values. The plan is the single biggest lever on result
// quality and the user knows their niche's real hashtags better than a model
// does, so every list stays editable right up until the job starts.
function ChipList({ icon: Icon, label, hint, items, onChange, disabled, accent }) {
  const [draft, setDraft] = useState('');

  function add() {
    const value = draft.trim();
    if (!value) return;
    if (!items.includes(value)) onChange([...items, value]);
    setDraft('');
  }

  return (
    <div>
      <label className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
        <Icon size={12} className={accent} /> {label}
        <span className="normal-case tracking-normal text-gray-400">— {hint}</span>
      </label>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {items.map(item => (
          <span
            key={item}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
          >
            {item}
            {!disabled && (
              <button onClick={() => onChange(items.filter(i => i !== item))} className="text-gray-400 hover:text-red-500">
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        {items.length === 0 && <span className="text-xs text-gray-400">пусто</span>}
      </div>
      {!disabled && (
        <input
          className="input text-xs py-1.5"
          placeholder="Добавить и нажать Enter"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          onBlur={add}
        />
      )}
    </div>
  );
}

export default function LeadSearch() {
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [target, setTarget] = useState(200);
  const [enrichLimit, setEnrichLimit] = useState(100);
  const [minScore, setMinScore] = useState(60);
  const [estimate, setEstimate] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [budget, setBudget] = useState(null);
  const [openJob, setOpenJob] = useState(null);
  const [details, setDetails] = useState(null);
  const [onlyMatched, setOnlyMatched] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get('/lead-search/jobs');
      setJobs(data.jobs || []);
      setBudget(data.budget || null);
    } catch (e) {
      // Backend down — keep the last known state on screen.
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const loadDetails = useCallback(async (id) => {
    if (!id) return;
    try {
      const data = await api.get(`/lead-search/jobs/${id}?only_matched=${onlyMatched ? 1 : 0}`);
      setDetails(data);
    } catch (e) {
      setError(e.error || e.message || 'Не удалось загрузить результаты');
    }
  }, [onlyMatched]);

  useEffect(() => {
    if (!openJob) { setDetails(null); return; }
    loadDetails(openJob);
    const t = setInterval(() => loadDetails(openJob), 6000);
    return () => clearInterval(t);
  }, [openJob, loadDetails]);

  // Cost is recomputed on every knob turn so it's visible before anything is
  // spent, not after.
  useEffect(() => {
    if (!plan) { setEstimate(null); return; }
    let cancelled = false;
    api.post('/lead-search/estimate', {
      plan,
      target_count: Number(target) || 0,
      enrich_limit: Math.min(Number(enrichLimit) || 0, Number(target) || 0),
    })
      .then(d => { if (!cancelled) setEstimate(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [plan, target, enrichLimit]);

  const activeJob = jobs.find(j => ['pending', 'running', 'paused'].includes(j.status));

  async function buildPlan() {
    setError('');
    setPlanning(true);
    try {
      const d = await api.post('/lead-search/plan', { query });
      setPlan(d.plan);
      setBudget(d.budget || budget);
    } catch (e) {
      setError(e.error || e.message || 'Не удалось построить план');
    } finally {
      setPlanning(false);
    }
  }

  function setPlanField(key, value) {
    setPlan(p => ({ ...p, [key]: value }));
  }

  async function createJob() {
    setError('');
    setCreating(true);
    try {
      const d = await api.post('/lead-search/jobs', {
        query,
        plan,
        target_count: Number(target),
        enrich_limit: Math.min(Number(enrichLimit) || 0, Number(target)),
        min_score: Number(minScore),
      });
      setPlan(null);
      setQuery('');
      setOpenJob(d.job?.id || null);
      load();
    } catch (e) {
      setError(e.error || e.message || 'Не удалось запустить поиск');
    } finally {
      setCreating(false);
    }
  }

  async function jobAction(id, action) {
    try {
      await api.post(`/lead-search/jobs/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.error || e.message || 'Ошибка');
    }
  }

  async function deleteJob(id) {
    if (!confirm('Удалить поиск и все найденные лиды? Сначала выгрузите таблицу, если она ещё нужна.')) return;
    try {
      await api.delete(`/lead-search/jobs/${id}`);
      if (openJob === id) setOpenJob(null);
      load();
    } catch (e) {
      setError(e.error || e.message || 'Ошибка');
    }
  }

  async function toContacts(id, all) {
    try {
      const res = await api.post(`/lead-search/jobs/${id}/to-contacts?all=${all ? 1 : 0}`, {});
      setNotice(`Добавлено в контакты: ${res.added} из ${res.total} (остальные уже были)`);
    } catch (e) {
      setError(e.error || e.message || 'Ошибка');
    }
  }

  // Direct fetch instead of axios: we need the raw blob plus the workspace
  // header, and axios' response interceptor unwraps to .data.
  // all: true = скачать всех найденных, false = только подходящих, undefined = использовать фильтр
  async function download(id, format, all) {
    try {
      const allParam = all !== undefined ? (all ? 1 : 0) : (onlyMatched ? 0 : 1);
      const res = await fetch(`/api/lead-search/jobs/${id}/export.${format}?all=${allParam}`, {
        headers: { 'X-Workspace': getCurrentWorkspace() },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `leads_search_${id}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError('Не удалось скачать файл: ' + e.message);
    }
  }

  const overBudget = budget && estimate && estimate.total > budget.remaining;

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Sparkles size={22} className="text-purple-500" /> AI-поиск лидов
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Опишите нужную аудиторию словами — AI сам найдёт людей через поиск Instagram и вернёт готовую таблицу
        </p>
      </div>

      <div className="border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4">
        <div className="flex gap-3">
          <Shield className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" size={18} />
          <div className="text-sm text-amber-900 dark:text-amber-200 space-y-1.5">
            <div className="font-semibold">Как это остаётся безопасным для аккаунта</div>
            <ul className="text-xs space-y-1 text-amber-800/90 dark:text-amber-300/90 list-disc pl-4">
              <li>Без аккаунтов-доноров: используются обычные поисковые страницы Instagram — те же, что открывает человек</li>
              <li>Запросы идут из вашего браузера в вашей же сессии, темп задаёт сервер: паузы 4–9 сек и отдых 25–50 сек</li>
              <li>Бесплатный отсев по имени и подписи поста — до профилей доходят только осмысленные кандидаты</li>
              <li>Поиск никогда не работает одновременно с рассылкой или Lead Finder — одно действие в Instagram за раз</li>
              <li>Дневной бюджет запросов общий с Lead Finder, остаток виден ниже</li>
            </ul>
            <div className="text-xs pt-1">
              Расширение должно быть запущено, а Instagram — залогинен. Иначе задача просто будет ждать.
            </div>
          </div>
        </div>
      </div>

      {budget && (
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Дневной бюджет запросов:</span>
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {formatNumber(budget.used)} / {formatNumber(budget.limit)}
            </span>
          </div>
          <div className="flex-1 max-w-xs bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
            <div
              className={`h-1.5 rounded-full transition-all ${budget.remaining <= 0 ? 'bg-red-500' : budget.used / budget.limit > 0.8 ? 'bg-amber-500' : 'bg-green-500'}`}
              style={{ width: `${Math.min(100, (budget.used / budget.limit) * 100)}%` }}
            />
          </div>
          <span className="text-xs text-gray-500">осталось {formatNumber(budget.remaining)}</span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-xl px-4 py-3">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>{error}</span>
          <button onClick={() => setError('')} className="ml-auto shrink-0"><X size={14} /></button>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 text-sm text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50 rounded-xl px-4 py-3">
          <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
          <span>{notice}</span>
          <button onClick={() => setNotice('')} className="ml-auto shrink-0"><X size={14} /></button>
        </div>
      )}

      {/* Query → plan */}
      <div className="card space-y-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Search size={15} className="text-purple-500" /> Кого ищем
        </h2>

        <div>
          <textarea
            className="input text-sm min-h-[70px]"
            placeholder="Например: нутрициологи и health-коучи в Москве, 1–10 тысяч подписчиков, ведут личный блог, а не магазин"
            value={query}
            onChange={e => setQuery(e.target.value)}
            disabled={!!activeJob}
          />
          <p className="text-xs text-gray-400 mt-1">
            Чем конкретнее описание — ниша, город, размер аудитории, чем человек отличается от похожих — тем чище выдача.
          </p>
        </div>

        <button
          onClick={buildPlan}
          disabled={planning || query.trim().length < 3 || !!activeJob}
          className="btn-primary flex items-center gap-2 disabled:opacity-50"
        >
          <Sparkles size={15} />
          {planning ? 'AI составляет план…' : plan ? 'Пересобрать план' : 'Показать план поиска'}
        </button>

        {activeJob && (
          <div className="text-xs text-gray-500 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-3 py-2">
            Уже идёт поиск <span className="font-semibold">#{activeJob.id}</span> — «{activeJob.query_text}».
            Дождитесь завершения или отмените его.
          </div>
        )}
      </div>

      {/* Editable plan */}
      {plan && !activeJob && (
        <div className="card space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">План поиска</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Отредактируйте перед запуском — это самое сильное влияние на качество. Один точный хештег даёт больше,
              чем пять общих.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-3 text-sm">
            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Ниша</label>
              <input className="input text-sm" value={plan.niche}
                onChange={e => setPlanField('niche', e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Гео</label>
              <input className="input text-sm" value={plan.geo}
                onChange={e => setPlanField('geo', e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">
                Подписчиков: от / до
              </label>
              <div className="flex gap-2">
                <input type="number" className="input text-sm" placeholder="от"
                  value={plan.min_followers ?? ''}
                  onChange={e => setPlanField('min_followers', e.target.value === '' ? null : Number(e.target.value))} />
                <input type="number" className="input text-sm" placeholder="до"
                  value={plan.max_followers ?? ''}
                  onChange={e => setPlanField('max_followers', e.target.value === '' ? null : Number(e.target.value))} />
              </div>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">
              Кто именно нужен — по этому описанию AI ставит оценку
            </label>
            <textarea className="input text-sm min-h-[54px]" value={plan.audience}
              onChange={e => setPlanField('audience', e.target.value)} />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <ChipList
              icon={Hash} accent="text-pink-500" label="Хештеги"
              hint="под ними ищем авторов постов"
              items={plan.hashtags} onChange={v => setPlanField('hashtags', v)}
            />
            <ChipList
              icon={MapPin} accent="text-blue-500" label="Места"
              hint="единственный источник подтверждённого гео"
              items={plan.places} onChange={v => setPlanField('places', v)}
            />
            <ChipList
              icon={Type} accent="text-orange-500" label="Ключевые слова"
              hint="как люди подписывают себя в имени профиля"
              items={plan.keywords} onChange={v => setPlanField('keywords', v)}
            />
            <ChipList
              icon={Ban} accent="text-gray-400" label="Стоп-слова"
              hint="бесплатный отсев до похода в профиль"
              items={plan.exclude} onChange={v => setPlanField('exclude', v)}
            />
          </div>

          <div className="grid md:grid-cols-3 gap-4 pt-2 border-t border-gray-100 dark:border-gray-700">
            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 block">
                Сколько кандидатов собрать
              </label>
              <div className="flex items-center gap-1.5 flex-wrap">
                {TARGET_PRESETS.map(p => (
                  <button key={p} onClick={() => setTarget(p)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                      Number(target) === p ? 'bg-purple-500 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}>{formatNumber(p)}</button>
                ))}
                <input type="number" min="10" max="600" value={target}
                  onChange={e => setTarget(e.target.value)} className="input text-xs w-20 py-1" />
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 block">
                Из них изучить профиль
              </label>
              <div className="flex items-center gap-1.5 flex-wrap">
                {ENRICH_PRESETS.map(p => (
                  <button key={p} onClick={() => setEnrichLimit(p)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                      Number(enrichLimit) === p ? 'bg-purple-500 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}>{p === 0 ? 'Нет' : formatNumber(p)}</button>
                ))}
                <input type="number" min="0" max={target} value={enrichLimit}
                  onChange={e => setEnrichLimit(e.target.value)} className="input text-xs w-20 py-1" />
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 block">
                Минимальная оценка для «подходит»
              </label>
              <div className="flex items-center gap-2">
                <input type="range" min="0" max="100" step="5" value={minScore}
                  onChange={e => setMinScore(Number(e.target.value))} className="flex-1" />
                <span className="text-sm font-bold text-gray-900 dark:text-gray-100 w-8">{minScore}</span>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-1.5 text-xs text-gray-500">
            <Info size={12} className="shrink-0 mt-0.5" />
            <span>
              Без изучения профиля видны: username, имя и источник. С изучением добавляются: био, подписчики, оценка AI.
              Изучение = 1 запрос на человека, это дорогой этап.
            </span>
          </div>

          {estimate && (
            <div className={`rounded-xl px-4 py-3 text-sm border ${
              overBudget
                ? 'border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-900/20'
                : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50'
            }`}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">Источников</div>
                  <div className="font-bold text-gray-900 dark:text-gray-100">{formatNumber(estimate.source_count)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">Запросов к Instagram</div>
                  <div className="font-bold text-gray-900 dark:text-gray-100">{formatNumber(estimate.total)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider flex items-center gap-1">
                    <Clock size={10} /> Примерное время
                  </div>
                  <div className="font-bold text-gray-900 dark:text-gray-100">
                    {formatDuration(estimate.estimated_seconds)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">Остаток бюджета</div>
                  <div className={`font-bold ${overBudget ? 'text-red-600' : 'text-gray-900 dark:text-gray-100'}`}>
                    {formatNumber(estimate.budget?.remaining)}
                  </div>
                </div>
              </div>
              {overBudget && (
                <div className="text-xs text-red-700 dark:text-red-400 mt-2 font-medium">
                  Не уместится в дневной бюджет. Поиск остановится по достижении лимита и продолжится завтра —
                  прогресс не потеряется.
                </div>
              )}
            </div>
          )}

          <button
            onClick={createJob}
            disabled={creating || estimate?.source_count === 0}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            <Play size={15} />
            {creating ? 'Запускаем…' : 'Запустить поиск'}
          </button>
        </div>
      )}

      {/* Jobs */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Поиски</h2>
          <button onClick={load} className="text-xs text-gray-500 hover:text-purple-600 flex items-center gap-1">
            <RefreshCw size={12} /> Обновить
          </button>
        </div>

        {jobs.length === 0 && (
          <div className="card text-center py-10">
            <Sparkles className="mx-auto text-gray-300 dark:text-gray-600 mb-3" size={32} />
            <p className="text-sm text-gray-500">Пока нет поисков. Опишите нужную аудиторию выше.</p>
          </div>
        )}

        {jobs.map(job => {
          const st = STATUS_MAP[job.status] || STATUS_MAP.pending;
          const isActive = ['pending', 'running'].includes(job.status);
          const isOpen = openJob === job.id;
          return (
            <div key={job.id} className="card space-y-3">
              <div className="flex items-start justify-between gap-3">
                <button className="min-w-0 text-left" onClick={() => setOpenJob(isOpen ? null : job.id)}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900 dark:text-gray-100 truncate">{job.query_text}</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${st.cls}`}>
                      {st.label}
                    </span>
                    <span className="text-[11px] text-gray-400">#{job.id}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {PHASE_LABELS[job.phase] || job.phase}
                    {` · источников ${job.sources?.length ?? 0}`}
                    {job.created_at ? ` · ${job.created_at.slice(0, 16).replace('T', ' ')}` : ''}
                  </div>
                </button>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isActive && (
                    <button onClick={() => jobAction(job.id, 'pause')} title="Приостановить"
                      className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">
                      <Pause size={15} />
                    </button>
                  )}
                  {['paused', 'failed'].includes(job.status) && (
                    <button onClick={() => jobAction(job.id, 'resume')} title="Продолжить"
                      className="p-1.5 rounded-lg hover:bg-green-50 dark:hover:bg-green-900/30 text-green-600">
                      <Play size={15} />
                    </button>
                  )}
                  {isActive && (
                    <button onClick={() => jobAction(job.id, 'cancel')} title="Отменить"
                      className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">
                      <X size={15} />
                    </button>
                  )}
                  <button onClick={() => deleteJob(job.id)} title="Удалить"
                    className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 text-red-500">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">
                    Найдено <span className="font-semibold text-gray-900 dark:text-gray-100">
                      {formatNumber(job.discovered_count)}
                    </span> из {formatNumber(job.target_count)}
                    {job.filtered_out > 0 && <> · отсеяно {formatNumber(job.filtered_out)}</>}
                    {job.enrich_limit > 0 && <> · изучено {formatNumber(job.enriched_count)}</>}
                    {job.scored_count > 0 && <> · подходят <span className="font-semibold text-green-600 dark:text-green-400">
                      {formatNumber(job.matched_count)}
                    </span></>}
                  </span>
                  <span className="text-gray-400">{job.percent}%</span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      job.status === 'running' ? 'bg-green-500' :
                      job.status === 'completed' ? 'bg-blue-500' :
                      job.status === 'paused' ? 'bg-amber-500' : 'bg-gray-400'
                    }`}
                    style={{ width: `${job.percent}%` }}
                  />
                </div>
              </div>

              {/* Stages visualization */}
              <div className="grid grid-cols-3 gap-2 text-[11px]">
                <div className={`p-2 rounded-lg text-center font-medium ${
                  job.phase === 'discover'
                    ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 ring-1 ring-blue-400'
                    : job.discovered_count > 0
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}>
                  🔍 Поиск
                  <div className="text-[10px] opacity-75 mt-0.5">{formatNumber(job.discovered_count)}/{formatNumber(job.target_count)}</div>
                </div>
                <div className={`p-2 rounded-lg text-center font-medium ${
                  job.phase === 'enrich'
                    ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400 ring-1 ring-purple-400'
                    : job.enriched_count > 0
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}>
                  📊 Обогащение
                  <div className="text-[10px] opacity-75 mt-0.5">{formatNumber(job.enriched_count)}/{formatNumber(job.enrich_limit > 0 ? job.enrich_limit : job.discovered_count)}</div>
                </div>
                <div className={`p-2 rounded-lg text-center font-medium ${
                  job.phase === 'score'
                    ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 ring-1 ring-amber-400'
                    : job.scored_count > 0
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}>
                  ⭐ Оценка
                  <div className="text-[10px] opacity-75 mt-0.5">{formatNumber(job.scored_count)}/{formatNumber(job.enriched_count)}</div>
                </div>
              </div>

              {job.error_message && (
                <div className="text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg px-3 py-2 flex items-start gap-2">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span>{job.error_message}</span>
                </div>
              )}

              {job.sources?.some(s => s.error_message) && (
                <div className="text-xs text-gray-500">
                  Отключены источники: {job.sources.filter(s => s.error_message).map(s => `${s.kind} «${s.value}»`).join(', ')}
                </div>
              )}

              {job.discovered_count > 0 && (
                <div className="flex items-center gap-2 pt-1 flex-wrap">
                  <div className="text-xs text-gray-500">Скачать найденные:</div>
                  <button onClick={() => download(job.id, 'xlsx', true)}
                    className="btn-primary text-xs flex items-center gap-1.5 py-1.5">
                    <Download size={13} /> Excel ({formatNumber(job.discovered_count)})
                  </button>
                  <button onClick={() => download(job.id, 'csv', true)}
                    className="text-xs flex items-center gap-1.5 py-1.5 px-3 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600">
                    <Download size={13} /> CSV ({formatNumber(job.discovered_count)})
                  </button>
                  <button onClick={() => toContacts(job.id, true)}
                    className="text-xs flex items-center gap-1.5 py-1.5 px-3 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600">
                    <UserPlus size={13} /> В контакты ({formatNumber(job.discovered_count)})
                  </button>
                  {job.matched_count > 0 && (
                    <>
                      <div className="text-xs text-gray-500 ml-2">Подходящие:</div>
                      <button onClick={() => download(job.id, 'xlsx', false)}
                        className="text-xs flex items-center gap-1.5 py-1.5 px-3 rounded-lg bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/60">
                        <Download size={13} /> Excel ✓ ({formatNumber(job.matched_count)})
                      </button>
                      <button onClick={() => toContacts(job.id, false)}
                        className="text-xs flex items-center gap-1.5 py-1.5 px-3 rounded-lg bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/60">
                        <UserPlus size={13} /> В контакты ✓ ({formatNumber(job.matched_count)})
                      </button>
                    </>
                  )}
                  <button onClick={() => setOpenJob(isOpen ? null : job.id)}
                    className="text-xs text-purple-600 hover:underline ml-auto">
                    {isOpen ? 'Свернуть таблицу' : 'Показать таблицу'}
                  </button>
                </div>
              )}

              {/* Results */}
              {isOpen && details?.job?.id === job.id && (
                <div className="pt-2 border-t border-gray-100 dark:border-gray-700 space-y-2">
                  <label className="flex items-center gap-2 text-xs text-gray-500">
                    <input type="checkbox" checked={onlyMatched} onChange={e => setOnlyMatched(e.target.checked)} />
                    Только подходящие (оценка ≥ порога и в рамках подписчиков)
                  </label>

                  {details.results.length === 0 ? (
                    <p className="text-xs text-gray-400 py-3">
                      {onlyMatched
                        ? 'Нет подходящих профилей. Снимите фильтр, чтобы видеть все найденные аккаунты (включая ещё не изученные).'
                        : 'Обнаруживаются первые аккаунты... '}
                    </p>
                  ) : (
                    <div className="space-y-6">
                      {(() => {
                        const enriched = details.results.filter(r => r.enriched);
                        const notEnriched = details.results.filter(r => !r.enriched);
                        return (
                          <>
                            {enriched.length > 0 && (
                              <div>
                                <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100 mb-2">
                                  Изученные профили ({enriched.length})
                                </h3>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-left text-gray-400 uppercase tracking-wider text-[10px]">
                                        <th className="py-1.5 pr-3">Статус</th>
                                        <th className="py-1.5 pr-3">Аккаунт</th>
                                        <th className="py-1.5 pr-3">Оценка</th>
                                        <th className="py-1.5 pr-3">Гео</th>
                                        <th className="py-1.5 pr-3">Подписчики</th>
                                        <th className="py-1.5 pr-3">Почему</th>
                                        <th className="py-1.5">Источник</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                                      {enriched.map(r => {
                                        const conf = CONFIDENCE_MAP[r.ai_geo_confidence] || CONFIDENCE_MAP.none;
                                        let statusBadge, statusCls;
                                        if (r.scored && r.matched) {
                                          statusBadge = '✓ Подходит';
                                          statusCls = 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400';
                                        } else if (r.scored) {
                                          statusBadge = '✗ Не подходит';
                                          statusCls = 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400';
                                        } else {
                                          statusBadge = '⊙ Ожидает оценку';
                                          statusCls = 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400';
                                        }
                                        return (
                                          <tr key={r.id} className="align-top">
                                            <td className="py-1.5 pr-3">
                                              <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${statusCls}`}>
                                                {statusBadge}
                                              </span>
                                            </td>
                                            <td className="py-1.5 pr-3">
                                              <a href={`https://www.instagram.com/${r.username}/`} target="_blank" rel="noreferrer"
                                                className="font-medium text-gray-900 dark:text-gray-100 hover:text-purple-600">
                                                @{r.username}
                                              </a>
                                              {r.full_name && <div className="text-gray-400 text-[11px]">{r.full_name}</div>}
                                            </td>
                                            <td className={`py-1.5 pr-3 font-bold ${scoreColor(r.ai_score)}`}>
                                              {r.ai_score ?? '—'}
                                            </td>
                                            <td className="py-1.5 pr-3">
                                              <div className="text-gray-700 dark:text-gray-200">{r.ai_geo || '—'}</div>
                                              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] mt-0.5 ${conf.cls}`}>
                                                {conf.label}
                                              </span>
                                            </td>
                                            <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">
                                              {formatNumber(r.follower_count)}
                                            </td>
                                            <td className="py-1.5 pr-3 text-gray-500 max-w-[220px]">{r.ai_reason || '—'}</td>
                                            <td className="py-1.5 text-gray-400">
                                              {r.post_location || r.source_value}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                            {notEnriched.length > 0 && (
                              <div>
                                <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100 mb-2">
                                  Не изучены ({notEnriched.length})
                                </h3>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-left text-gray-400 uppercase tracking-wider text-[10px]">
                                        <th className="py-1.5 pr-3">Аккаунт</th>
                                        <th className="py-1.5 pr-3">Источник</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                                      {notEnriched.map(r => (
                                        <tr key={r.id} className="align-top">
                                          <td className="py-1.5 pr-3">
                                            <a href={`https://www.instagram.com/${r.username}/`} target="_blank" rel="noreferrer"
                                              className="font-medium text-gray-900 dark:text-gray-100 hover:text-purple-600">
                                              @{r.username}
                                            </a>
                                            {r.full_name && <div className="text-gray-400 text-[11px]">{r.full_name}</div>}
                                          </td>
                                          <td className="py-1.5 text-gray-400">
                                            {r.post_location || r.source_value}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
