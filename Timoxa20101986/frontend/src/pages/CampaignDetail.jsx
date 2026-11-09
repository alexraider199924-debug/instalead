import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, Pause, Sparkles, Users, Send, Clock, AlertCircle, Plus, Settings, ScrollText, MessageSquare, CheckCircle2, XCircle, Check } from 'lucide-react';
import api from '../utils/api.js';

const STATUS_MAP = {
  pending: { label: 'Ожидает', cls: 'badge-yellow' },
  sent: { label: 'Отправлено', cls: 'badge-green' },
  failed: { label: 'Ошибка', cls: 'badge-red' },
  skipped: { label: 'Уже отправлено ранее', cls: 'badge-gray' }
};

const DAYS = [
  { key: 'mon', label: 'Пн' },
  { key: 'tue', label: 'Вт' },
  { key: 'wed', label: 'Ср' },
  { key: 'thu', label: 'Чт' },
  { key: 'fri', label: 'Пт' },
  { key: 'sat', label: 'Сб' },
  { key: 'sun', label: 'Вс' },
];

function Toggle({ value, onChange }) {
  return (
    <button onClick={() => onChange(!value)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-green-500' : 'bg-gray-300'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow ${value ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

function CampaignStatusBadge({ status }) {
  const map = {
    draft: <span className="badge-gray">Draft</span>,
    scheduled: <span className="badge-yellow">Scheduled</span>,
    running: <span className="badge-green animate-pulse">Active</span>,
    paused: <span className="badge-blue">Stopped</span>,
    paused_by_schedule: <span className="badge-yellow">Sleeping</span>,
    completed: <span className="badge-orange">Completed</span>
  };
  return map[status] || <span className="badge-gray">{status}</span>;
}

function LogEvent({ log }) {
  const iconMap = {
    created: <CheckCircle2 size={14} className="text-green-500" />,
    started: <Play size={14} className="text-green-500" />,
    paused: <Pause size={14} className="text-blue-500" />,
    completed: <CheckCircle2 size={14} className="text-orange-500" />,
    message_sent: <Send size={14} className="text-green-500" />,
    send_failed: <XCircle size={14} className="text-red-500" />,
    updated: <Settings size={14} className="text-gray-500" />,
    leads_added: <Users size={14} className="text-blue-500" />,
    outside_hours: <Clock size={14} className="text-yellow-500" />,
    scheduled: <Clock size={14} className="text-yellow-500" />,
  };
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-0.5 flex-shrink-0">{iconMap[log.event] || <ScrollText size={14} className="text-gray-400" />}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-800">{log.details}</div>
        <div className="text-xs text-gray-400 mt-0.5">{log.created_at?.replace('T', ' ').slice(0, 16)}</div>
      </div>
    </div>
  );
}

function TimeRangeSlider({ startTime, endTime, onChangeStart, onChangeEnd }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(null);
  const timeToHour = (t) => { const [h, m] = (t || '09:00').split(':').map(Number); return h + m / 60; };
  const hourToTime = (h) => { const hh = Math.floor(h); const mm = Math.round((h - hh) * 60); return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };
  const hourToPercent = (h) => (h / 24) * 100;
  const startH = timeToHour(startTime);
  const endH = timeToHour(endTime);
  const getHourFromEvent = useCallback((e) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(pct * 48) / 2;
  }, []);
  const handlePointerDown = useCallback((handle, e) => {
    e.preventDefault();
    draggingRef.current = handle;
    const onMove = (ev) => { ev.preventDefault(); const h = getHourFromEvent(ev); if (draggingRef.current === 'start') { if (h < endH - 0.5) onChangeStart(hourToTime(h)); } else { if (h > startH + 0.5) onChangeEnd(hourToTime(h)); } };
    const onUp = () => { draggingRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); document.addEventListener('touchmove', onMove, { passive: false }); document.addEventListener('touchend', onUp);
  }, [startH, endH, getHourFromEvent, onChangeStart, onChangeEnd]);
  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-900">{startTime}</span>
        <span className="text-sm font-semibold text-gray-900">{endTime}</span>
      </div>
      <div ref={trackRef} className="relative h-3 bg-gray-200 rounded-full cursor-pointer" style={{ touchAction: 'none' }}>
        <div className="absolute h-3 bg-orange-400 rounded-full" style={{ left: `${hourToPercent(startH)}%`, right: `${100 - hourToPercent(endH)}%` }} />
        <div className="absolute w-5 h-5 bg-white border-2 border-orange-500 rounded-full shadow-md cursor-grab active:cursor-grabbing" style={{ left: `${hourToPercent(startH)}%`, top: '50%', transform: 'translate(-50%, -50%)' }} onMouseDown={(e) => handlePointerDown('start', e)} onTouchStart={(e) => handlePointerDown('start', e)} />
        <div className="absolute w-5 h-5 bg-white border-2 border-orange-500 rounded-full shadow-md cursor-grab active:cursor-grabbing" style={{ left: `${hourToPercent(endH)}%`, top: '50%', transform: 'translate(-50%, -50%)' }} onMouseDown={(e) => handlePointerDown('end', e)} onTouchStart={(e) => handlePointerDown('end', e)} />
      </div>
      <div className="relative mt-1.5 h-4">
        {hours.map(h => (<span key={h} className="absolute text-[10px] text-gray-400 tabular-nums" style={{ left: `${hourToPercent(h)}%`, transform: 'translateX(-50%)' }}>{h === 24 ? '24' : String(h).padStart(2, '0')}</span>))}
      </div>
    </div>
  );
}

