import React, { useState, useEffect, useCallback } from 'react';
import {
  Search, Users, Download, Play, Pause, X, Trash2, AlertTriangle,
  Clock, Shield, Sparkles, RefreshCw, CheckCircle2, Info
} from 'lucide-react';
import api, { getCurrentWorkspace } from '../utils/api.js';

const COUNT_PRESETS = [50, 100, 250, 500];
const ENRICH_PRESETS = [0, 50, 100, 300];

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} мин`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem > 0 ? `${hours} ч ${rem} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  return `${days} дн ${hours % 24} ч`;
}

function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('ru-RU');
}

const STATUS_MAP = {
  pending: { label: 'Ожидает', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300' },
  running: { label: 'Идёт скрейпинг', cls: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400' },
  paused: { label: 'Приостановлена', cls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' },
  completed: { label: 'Завершена', cls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' },
  failed: { label: 'Ошибка', cls: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400' },
  cancelled: { label: 'Отменена', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-500' },
};

const PHASE_LABELS = {
  resolve: 'Поиск профиля',
  followers: 'Сбор подписчиков',
  enrich: 'Сбор био и статистики',
  done: 'Готово',
};

export default function LeadFinder() {
  const [target, setTarget] = useState('');
  const [count, setCount] = useState(500);
  const [enrichLimit, setEnrichLimit] = useState(0);
  const [jobs, setJobs] = useState([]);
  const [budget, setBudget] = useState(null);
  const [limits, setLimits] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get('/lead-finder/jobs');
      setJobs(data.jobs || []);
      setBudget(data.budget || null);
    } catch (e) {
      // Backend down — leave the last known state on screen.
    }
  }, []);

  useEffect(() => {
    api.get('/lead-finder/limits')
      .then(d => { setLimits(d.limits); setBudget(d.budget); })
      .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  // Recompute the estimate whenever the knobs change, so the cost is visible
  // before anything is started rather than after.
  useEffect(() => {
    const n = Number(count) || 0;
    const e = Number(enrichLimit) || 0;
    if (n <= 0) { setEstimate(null); return; }
    let cancelled = false;
    api.post('/lead-finder/estimate', { count: n, enrich_limit: Math.min(e, n) })
      .then(d => { if (!cancelled) setEstimate(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [count, enrichLimit]);

  const activeJob = jobs.find(j => ['pending', 'running', 'paused'].includes(j.status));

  async function createJob() {
    setError('');
    setCreating(true);
    try {
      await api.post('/lead-finder/jobs', {
        target,
        count: Number(count),
        enrich_limit: Math.min(Number(enrichLimit) || 0, Number(count)),
      });
      setTarget('');
      load();
    } catch (e) {
      setError(e.error || e.message || 'Не удалось создать задачу');
    } finally {
      setCreating(false);
    }
  }

  async function jobAction(id, action) {
    try {
      await api.post(`/lead-finder/jobs/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.error || e.message || 'Ошибка');
    }
  }

  async function deleteJob(id) {
    if (!confirm('Удалить задачу и все собранные данные? Экспортируйте CSV, если он ещё нужен.')) return;
    try {
      await api.delete(`/lead-finder/jobs/${id}`);
      load();
    } catch (e) {
      setError(e.error || e.message || 'Ошибка');
    }
  }

  // Direct fetch instead of axios: we need the raw blob plus the workspace
  // header, and axios' response interceptor unwraps to .data.
  async function downloadCsv(job) {
    try {
      const res = await fetch(`/api/lead-finder/jobs/${job.id}/export.csv`, {
        headers: { 'X-Workspace': getCurrentWorkspace() },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `followers_${job.target_username}_${job.id}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError('Не удалось скачать CSV: ' + e.message);
    }
  }

  const enrichOn = Number(enrichLimit) > 0;
  const requestsNeeded = estimate?.requests_needed ?? 0;
  const overBudget = budget && requestsNeeded > budget.remaining;

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Lead Finder</h1>
        <p className="text-sm text-gray-500 mt-1">
          Follower Scraper — собирает подписчиков любого открытого аккаунта в CSV
        </p>
      </div>

      {/* Safety notice. Deliberately prominent: this is the highest-risk
          feature in the product for the connected Instagram account. */}
      <div className="border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4">
        <div className="flex gap-3">
          <Shield className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" size={18} />
          <div className="text-sm text-amber-900 dark:text-amber-200 space-y-1.5">
            <div className="font-semibold">Как это остаётся безопасным для вашего аккаунта</div>
            <ul className="text-xs space-y-1 text-amber-800/90 dark:text-amber-300/90 list-disc pl-4">
              <li>Все запросы идут из вашего браузера в вашей же сессии Instagram — никаких сторонних API и прокси</li>
              <li>Пачками: 5 страниц с паузой 3.5–8.5 сек, затем отдых 30–45 сек. Человек листает так же — рывками, а не равномерно</li>
              <li>Не более 500 подписчиков за одну задачу. Аккаунт режут за суточный объём, а не за скорость</li>
              <li>Скрейпинг никогда не работает одновременно с рассылкой — по одному действию в Instagram за раз</li>
              <li>Любой сигнал 429 или блокировки мгновенно останавливает задачу на 30–60 минут, прогресс сохраняется</li>
              <li>Дневной бюджет запросов ограничен, остаток виден ниже</li>
            </ul>
            <div className="text-xs pt-1 font-medium">
              Нужно больше 500 — запускайте новые задачи в разные дни, а не одну большую.
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

      {/* New job form */}
      <div className="card space-y-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Search size={15} className="text-orange-500" /> Новый скрейпинг
        </h2>

        <div>
          <label className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 block">
            Чьих подписчиков собрать
          </label>
          <input
            className="input text-sm"
            placeholder="@username или https://instagram.com/username"
            value={target}
            onChange={e => setTarget(e.target.value)}
            disabled={!!activeJob}
          />
          <p className="text-xs text-gray-400 mt-1">
            Аккаунт должен быть открытым. У закрытых профилей список подписчиков недоступен.
          </p>
        </div>

        <div>
          <label className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 block">
            Сколько подписчиков собрать
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            {COUNT_PRESETS.map(p => (
              <button
                key={p}
                onClick={() => setCount(p)}
                disabled={!!activeJob}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                  Number(count) === p
                    ? 'bg-orange-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {formatNumber(p)}
              </button>
            ))}
            <input
              type="number"
              min="1"
              max={limits?.MAX_REQUESTED_COUNT || 10000}
              value={count}
              onChange={e => setCount(e.target.value)}
              disabled={!!activeJob}
              className="input text-sm w-28"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 block flex items-center gap-1.5">
            <Sparkles size={12} className="text-purple-500" />
            Собрать био и число подписчиков
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            {ENRICH_PRESETS.map(p => (
              <button
                key={p}
                onClick={() => setEnrichLimit(p)}
                disabled={!!activeJob}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                  Number(enrichLimit) === p
                    ? 'bg-purple-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {p === 0 ? 'Выключено' : formatNumber(p)}
              </button>
            ))}
            <input
              type="number"
              min="0"
              max={count}
              value={enrichLimit}
              onChange={e => setEnrichLimit(e.target.value)}
              disabled={!!activeJob}
              className="input text-sm w-28"
            />
          </div>
          <div className="flex items-start gap-1.5 mt-2 text-xs text-gray-500">
            <Info size={12} className="shrink-0 mt-0.5" />
            <span>
              Список подписчиков даёт username, имя и признак закрытого профиля бесплатно — это один запрос на 50 человек.
              Био и число подписчиков Instagram отдаёт только по одному профилю за запрос, поэтому этот этап
              самый дорогой: {formatNumber(1)} запрос = {formatNumber(1)} профиль. Рекомендуем не более 300 в день.
            </span>
          </div>
        </div>

        {/* Cost preview */}
        {estimate && (
          <div className={`rounded-xl px-4 py-3 text-sm border ${
            overBudget
              ? 'border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-900/20'
              : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50'
          }`}>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-wider">Запросов к Instagram</div>
                <div className="font-bold text-gray-900 dark:text-gray-100">{formatNumber(requestsNeeded)}</div>
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
                Задача не уместится в дневной бюджет. Она остановится по достижении лимита и продолжится завтра —
                прогресс не потеряется.
              </div>
            )}
            {enrichOn && Number(enrichLimit) > 300 && (
              <div className="text-xs text-amber-700 dark:text-amber-400 mt-2 font-medium flex items-start gap-1.5">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                <span>
                  {formatNumber(enrichLimit)} профилей для обогащения — это {formatNumber(enrichLimit)} отдельных
                  запросов и {formatDuration(estimate.estimated_seconds)} работы. Для нового или недавно
                  ограниченного аккаунта это много.
                </span>
              </div>
            )}
          </div>
        )}

        {activeJob ? (
          <div className="text-xs text-gray-500 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-3 py-2">
            Уже есть активная задача <span className="font-semibold">#{activeJob.id}</span> (@{activeJob.target_username}).
            Дождитесь завершения или отмените её — параллельный скрейпинг сильно повышает риск блокировки.
          </div>
        ) : (
          <button
            onClick={createJob}
            disabled={creating || !target.trim() || !Number(count)}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            <Play size={15} />
            {creating ? 'Создаём…' : 'Начать скрейпинг'}
          </button>
        )}
      </div>

      {/* Job list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Задачи</h2>
          <button onClick={load} className="text-xs text-gray-500 hover:text-orange-600 flex items-center gap-1">
            <RefreshCw size={12} /> Обновить
          </button>
        </div>

        {jobs.length === 0 && (
          <div className="card text-center py-10">
            <Users className="mx-auto text-gray-300 dark:text-gray-600 mb-3" size={32} />
            <p className="text-sm text-gray-500">Пока нет задач. Создайте первую выше.</p>
          </div>
        )}

        {jobs.map(job => {
          const st = STATUS_MAP[job.status] || STATUS_MAP.pending;
          const isActive = ['pending', 'running'].includes(job.status);
          const hasResults = job.scraped_count > 0;
          return (
            <div key={job.id} className="card space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={`https://www.instagram.com/${job.target_username}/`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-gray-900 dark:text-gray-100 hover:text-orange-600 truncate"
                    >
                      @{job.target_username}
                    </a>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${st.cls}`}>
                      {st.label}
                    </span>
                    <span className="text-[11px] text-gray-400">#{job.id}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {PHASE_LABELS[job.phase] || job.phase}
                    {job.target_follower_total ? ` · у аккаунта ${formatNumber(job.target_follower_total)} подписчиков` : ''}
                    {job.created_at ? ` · создана ${job.created_at.slice(0, 16).replace('T', ' ')}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isActive && (
                    <button
                      onClick={() => jobAction(job.id, 'pause')}
                      title="Приостановить"
                      className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
                    >
                      <Pause size={15} />
                    </button>
                  )}
                  {['paused', 'failed'].includes(job.status) && (
                    <button
                      onClick={() => jobAction(job.id, 'resume')}
                      title="Продолжить"
                      className="p-1.5 rounded-lg hover:bg-green-50 dark:hover:bg-green-900/30 text-green-600"
                    >
                      <Play size={15} />
                    </button>
                  )}
                  {isActive && (
                    <button
                      onClick={() => jobAction(job.id, 'cancel')}
                      title="Отменить"
                      className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
                    >
                      <X size={15} />
                    </button>
                  )}
                  <button
                    onClick={() => deleteJob(job.id)}
                    title="Удалить"
                    className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 text-red-500"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {/* Progress */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">
                    Собрано <span className="font-semibold text-gray-900 dark:text-gray-100">
                      {formatNumber(job.scraped_count)}
                    </span> из {formatNumber(job.requested_count)}
                    {job.enrich_limit > 0 && (
                      <> · обогащено <span className="font-semibold text-purple-600 dark:text-purple-400">
                        {formatNumber(job.enriched_count)}
                      </span> из {formatNumber(job.enrich_limit)}</>
                    )}
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
                {job.enrich_limit > 0 && (
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1 overflow-hidden">
                    <div
                      className="h-1 rounded-full bg-purple-500 transition-all duration-500"
                      style={{ width: `${Math.min(100, (job.enriched_count / job.enrich_limit) * 100)}%` }}
                    />
                  </div>
                )}
              </div>

              {job.error_message && (
                <div className="text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg px-3 py-2 flex items-start gap-2">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span>{job.error_message}</span>
                </div>
              )}

              {job.status === 'completed' && (
                <div className="text-xs text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
                  <CheckCircle2 size={13} />
                  Готово: {formatNumber(job.scraped_count)} подписчиков
                  {job.enriched_count > 0 && `, из них ${formatNumber(job.enriched_with_data)} с био и статистикой`}
                </div>
              )}

              {/* Enrichment that ran but came back empty means Instagram
                  refused the profile lookups — say so instead of letting the
                  progress bar imply success. */}
              {job.enrich_limit > 0 && job.enriched_empty > 0 && (
                <div className="text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg px-3 py-2 flex items-start gap-2">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span>
                    {formatNumber(job.enriched_empty)} профилей не отдали био и статистику — Instagram отклонил
                    запросы к профилям. Username и имя собраны и в CSV есть. Проверьте консоль расширения (F12 на
                    странице Instagram) — там будет точный ответ Instagram.
                  </span>
                </div>
              )}

              {hasResults && (
                <div className="flex items-center gap-3 pt-1 flex-wrap">
                  <button
                    onClick={() => downloadCsv(job)}
                    className="btn-primary text-xs flex items-center gap-1.5 py-1.5"
                  >
                    <Download size={13} /> Скачать CSV ({formatNumber(job.scraped_count)})
                  </button>
                  <span className="text-xs text-gray-400">
                    Собранные лиды не попадают в Contacts — только CSV
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