export default function CampaignDetail() {
  const { id } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [campaignLeads, setCampaignLeads] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [allLeads, setAllLeads] = useState([]);
  const [showAddLeads, setShowAddLeads] = useState(false);
  const [selectedNew, setSelectedNew] = useState(new Set());
  const [activeTab, setActiveTab] = useState('leads');
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState({});
  const editModeRef = useRef(false);
  editModeRef.current = editMode;

  const load = async () => {
    try {
      const [c, cl, lg] = await Promise.all([
        api.get(`/campaigns/${id}`),
        api.get(`/campaigns/${id}/leads`),
        api.get(`/campaigns/${id}/logs`)
      ]);
      setCampaign(c);
      setCampaignLeads(cl);
      setLogs(lg);
      if (!editModeRef.current) initForm(c);
      setLoading(false);
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  };

  const initForm = (c) => {
    const days = (c.schedule_days || 'mon,tue,wed,thu,fri').split(',');
    let offers = [c.message_template];
    if (c.offers) {
      try {
        offers = JSON.parse(c.offers);
      } catch (e) {}
    }
    setForm({
      name: c.name,
      message_template: c.message_template,
      offers: offers,
      
      daily_limit: c.daily_limit || 15,
      min_delay: c.min_delay || 7,
      max_delay: c.max_delay || 17,
      follow_profile: !!c.follow_profile,
      wait_for_reply: !!c.wait_for_reply,
      value_per_lead: c.value_per_lead || 0,
      schedule_start: c.schedule_start || '09:00',
      schedule_end: c.schedule_end || '18:00',
      schedule_days: Object.fromEntries(DAYS.map(d => [d.key, days.includes(d.key)])),
      skip_contacted: c.skip_contacted !== 0,
      stop_on_reply: c.stop_on_reply !== 0,
      pause_unsafe: c.pause_unsafe !== 0,
      safe_delays: c.safe_delays !== 0,
      warmup: c.warmup !== 0,
      like_last_post: !!c.like_last_post,
      prewarm_follow: !!c.prewarm_follow,
      prewarm_delay_hours: c.prewarm_delay_hours || 24,
    });
  };

  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    if (campaign?.status === 'running') {
      const t = setInterval(load, 3000);
      return () => clearInterval(t);
    }
  }, [campaign?.status]);

  const handleStart = async () => { await api.post(`/campaigns/${id}/start`); load(); };
  const handlePause = async () => { await api.post(`/campaigns/${id}/pause`); load(); };

  const handleSave = async () => {
    try {
      const activeDays = Object.entries(form.schedule_days).filter(([, v]) => v).map(([k]) => k).join(',');
      const validOffers = form.offers && Array.isArray(form.offers) ? form.offers.filter(o => o && o.trim()) : [];
      await api.put(`/campaigns/${id}`, {
        name: form.name,
        message_template: form.message_template,
        offers: validOffers.length > 0 ? validOffers : [form.message_template],
        ai_prompt: form.ai_prompt || null,
        daily_limit: form.daily_limit,
        min_delay: form.min_delay,
        max_delay: form.max_delay,
        follow_profile: form.follow_profile ? 1 : 0,
        wait_for_reply: form.wait_for_reply ? 1 : 0,
        value_per_lead: form.value_per_lead,
        schedule_days: activeDays,
        schedule_start: form.schedule_start,
        schedule_end: form.schedule_end,
        skip_contacted: form.skip_contacted ? 1 : 0,
        stop_on_reply: form.stop_on_reply ? 1 : 0,
        pause_unsafe: form.pause_unsafe ? 1 : 0,
        safe_delays: form.safe_delays ? 1 : 0,
        warmup: form.warmup ? 1 : 0,
        like_last_post: form.like_last_post ? 1 : 0,
        prewarm_follow: form.prewarm_follow ? 1 : 0,
        prewarm_delay_hours: form.prewarm_delay_hours || 24,
      });
      setEditMode(false);
      setSuccess('Настройки сохранены');
      setTimeout(() => setSuccess(''), 3000);
      load();
    } catch (e) {
      setError(e.error || 'Ошибка сохранения');
    }
  };

  const generateAI = async () => {
    setAiLoading(true);
    setError('');
    try {
      const res = await api.post('/ai/generate', {
        provider: campaign.ai_provider,
        template: form.message_template,
        lead: { username: 'example', full_name: '', niche: '' }
      });
      setForm(f => ({ ...f, message_template: res.message }));
      setEditMode(true);
    } catch (e) { setError(e.error || 'Ошибка AI'); }
    finally { setAiLoading(false); }
  };

  const handleAddLeads = async () => {
    if (!selectedNew.size) return;
    await api.post(`/campaigns/${id}/leads`, { contact_ids: [...selectedNew] });
    setShowAddLeads(false);
    setSelectedNew(new Set());
    load();
  };

  const openAddLeads = async () => {
    const res = await api.get('/contacts?limit=500');
    const existingUsernames = new Set(campaignLeads.map(l => l.username));
    setAllLeads((res.contacts || res).filter(l => !existingUsernames.has(l.username)));
    setShowAddLeads(true);
  };

  if (loading) return <div className="flex items-center justify-center h-full text-gray-400">Загрузка...</div>;
  if (!campaign) return <div className="text-center py-20 text-gray-400">Кампания не найдена</div>;

  const sentPercent = campaign.total_leads ? Math.round((campaign.sent_count / campaign.total_leads) * 100) : 0;
  const repliedCount = campaignLeads.filter(l => l.replied).length;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link to="/campaigns" className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-gray-900">{campaign.name}</h1>
              <CampaignStatusBadge status={campaign.status} />
            </div>
            <p className="text-gray-500 text-xs mt-0.5">ID #{campaign.id} · Создана {campaign.created_at?.slice(0, 10)}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {!editMode ? (
            <button onClick={() => { initForm(campaign); setEditMode(true); }} className="btn-secondary flex items-center gap-2 text-sm">
              <Settings size={15} /> Редактировать
            </button>
          ) : (
            <>
              <button onClick={() => setEditMode(false)} className="btn-secondary text-sm">Отмена</button>
              <button onClick={handleSave} className="btn-primary text-sm">Сохранить</button>
            </>
          )}
          {(campaign.status === 'running' || campaign.status === 'paused_by_schedule') ? (
            <button onClick={handlePause} className="btn-secondary flex items-center gap-2">
              <Pause size={15} /> {campaign.status === 'paused_by_schedule' ? 'Stop' : 'Pause'}
            </button>
          ) : campaign.status !== 'completed' ? (
            <button onClick={handleStart} className="btn-primary flex items-center gap-2">
              <Play size={15} /> Start
            </button>
          ) : null}
        </div>
      </div>

      {error && <div className="text-red-600 text-sm bg-red-50 rounded-lg px-4 py-3">{error}</div>}
      {success && <div className="text-green-600 text-sm bg-green-50 rounded-lg px-4 py-3">{success}</div>}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Всего лидов', value: campaign.total_leads, icon: Users, color: 'text-blue-500' },
          { label: 'Отправлено', value: campaign.sent_count, icon: Send, color: 'text-green-500' },
          { label: 'В очереди', value: campaign.pending_count, icon: Clock, color: 'text-yellow-500' },
          { label: 'Ответов', value: repliedCount, icon: MessageSquare, color: 'text-purple-500' },
          { label: 'Ошибок', value: campaign.failed_count, icon: AlertCircle, color: 'text-red-500' }
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card flex items-center gap-3">
            <Icon size={20} className={color} />
            <div>
              <div className="text-xl font-bold text-gray-900">{value}</div>
              <div className="text-xs text-gray-500">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {((campaign.failed_count || 0) + (campaign.skipped_count || 0)) > 0 && (
        <div className="flex items-center justify-between border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-4 py-3">
          <div className="text-sm text-amber-800 dark:text-amber-300">
            <span className="font-semibold">{(campaign.failed_count || 0) + (campaign.skipped_count || 0)}</span> лидов не удалось отправить с первого раза — Instagram или страница тормозили, кнопка «Сообщение» не нашлась и т.п.
            <div className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-0.5">Повторим отправку. Сгенерированное ИИ-сообщение уже сохранено — новые API-кредиты не потратятся.</div>
          </div>
          <button
            onClick={async () => {
              const total = (campaign.failed_count || 0) + (campaign.skipped_count || 0);
              if (!confirm(`Повторить отправку для ${total} лидов?\n\nЭто те, кому мы пытались написать, но получили ошибку (лаги Instagram, страница не догрузилась, кнопка не нашлась). Их персонализированные сообщения уже сохранены — ИИ повторно НЕ вызовется, кредиты не потратятся.`)) return;
              try {
                const res = await api.post(`/campaigns/${campaign.id}/restore-skipped`, { disable_skip_contacted: true, include_failed: true });
                const bd = res.breakdown || {};
                const parts = Object.entries(bd).map(([k, v]) => `${v} ${k}`).join(', ');
                alert(`Восстановлено ${res.restored} лидов${parts ? ` (${parts})` : ''}. При повторной отправке ИИ-сообщение будет взято из кэша.`);
                window.location.reload();
              } catch (e) {
                alert('Ошибка: ' + (e.error || e.message || 'неизвестно'));
              }
            }}
            className="text-sm font-semibold px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors whitespace-nowrap ml-3"
          >
            Повторить
          </button>
        </div>
      )}

      {campaign.total_leads > 0 && (
        <div className="card">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-500">Прогресс</span>
            <span className="text-gray-900 font-medium">{sentPercent}% · Reply Rate {campaign.sent_count > 0 ? Math.round((repliedCount / campaign.sent_count) * 100) : 0}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div className="bg-orange-500 h-2 rounded-full transition-all duration-500" style={{ width: `${sentPercent}%` }} />
          </div>
        </div>
      )}

      {campaign.offers_stats && Object.keys(campaign.offers_stats).length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Offer Performance</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 px-2 text-gray-600 font-medium">Offer</th>
                  <th className="text-right py-2 px-2 text-gray-600 font-medium">Sent</th>
                  <th className="text-right py-2 px-2 text-gray-600 font-medium">Replied</th>
                  <th className="text-right py-2 px-2 text-gray-600 font-medium">Rate %</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(campaign.offers_stats).map(([num, stats]) => (
                  <tr key={num} className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="py-2 px-2">
                      <span className="text-xs font-semibold text-gray-900">Offer {num}</span>
                      <div className="text-xs text-gray-500 mt-0.5 line-clamp-1">{stats.text}</div>
                    </td>
                    <td className="text-right py-2 px-2 text-gray-900 font-medium">{stats.sent}</td>
                    <td className="text-right py-2 px-2 text-green-600 font-medium">{stats.replied}</td>
                    <td className="text-right py-2 px-2 text-gray-900 font-semibold">{stats.rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editMode && (
        <div className="space-y-4">
          <div className="card space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">Основные настройки</h3>
            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Название</label>
              <input className="input text-sm" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-500 uppercase tracking-wider">Сообщение</label>
                <button onClick={generateAI} disabled={aiLoading} className="text-xs btn-secondary flex items-center gap-1 py-1">
                  <Sparkles size={12} className="text-orange-500" /> {aiLoading ? '...' : 'AI'}
                </button>
              </div>
              <textarea className="input resize-y text-sm" rows={4} value={form.message_template}
                onChange={e => setForm(f => ({ ...f, message_template: e.target.value }))} />
            </div>
          </div>

          <div className="card space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">Расписание и лимиты</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Лимит / день</label>
                <input type="number" className="input text-sm" min={1} max={50} value={form.daily_limit}
                  onChange={e => setForm(f => ({ ...f, daily_limit: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Мин. задержка (мин)</label>
                <input type="number" className="input text-sm" min={1} value={form.min_delay}
                  onChange={e => setForm(f => ({ ...f, min_delay: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Макс. задержка (мин)</label>
                <input type="number" className="input text-sm" min={1} value={form.max_delay}
                  onChange={e => setForm(f => ({ ...f, max_delay: Number(e.target.value) }))} />
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Стоимость лида</label>
              <input type="number" className="input text-sm w-32" min={0} value={form.value_per_lead}
                onChange={e => setForm(f => ({ ...f, value_per_lead: Number(e.target.value) }))} />
            </div>

            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-3 block">Рабочие часы (UTC+3)</label>
              <TimeRangeSlider
                startTime={form.schedule_start}
                endTime={form.schedule_end}
                onChangeStart={v => setForm(f => ({ ...f, schedule_start: v }))}
                onChangeEnd={v => setForm(f => ({ ...f, schedule_end: v }))}
              />
            </div>

            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-2 block">Дни отправки</label>
              <div className="flex gap-2">
                {DAYS.map(d => (
                  <button key={d.key} onClick={() => setForm(f => ({ ...f, schedule_days: { ...f.schedule_days, [d.key]: !f.schedule_days[d.key] } }))}
                    className={`w-10 h-10 rounded-lg text-xs font-semibold transition-colors ${
                      form.schedule_days[d.key] ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-gray-900">Поведение</h3>
            {[
              { key: 'follow_profile', label: 'Подписаться на профиль', desc: 'Подписаться перед отправкой DM' },
              { key: 'like_last_post', label: 'Лайк последнего поста', desc: 'Поставить лайк перед отправкой (Beta)' },
              { key: 'wait_for_reply', label: 'Ждать ответа', desc: 'Приостановить следующие действия до ответа' },
            ].map(r => (
              <div key={r.key} className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-800">{r.label}</div>
                  <div className="text-xs text-gray-500">{r.desc}</div>
                </div>
                <Toggle value={form[r.key]} onChange={v => setForm(f => ({ ...f, [r.key]: v }))} />
              </div>
            ))}

            {/* Prewarm: follow today, DM after a delay */}
            <div className="pt-1 border-t border-gray-100">
              <div className="flex items-center justify-between pt-3">
                <div>
                  <div className="text-sm font-medium text-gray-800">🔥 Прогрев лида <span className="text-[10px] text-orange-500 uppercase ml-1">Anti-ban</span></div>
                  <div className="text-xs text-gray-500">
                    {form.follow_profile
                      ? `Сначала подписка, затем DM через ${form.prewarm_delay_hours} ч`
                      : 'Требует включённой подписки на профиль'}
                  </div>
                </div>
                <Toggle
                  value={form.prewarm_follow && form.follow_profile}
                  onChange={v => setForm(f => ({ ...f, prewarm_follow: v, follow_profile: v ? true : f.follow_profile }))}
                />
              </div>
              {form.prewarm_follow && form.follow_profile && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-gray-500">Задержка перед DM:</span>
                  <select
                    value={form.prewarm_delay_hours}
                    onChange={e => setForm(f => ({ ...f, prewarm_delay_hours: Number(e.target.value) }))}
                    className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-white text-gray-800"
                  >
                    <option value={6}>6 часов</option>
                    <option value={12}>12 часов</option>
                    <option value={24}>24 часа</option>
                    <option value={48}>48 часов</option>
                  </select>
                </div>
              )}
            </div>
          </div>

          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-gray-900">Правила безопасности</h3>
            <p className="text-xs text-gray-500">Всегда активны для защиты аккаунта.</p>
            {[
              { label: 'Пропускать уже отправленных', desc: 'Не отправлять повторно' },
              { label: 'Остановить при ответе', desc: 'Прекратить кампанию для ответившего' },
              { label: 'Пауза при ошибках', desc: 'Приостановить если Instagram блокирует' },
              { label: 'Безопасные задержки', desc: 'Случайные паузы между сообщениями' },
              { label: 'Прогрев аккаунта', desc: 'Ограничения отправки при активном прогреве' },
            ].map(r => (
              <div key={r.label} className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-800">{r.label}</div>
                  <div className="text-xs text-gray-500">{r.desc}</div>
                </div>
                <div className="flex items-center gap-1.5 text-green-500 flex-shrink-0">
                  <Check size={16} />
                  <span className="text-xs font-medium">Всегда вкл.</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!editMode && (
        <>
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Сообщение кампании</h2>
              <button onClick={generateAI} disabled={aiLoading} className="text-xs btn-secondary flex items-center gap-1 py-1.5">
                <Sparkles size={13} className="text-orange-500" /> {aiLoading ? '...' : 'AI перегенерировать'}
              </button>
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm text-gray-800 whitespace-pre-wrap">{campaign.message_template}</div>
            <div className="flex flex-wrap gap-2 text-xs text-gray-400">
              <span>Задержка: {campaign.min_delay || 7}–{campaign.max_delay || 17} мин</span>
              <span>·</span>
              <span>Лимит: {campaign.daily_limit || 15}/день</span>
              <span>·</span>
              <span>Часы: {campaign.schedule_start || '09:00'}–{campaign.schedule_end || '18:00'} UTC+3</span>
              {campaign.like_last_post ? <><span>·</span><span className="text-orange-500">Лайк поста</span></> : null}
              {campaign.prewarm_follow && campaign.follow_profile ? <><span>·</span><span className="text-orange-500">🔥 Прогрев {campaign.prewarm_delay_hours || 24}ч</span></> : null}
            </div>
          </div>

          {campaign.status === 'running' && (
            <div className="card border-orange-200 bg-orange-50">
              <div className="flex items-start gap-3">
                <div className="text-2xl">🔌</div>
                <div>
                  <div className="text-sm font-semibold text-orange-700">Расширение активно</div>
                  <p className="text-xs text-gray-500 mt-1">Откройте расширение Instalead в браузере для автоматической отправки.</p>
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
            {[
              { key: 'leads', label: `Лиды (${campaignLeads.length})`, icon: Users },
              { key: 'logs', label: `Логи (${logs.length})`, icon: ScrollText },
            ].map(t => (
              <button key={t.key} onClick={() => setActiveTab(t.key)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}>
                <t.icon size={14} /> {t.label}
              </button>
            ))}
          </div>

          {activeTab === 'leads' && (
            <div className="card p-0 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <h2 className="text-sm font-semibold text-gray-900">Лиды кампании</h2>
                <button onClick={openAddLeads} className="text-xs btn-secondary flex items-center gap-1 py-1.5">
                  <Plus size={13} /> Добавить
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-200">
                    <tr className="text-left text-gray-500 text-xs uppercase tracking-wider">
                      <th className="px-4 py-2.5">Username</th>
                      <th className="px-4 py-2.5">Сообщение</th>
                      <th className="px-4 py-2.5">Статус</th>
                      <th className="px-4 py-2.5">Ответ</th>
                      <th className="px-4 py-2.5">Отправлено</th>
                      <th className="px-4 py-2.5">Действия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {campaignLeads.length === 0 ? (
                      <tr><td colSpan={5} className="text-center py-8 text-gray-400">Нет лидов</td></tr>
                    ) : campaignLeads.map(lead => {
                      const s = STATUS_MAP[lead.campaign_status] || { label: lead.campaign_status, cls: 'badge-gray' };
                      return (
                        <tr key={lead.id} className={`hover:bg-gray-50 ${lead.replied ? 'bg-purple-50/30' : ''}`}>
                          <td className="px-4 py-2.5">
                            <a href={`https://instagram.com/${lead.username}`} target="_blank" rel="noopener noreferrer"
                              className="text-orange-600 hover:text-orange-500">@{lead.username}</a>
                            {lead.full_name && <div className="text-xs text-gray-400">{lead.full_name}</div>}
                          </td>
                          <td className="px-4 py-2.5 max-w-xs">
                            <div className="text-xs text-gray-500 truncate">{lead.message_sent || <span className="text-gray-300 italic">шаблон</span>}</div>
                          </td>
                          <td className="px-4 py-2.5"><span className={s.cls}>{s.label}</span></td>
                          <td className="px-4 py-2.5">
                            {lead.replied ? (
                              <div>
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-50 text-purple-700">Ответил</span>
                                {lead.reply_text && <div className="text-xs text-gray-500 mt-1 truncate max-w-[200px]">{lead.reply_text}</div>}
                                {lead.replied_at && <div className="text-xs text-gray-400 mt-0.5">{lead.replied_at?.slice(0, 16)}</div>}
                              </div>
                            ) : (
                              <span className="text-xs text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-400">{lead.sent_at?.slice(0, 16) || '—'}</td>
                          <td className="px-4 py-2.5">
                            {lead.campaign_status !== 'pending' && (
                              <button onClick={async () => {
                                try {
                                  await api.post(`/campaigns/${id}/leads/${lead.cl_id}/reset`);
                                  load();
                                } catch (e) { console.error(e); }
                              }} className="text-xs px-2 py-1 rounded text-orange-600 hover:bg-orange-50 border border-orange-200">
                                Сброс
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {campaignLeads.some(l => l.campaign_status !== 'pending') && (
                <div className="px-4 py-3 border-t border-gray-200 bg-gray-50">
                  <button onClick={async () => {
                    if (!confirm('Обнулить статус ВСЕх лидов и сделать их новыми для системы?')) return;
                    try {
                      await api.post(`/campaigns/${id}/reset-all-leads`);
                      load();
                    } catch (e) { console.error(e); }
                  }} className="text-xs px-3 py-1.5 rounded text-orange-600 hover:bg-orange-100 border border-orange-200 font-medium">
                    🔄 Обнулить всех
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="card">
              <h2 className="text-sm font-semibold text-gray-900 mb-3">Логи кампании</h2>
              {logs.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">Нет записей</div>
              ) : (
                <div className="divide-y divide-gray-100 max-h-[500px] overflow-y-auto">
                  {logs.map(log => <LogEvent key={log.id} log={log} />)}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {showAddLeads && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-xl">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="font-semibold text-gray-900">Добавить лиды</h3>
              <button onClick={() => setShowAddLeads(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-1">
              {allLeads.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">Все лиды уже добавлены</div>
              ) : allLeads.map(lead => (
                <label key={lead.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-50 cursor-pointer">
                  <input type="checkbox" checked={selectedNew.has(lead.id)}
                    onChange={() => setSelectedNew(prev => { const n = new Set(prev); n.has(lead.id) ? n.delete(lead.id) : n.add(lead.id); return n; })}
                    className="accent-orange-500" />
                  <div>
                    <div className="text-sm text-gray-800">@{lead.username}</div>
                    {lead.niche && <div className="text-xs text-gray-400">{lead.niche}</div>}
                  </div>
                </label>
              ))}
            </div>
            <div className="flex gap-3 p-4 border-t border-gray-200">
              <button onClick={() => setShowAddLeads(false)} className="btn-secondary flex-1">Отмена</button>
              <button onClick={handleAddLeads} disabled={!selectedNew.size} className="btn-primary flex-1">
                Добавить ({selectedNew.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
