import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Play, Pause, Trash2, ChevronRight, ChevronLeft, Clock, Users, Send, Archive, ArrowLeft, Check, MoreVertical, RotateCcw, UserPlus, Eye } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import api from '../utils/api.js';
import { prepareOutboundMessage } from '../utils/messageText.js';

function getContactFirstName(contact) {
  return String(contact?.full_name || '').trim().split(/\s+/).filter(Boolean)[0] || '';
}

function StatusBadge({ status }) {
  const map = {
    draft: { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-600 dark:text-gray-300', label: 'Draft' },
    scheduled: { bg: 'bg-yellow-50 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400', label: 'Scheduled' },
    running: { bg: 'bg-green-50 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400', label: 'Active' },
    paused: { bg: 'bg-blue-50 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400', label: 'Stopped' },
    paused_by_schedule: { bg: 'bg-amber-50 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400', label: 'Sleeping' },
    completed: { bg: 'bg-orange-50 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400', label: 'Completed' },
  };
  const s = map[status] || map.draft;
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${s.bg} ${s.text}`}>{s.label}</span>;
}

const DAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

function Toggle({ value, onChange }) {
  return (
    <button onClick={() => onChange(!value)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-green-500' : 'bg-gray-300'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow ${value ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

function StepIndicator({ steps, current }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((s, i) => (
        <div key={i} className={`flex-1 flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
          i + 1 < current ? 'bg-white border-gray-200' :
          i + 1 === current ? 'bg-white border-gray-300 shadow-sm' :
          'bg-gray-50 border-gray-100'
        }`}>
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
            i + 1 < current ? 'bg-green-500 text-white' :
            i + 1 === current ? 'bg-gray-800 text-white' :
            'bg-gray-200 text-gray-400'
          }`}>
            {i + 1 < current ? <Check size={14} /> : i + 1}
          </div>
          <div>
            <div className="text-[10px] text-gray-400 uppercase tracking-wider">Step {i + 1}</div>
            <div className={`text-sm font-medium ${i + 1 <= current ? 'text-gray-900' : 'text-gray-400'}`}>{s}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TimeRangeSlider({ startTime, endTime, onChangeStart, onChangeEnd }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(null);

  const timeToHour = (t) => {
    const [h, m] = (t || '09:00').split(':').map(Number);
    return h + m / 60;
  };
  const hourToTime = (h) => {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
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

    const onMove = (ev) => {
      ev.preventDefault();
      const h = getHourFromEvent(ev);
      if (draggingRef.current === 'start') {
        if (h < endH - 0.5) onChangeStart(hourToTime(h));
      } else {
        if (h > startH + 0.5) onChangeEnd(hourToTime(h));
      }
    };
    const onUp = () => {
      draggingRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }, [startH, endH, getHourFromEvent, onChangeStart, onChangeEnd]);

  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-900">{startTime}</span>
        <span className="text-sm font-semibold text-gray-900">{endTime}</span>
      </div>
      <div ref={trackRef} className="relative h-3 bg-gray-200 rounded-full cursor-pointer" style={{ touchAction: 'none' }}>
        <div className="absolute h-3 bg-orange-400 rounded-full" style={{
          left: `${hourToPercent(startH)}%`,
          right: `${100 - hourToPercent(endH)}%`
        }} />
        <div
          className="absolute w-5 h-5 bg-white border-2 border-orange-500 rounded-full shadow-md cursor-grab active:cursor-grabbing"
          style={{ left: `${hourToPercent(startH)}%`, top: '50%', transform: 'translate(-50%, -50%)' }}
          onMouseDown={(e) => handlePointerDown('start', e)}
          onTouchStart={(e) => handlePointerDown('start', e)}
        />
        <div
          className="absolute w-5 h-5 bg-white border-2 border-orange-500 rounded-full shadow-md cursor-grab active:cursor-grabbing"
          style={{ left: `${hourToPercent(endH)}%`, top: '50%', transform: 'translate(-50%, -50%)' }}
          onMouseDown={(e) => handlePointerDown('end', e)}
          onTouchStart={(e) => handlePointerDown('end', e)}
        />
      </div>
      <div className="relative mt-1.5 h-4">
        {hours.map(h => (
          <span key={h} className="absolute text-[10px] text-gray-400 tabular-nums" style={{ left: `${hourToPercent(h)}%`, transform: 'translateX(-50%)' }}>
            {h === 24 ? '24' : String(h).padStart(2, '0')}
          </span>
        ))}
      </div>
    </div>
  );
}

const DRAFT_KEY = 'instalead_campaign_draft';

function CreateCampaign({ onBack, onCreated, editDraftId }) {
  const savedDraft = (() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } })();
  const [step, setStep] = useState(savedDraft?.step || 1);
  const [leads, setLeads] = useState([]);
  const [selectedLeads, setSelectedLeads] = useState(new Set(savedDraft?.selectedLeads || []));
  const [searchLead, setSearchLead] = useState('');
  const [account, setAccount] = useState(null);
  const [aiAgentStatus, setAiAgentStatus] = useState({ configured: false, loading: true });
  const defaultForm = {
    name: '',
    message_template: '',
    offers: [''],
    personalization_mode: 'personalized',
    personalization_style: 'neutral',
    personalization_custom_prompt: '',
    ai_prompt: '',
    follow_profile: true,
    like_last_post: false,
    prewarm_follow: false,
    prewarm_delay_hours: 24,
    wait_for_reply: true,
    daily_limit: 15,
    value_per_lead: 0,
    schedule_days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
    schedule_start: '09:00',
    schedule_end: '18:00',
    skip_contacted: true,
    stop_on_reply: true,
    pause_unsafe: true,
    safe_delays: true,
    warmup: true,
  };
  const [form, setForm] = useState(() => {
    const draft = savedDraft?.form || defaultForm;
    return {
      ...draft,
      // A campaign has exactly one message offer.
      offers: draft.offers && Array.isArray(draft.offers) ? [draft.offers[0] || ''] : ['']
    };
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [previewLead, setPreviewLead] = useState(null);
  const [previewMessage, setPreviewMessage] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPersonalization, setPreviewPersonalization] = useState(null);
  const [previewSignature, setPreviewSignature] = useState('');
  const [warmup, setWarmup] = useState(null);
  const [savedPrompts, setSavedPrompts] = useState({ templates: [], from_campaigns: [] });
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [savePromptName, setSavePromptName] = useState('');
  const [promptDropdownOpen, setPromptDropdownOpen] = useState(false);
  const promptDropdownRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const draft = { step, form, selectedLeads: [...selectedLeads] };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [step, form, selectedLeads]);

  useEffect(() => {
    const handleClick = (e) => { if (promptDropdownRef.current && !promptDropdownRef.current.contains(e.target)) setPromptDropdownOpen(false); };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const loadSavedPrompts = () => {
    api.get('/campaigns/prompts/saved').then(setSavedPrompts).catch(() => {});
  };

  const handleSavePrompt = async () => {
    if (!savePromptName.trim() || !form.ai_prompt.trim()) return;
    await api.post('/campaigns/prompts/saved', { name: savePromptName.trim(), prompt: form.ai_prompt });
    setSavePromptName('');
    setShowSavePrompt(false);
    loadSavedPrompts();
  };

  const handleDeletePrompt = async (id) => {
    await api.delete(`/campaigns/prompts/saved/${id}`);
    loadSavedPrompts();
  };

  useEffect(() => {
    api.get('/contacts?limit=500').then(r => setLeads(r.contacts || r || []));
    api.get('/extension/account').then(r => setAccount(r.username));
    api.get('/ai-agents/status').then(setAiAgentStatus).catch(() => setAiAgentStatus({ configured: false, loading: false }));
    loadSavedPrompts();
    api.get('/accounts/warmup').then(w => {
      setWarmup(w);
      if (w.enabled && form.daily_limit > w.max_messages) {
        setForm(f => ({ ...f, daily_limit: w.max_messages }));
      }
    }).catch(() => {});
  }, []);

  const filteredLeads = leads.filter(l =>
    !searchLead || l.username.includes(searchLead) || (l.full_name || '').toLowerCase().includes(searchLead.toLowerCase())
  );

  const toggleLead = (id) => {
    setSelectedLeads(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedLeads.size === filteredLeads.length) setSelectedLeads(new Set());
    else setSelectedLeads(new Set(filteredLeads.map(l => l.id)));
  };

  const insertFirstName = () => {
    setForm(f => ({ ...f, message_template: f.message_template + '{first_name}' }));
  };

  const handleLaunch = async () => {
    if (!form.name.trim()) return setError('Название обязательно');
    if (form.personalization_mode === 'personalized' && !aiAgentStatus.configured) {
      return setError('Настройте AI Agent (API ключ и бизнес-контекст), чтобы включить персонализацию.');
    }
    const personalizationEnabled = form.personalization_mode === 'personalized';
    const validOffers = form.offers.filter(o => o && o.trim()).slice(0, 1);
    if (!personalizationEnabled && !validOffers.length) {
      return setError('Персонализация выключена: добавьте оффер для сообщения.');
    }
    setLoading(true);
    setError('');
    try {
      const activeDays = Object.entries(form.schedule_days).filter(([, v]) => v).map(([k]) => k).join(',');
      const campaign = await api.post('/campaigns', {
        name: form.name,
        // With personalization enabled the campaign gets its offer directly
        // from AI Agent. Do not duplicate it in the campaign form.
        message_template: personalizationEnabled ? '' : validOffers[0],
        offers: personalizationEnabled ? [] : validOffers,
        ai_generated: personalizationEnabled ? 1 : 0,
        ai_prompt: null,
        personalization_mode: form.personalization_mode,
        personalization_style: form.personalization_style,
        personalization_custom_prompt: form.personalization_mode === 'personalized' && form.personalization_style === 'custom' ? form.personalization_custom_prompt : null,
        daily_limit: form.daily_limit,
        send_time: form.schedule_start,
        min_delay: 7,
        max_delay: 17,
        follow_profile: form.follow_profile ? 1 : 0,
        like_last_post: form.like_last_post ? 1 : 0,
        prewarm_follow: form.prewarm_follow ? 1 : 0,
        prewarm_delay_hours: form.prewarm_delay_hours || 24,
        wait_for_reply: form.wait_for_reply ? 1 : 0,
        value_per_lead: form.value_per_lead,
        schedule_days: activeDays,
        schedule_start: form.schedule_start,
        schedule_end: form.schedule_end,
        skip_contacted: form.skip_contacted ? 1 : 0,
        stop_on_reply: 1,
        pause_unsafe: 1,
        safe_delays: 1,
        warmup: 1,
        contact_ids: [...selectedLeads],
        preview_contact_id: previewIsCurrent ? previewLead.id : null,
        preview_message: previewIsCurrent ? previewMessage : null,
        preview_personalization: previewIsCurrent ? previewPersonalization : null,
      });
      await api.post(`/campaigns/${campaign.id}/start`);
      localStorage.removeItem(DRAFT_KEY);
      onCreated();
      navigate(`/campaigns/${campaign.id}`);
    } catch (e) {
      setError(e.error || 'Ошибка создания');
      setLoading(false);
    }
  };

  const activeDaysList = DAYS.filter(d => form.schedule_days[d.key]);
  const estDays = selectedLeads.size > 0 ? Math.ceil(selectedLeads.size / form.daily_limit) : 0;
  const currentPreviewSignature = (leadId = previewLead?.id) => JSON.stringify({
    leadId: leadId || null,
    personalization_mode: form.personalization_mode,
    message_template: form.message_template,
    personalization_style: form.personalization_style,
    personalization_custom_prompt: form.personalization_custom_prompt,
    ai_agent_version: previewPersonalization?.ai_agent_version || aiAgentStatus.ai_agent_version || 0,
  });
  const previewIsCurrent = Boolean(previewLead && previewMessage && previewSignature === currentPreviewSignature());

  const stepTitles = ['Name campaign', 'Build audience', 'Build workflow', 'Schedule & Safety', 'Review & launch'];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-orange-600 hover:text-orange-700 mb-4">
        <ArrowLeft size={16} /> Back to Campaigns
      </button>

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-xl font-bold text-gray-900">Create campaign</h1>
        <span className="inline-flex items-center gap-1.5 text-xs text-orange-600">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-500" /> Draft
        </span>
      </div>

      <StepIndicator steps={stepTitles} current={step} />

      {error && <div className="text-red-600 text-sm bg-red-50 rounded-lg px-4 py-2.5 mb-4 border border-red-200">{error}</div>}

      {/* Step 1: Name */}
      {step === 1 && (
        <div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Step 1 of 5</div>
          <h2 className="text-xl font-bold text-gray-900 mb-1">Name campaign</h2>
          <p className="text-sm text-gray-500 mb-6">Give your campaign a name to organize it.</p>
          <div className="card">
            <label className="text-xs text-gray-500 uppercase tracking-wider mb-2 block">Campaign name</label>
            <input className="input text-base" placeholder="My Campaign" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
          </div>
        </div>
      )}

      {/* Step 2: Build audience */}
      {step === 2 && (
        <div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Step 2 of 5</div>
          <h2 className="text-xl font-bold text-gray-900 mb-1">Build audience</h2>
          <p className="text-sm text-gray-500 mb-6">Select contacts who will receive your messages.</p>
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <input className="input text-sm max-w-xs" placeholder="Search contacts..." value={searchLead}
                onChange={e => setSearchLead(e.target.value)} />
              <div className="flex items-center gap-3">
                <Link to="/contacts" className="text-xs text-blue-600 hover:text-blue-700 font-medium">Manage contacts</Link>
                <button onClick={selectAll} className="text-xs text-orange-600 hover:text-orange-700 font-medium">
                  {selectedLeads.size === filteredLeads.length ? 'Deselect all' : 'Select all'}
                </button>
                <span className="text-xs bg-gray-100 dark:bg-gray-700 px-2.5 py-1 rounded-full text-gray-600 dark:text-gray-300 font-medium">{selectedLeads.size} selected</span>
              </div>
            </div>
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {filteredLeads.map(lead => (
                <label key={lead.id} className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                  selectedLeads.has(lead.id) ? 'bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800' : 'hover:bg-gray-50 dark:hover:bg-gray-800 border border-transparent'
                }`}>
                  <input type="checkbox" checked={selectedLeads.has(lead.id)} onChange={() => toggleLead(lead.id)}
                    className="accent-orange-500 w-4 h-4" />
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-pink-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                    {(lead.username || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-200">@{lead.username}</div>
                    {lead.full_name && <div className="text-xs text-gray-500 dark:text-gray-400">{lead.full_name}</div>}
                  </div>
                  {lead.lead_quality && lead.lead_quality !== 'unknown' && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                      lead.lead_quality === 'hot' ? 'bg-red-100 text-red-700' :
                      lead.lead_quality === 'warm' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-blue-100 text-blue-700'
                    }`}>{lead.lead_quality}</span>
                  )}
                </label>
              ))}
              {filteredLeads.length === 0 && (
                <div className="text-center py-10 text-gray-400 text-sm">
                  No contacts found. <Link to="/contacts" className="text-orange-600 hover:text-orange-700">Add contacts</Link> first.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Build workflow */}
      {step === 3 && (() => {
        console.log('[Step3] form:', form);
        return (
        <div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Step 3 of 5</div>
          <h2 className="text-xl font-bold text-gray-900 mb-1">Build workflow</h2>
          <p className="text-sm text-gray-500 mb-6">Choose what happens to each recipient.</p>

          <div className="space-y-4">
            {/* Follow profile */}
            <div className="card flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-gray-500">
                  <Users size={18} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">Follow profile <span className="text-[10px] text-gray-400 uppercase ml-1">Optional</span></div>
                  <div className="text-xs text-gray-500">{form.follow_profile ? 'On' : 'Off'}</div>
                </div>
              </div>
              <Toggle value={form.follow_profile} onChange={v => setForm(f => ({ ...f, follow_profile: v }))} />
            </div>

            {/* Like last post */}
            <div className="card flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-gray-500">
                  <span className="text-lg">❤️</span>
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">Like last post <span className="text-[10px] text-orange-500 uppercase ml-1">Beta</span></div>
                  <div className="text-xs text-gray-500">{form.like_last_post ? 'On' : 'Off'} — Like the lead's latest post before sending DM</div>
                </div>
              </div>
              <Toggle value={form.like_last_post} onChange={v => setForm(f => ({ ...f, like_last_post: v }))} />
            </div>

            {/* Prewarm: follow today, DM tomorrow */}
            <div className="card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-gray-500">
                    <span className="text-lg">🔥</span>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-gray-900">Прогрев лида <span className="text-[10px] text-orange-500 uppercase ml-1">Anti-ban</span></div>
                    <div className="text-xs text-gray-500">
                      {form.follow_profile
                        ? (form.prewarm_follow
                            ? `Сначала подписка, затем DM через ${form.prewarm_delay_hours} ч — как живой человек`
                            : 'Off — подписка и DM в одной сессии')
                        : 'Требует включённой подписки на профиль'}
                    </div>
                  </div>
                </div>
                <Toggle
                  value={form.prewarm_follow && form.follow_profile}
                  onChange={v => setForm(f => ({ ...f, prewarm_follow: v, follow_profile: v ? true : f.follow_profile }))}
                />
              </div>
              {form.prewarm_follow && form.follow_profile && (
                <div className="mt-3 flex items-center gap-2 pl-12">
                  <span className="text-xs text-gray-500">Задержка перед DM:</span>
                  <select
                    value={form.prewarm_delay_hours}
                    onChange={e => setForm(f => ({ ...f, prewarm_delay_hours: Number(e.target.value) }))}
                    className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-white text-gray-800"
                  >
                    <option value={6}>6 часов</option>
                    <option value={12}>12 часов</option>
                    <option value={24}>24 часа (рекоменд.)</option>
                    <option value={48}>48 часов</option>
                  </select>
                </div>
              )}
            </div>

            {/* First DM */}
            <div className="card">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-gray-500">
                  <Send size={18} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">First DM <span className="text-[10px] text-gray-400 uppercase ml-1">Required</span></div>
                  <div className="text-xs text-gray-500">{form.personalization_mode === 'template' ? 'Template' : 'Template + personalization'}</div>
                </div>
              </div>

              <div className="card border border-gray-200 mb-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">AI-персонализация</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {form.personalization_mode === 'personalized'
                        ? 'Включена. Оффер, CTA и стиль берутся из AI Agent, а для каждого лида создаётся отдельное сообщение.'
                        : 'Выключена. Будет отправляться оффер из поля сообщения без AI-персонализации.'}
                    </div>
                  </div>
                  <Toggle
                    value={form.personalization_mode === 'personalized'}
                    onChange={enabled => setForm(f => ({
                      ...f,
                      personalization_mode: enabled ? 'personalized' : 'template'
                    }))}
                  />
                </div>
                {form.personalization_mode === 'personalized' && (
                  <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-600">
                    <div className="font-medium text-slate-700 mb-1">AI Agent → персонализация</div>
                    AI использует конспект лида и настройки AI Agent. Отдельно писать оффер здесь не нужно. Если AI Agent не настроен, запуск будет заблокирован.
                  </div>
                )}
              </div>

              {form.personalization_mode !== 'personalized' && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">Оффер / Message template</label>
                  <button type="button" onClick={insertFirstName} className="text-xs text-slate-700 hover:text-slate-900 font-medium">+ Добавить {"{first_name}"}</button>
                </div>
                <p className="text-xs text-gray-500 mb-3">Один шаблон сообщения. Используйте {"{first_name}"}, чтобы автоматически подставить имя лида.</p>
                <div className="space-y-2">
                  {form.offers.map((offer, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center">
                        <span className="text-xs font-semibold text-gray-600">{idx + 1}</span>
                      </div>
                      <textarea
                        className="input resize-y font-normal flex-1"
                        rows={3}
                        value={offer}
                        placeholder={`Offer ${idx + 1} text...`}
                        onChange={e => setForm(f => ({ ...f, offers: f.offers.map((o, i) => i === idx ? e.target.value : o) }))}
                      />

                    </div>
                  ))}
                </div>
                {false && form.offers.length < 8 && (
                  <button
                    onClick={() => setForm(f => ({ ...f, offers: [f.offers[0] || ''] }))}
                    className="mt-3 text-xs text-orange-600 hover:text-orange-700 font-medium flex items-center gap-1 px-3 py-1.5 bg-orange-50 rounded-lg hover:bg-orange-100 transition-colors"
                  >
                    <Plus size={14} /> Add Offer (max {8 - form.offers.length} more)
                  </button>
                )}
              </div>
              )}

              {false && form.personalization_mode === 'personalized' && (
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
                        <span className="text-purple-600 dark:text-purple-400 text-xs font-bold">AI</span>
                      </div>
                      <label className="text-sm font-medium text-gray-700 dark:text-gray-200">AI Personalization Prompt</label>
                    </div>
                    <div className="relative" ref={promptDropdownRef}>
                      <button
                        onClick={() => setPromptDropdownOpen(!promptDropdownOpen)}
                        className="text-xs text-purple-600 hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300 font-medium flex items-center gap-1 px-2.5 py-1.5 rounded-lg hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
                        Saved prompts
                      </button>
                      {promptDropdownOpen && (
                        <div className="absolute right-0 top-full mt-1 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl shadow-xl z-30 overflow-hidden">
                          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
                            <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">Saved templates</div>
                          </div>
                          <div className="max-h-48 overflow-y-auto">
                            {savedPrompts.templates.length === 0 && savedPrompts.from_campaigns.length === 0 ? (
                              <div className="px-3 py-4 text-xs text-gray-400 text-center">No saved prompts yet</div>
                            ) : (
                              <>
                                {savedPrompts.templates.map(t => (
                                  <div key={`t-${t.id}`} className="flex items-start gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 group">
                                    <button
                                      onClick={() => { setForm(f => ({ ...f, ai_prompt: t.prompt })); setPromptDropdownOpen(false); }}
                                      className="flex-1 text-left"
                                    >
                                      <div className="text-xs font-medium text-gray-800 dark:text-gray-200">{t.name}</div>
                                      <div className="text-[11px] text-gray-400 line-clamp-2 mt-0.5">{t.prompt}</div>
                                    </button>
                                    <button onClick={() => handleDeletePrompt(t.id)} className="p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                ))}
                                {savedPrompts.from_campaigns.length > 0 && (
                                  <>
                                    <div className="px-3 py-1.5 border-t border-gray-100 dark:border-gray-700">
                                      <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">From past campaigns</div>
                                    </div>
                                    {savedPrompts.from_campaigns.map((prompt, i) => (
                                      <button
                                        key={`c-${i}`}
                                        onClick={() => { setForm(f => ({ ...f, ai_prompt: prompt })); setPromptDropdownOpen(false); }}
                                        className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700"
                                      >
                                        <div className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2">{prompt}</div>
                                      </button>
                                    ))}
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    Instruct the AI how to personalize each message. The AI will visit each lead's profile, analyze their bio and posts, and modify your message template accordingly.
                  </p>
                  <textarea className="input resize-y font-normal" rows={4} value={form.ai_prompt}
                    placeholder="Example: Take a fact from the lead's bio and insert a personalized compliment between the greeting and the main offer. If the lead has recent posts, mention something relevant from their latest post."
                    onChange={e => setForm(f => ({ ...f, ai_prompt: e.target.value }))} />
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-xs text-gray-400">Model: Claude Sonnet 4 via OpenRouter. API key must be set in Integrations.</p>
                    {form.ai_prompt.trim() && (
                      showSavePrompt ? (
                        <div className="flex items-center gap-2">
                          <input
                            className="input text-xs py-1 px-2 w-40"
                            placeholder="Prompt name..."
                            value={savePromptName}
                            onChange={e => setSavePromptName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleSavePrompt()}
                            autoFocus
                          />
                          <button onClick={handleSavePrompt} className="text-xs text-green-600 hover:text-green-700 font-medium">Save</button>
                          <button onClick={() => setShowSavePrompt(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setShowSavePrompt(true)} className="text-xs text-purple-600 hover:text-purple-700 dark:text-purple-400 font-medium flex items-center gap-1">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
                          Save prompt
                        </button>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Wait for reply */}
            <div className="card flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-gray-500">
                  <Clock size={18} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">Wait for reply</div>
                  <div className="text-xs text-gray-500">Always on</div>
                </div>
              </div>
              <Toggle value={form.wait_for_reply} onChange={v => setForm(f => ({ ...f, wait_for_reply: v }))} />
            </div>
          </div>
        </div>
        );
      })()}

      {/* Step 4: Schedule & Safety */}
      {step === 4 && (
        <div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Step 4 of 5</div>
          <h2 className="text-xl font-bold text-gray-900 mb-1">Schedule & Safety</h2>
          <p className="text-sm text-gray-500 mb-6">Choose when this campaign can send and how many messages it can use per day.</p>

          <div className="space-y-4">
            {/* Sending Account */}
            <div className="card flex items-center justify-between">
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-wider">Sending Account</div>
                <div className="text-sm text-gray-500">Messages send from this account.</div>
              </div>
              <div className="text-sm font-semibold text-gray-900">@{account || '—'}</div>
            </div>

            {/* Daily Outreach Limit */}
            <div className="card">
              <div className="flex items-center justify-between mb-1">
                <div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">Daily Outreach Limit</div>
                  <div className="text-sm text-gray-500">Set the daily pace for cold outreach.</div>
                </div>
                <div className="flex items-center gap-2">
                  <input type="number" className="input w-20 text-center text-sm font-semibold" min={1}
                    max={warmup?.enabled ? warmup.max_messages : 50}
                    value={form.daily_limit} onChange={e => {
                      let val = Number(e.target.value);
                      if (warmup?.enabled && val > warmup.max_messages) val = warmup.max_messages;
                      setForm(f => ({ ...f, daily_limit: val }));
                    }} />
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-2">Max {form.daily_limit}/day</p>
              {warmup?.enabled && (
                <p className="text-xs text-orange-500">Warm-up active: max {warmup.max_messages} DMs/day enforced.</p>
              )}
              <p className="text-xs text-gray-500 mt-1">Estimated pace: about {form.daily_limit} leads/day in this schedule.</p>
            </div>

            {/* Value per Lead */}
            <div className="card">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">Value Per Lead *</div>
                  <div className="text-sm text-gray-500">Your estimate of what one lead is worth. Powers campaign value and your analytics.</div>
                </div>
                <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
                  <span className="px-3 py-2 bg-gray-50 text-sm text-gray-500 border-r border-gray-300">$</span>
                  <input type="number" className="w-20 px-3 py-2 text-sm text-right focus:outline-none" min={0}
                    value={form.value_per_lead} onChange={e => setForm(f => ({ ...f, value_per_lead: Number(e.target.value) }))} />
                </div>
              </div>
            </div>

            {/* Sending Schedule */}
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-sm font-semibold text-gray-900">Sending Schedule</div>
                  <div className="text-xs text-gray-500">Pick the days and hours this campaign is allowed to send.</div>
                </div>
                <div className="text-xs text-gray-500 font-medium">UTC+3 (Moscow)</div>
              </div>

              <div className="mb-5">
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">Working Hours</div>
                <TimeRangeSlider
                  startTime={form.schedule_start}
                  endTime={form.schedule_end}
                  onChangeStart={v => setForm(f => ({ ...f, schedule_start: v }))}
                  onChangeEnd={v => setForm(f => ({ ...f, schedule_end: v }))}
                />
              </div>

              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Send Days</div>
                <div className="flex gap-2">
                  {DAYS.map(d => (
                    <button key={d.key}
                      onClick={() => setForm(f => ({ ...f, schedule_days: { ...f.schedule_days, [d.key]: !f.schedule_days[d.key] } }))}
                      className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                        form.schedule_days[d.key] ? 'bg-orange-500 text-white shadow-sm' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}>
                      {d.label.slice(0, 3)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Sending Mode */}
            <div className="card">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-gray-900">Sending mode</div>
                  <div className="text-xs text-gray-500">Managed from the Accounts page.</div>
                </div>
                {warmup?.enabled ? (
                  <div className="text-right">
                    <span className="text-xs font-semibold text-orange-600">Warm-up · Day {warmup.day_number} of 21</span>
                    <div className="w-32 bg-gray-200 rounded-full h-1.5 mt-1">
                      <div className="bg-orange-500 h-1.5 rounded-full" style={{ width: `${Math.min(100, (warmup.day_number / 21) * 100)}%` }} />
                    </div>
                    <div className="text-[10px] text-gray-400 mt-0.5">Max {warmup.max_messages} DMs/day</div>
                  </div>
                ) : warmup?.warmed_up ? (
                  <div className="flex items-center gap-1.5 text-sm text-green-600 font-medium">
                    <Check size={16} /> Warmed up
                  </div>
                ) : (
                  <span className="text-xs text-gray-500 font-medium">Default</span>
                )}
              </div>
            </div>

            {/* Safety Rules — always on */}
            <div className="card">
              <div className="mb-4">
                <div className="text-sm font-semibold text-gray-900">Safety Rules</div>
                <div className="text-xs text-gray-500">Always active to protect the account and avoid duplicate outreach.</div>
              </div>
              <div className="space-y-4">
                {[
                  { title: 'Skip people already contacted', desc: 'People already contacted from this Instagram account will be skipped.' },
                  { title: 'Stop when someone replies', desc: 'If someone replies, Instalead will not continue campaign actions for that person.' },
                  { title: 'Pause if Instagram cannot send safely', desc: 'Instalead pauses the campaign so you can review it before sending continues.' },
                  { title: 'Use safe delays between DMs', desc: 'Instalead automatically spaces out messages to protect your Instagram account.' },
                  { title: 'Respect warm-up limits', desc: 'If warm-up is active, Instalead enforces lower daily limits for this account.' },
                ].map(rule => (
                  <div key={rule.title} className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-800">{rule.title}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{rule.desc}</div>
                    </div>
                    <div className="flex items-center gap-1.5 text-green-500 flex-shrink-0 mt-0.5">
                      <Check size={16} />
                      <span className="text-xs font-medium">Always on</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 5: Review & launch */}
      {step === 5 && (
        <div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Step 5 of 5</div>
          <h2 className="text-xl font-bold text-gray-900 mb-1">Review and launch</h2>
          <p className="text-sm text-gray-500 mb-6">Confirm the campaign setup before turning it on.</p>

          <div className="card">
            <div className="mb-4">
              <div className="text-lg font-semibold text-gray-900">Ready to start</div>
              <p className="text-sm text-green-600">This will start the campaign from @{account || '—'}.</p>
            </div>

            {/* Summary stats */}
            <div className="grid grid-cols-5 gap-0 border border-gray-200 rounded-lg overflow-hidden mb-6">
              {[
                { label: 'Recipients', value: selectedLeads.size },
                { label: 'Daily Outreach', value: `${form.daily_limit}/day` },
                { label: 'Value Per Lead', value: `$${form.value_per_lead}` },
                { label: 'Estimated Duration', value: `About ${estDays || 1} sending day${estDays !== 1 ? 's' : ''}` },
                { label: 'Sending Account', value: `@${account || '—'}` },
              ].map((s, i) => (
                <div key={i} className={`p-4 ${i > 0 ? 'border-l border-gray-200' : ''}`}>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">{s.label}</div>
                  <div className="text-sm font-semibold text-gray-900 mt-1">{s.value}</div>
                </div>
              ))}
            </div>

            {/* Detail sections */}
            <div className="space-y-4 divide-y divide-gray-200">
              <div className="flex gap-8 pt-4">
                <div className="w-24 text-xs text-gray-400 uppercase tracking-wider flex-shrink-0">Audience</div>
                <div>
                  <div className="text-sm text-gray-800">{selectedLeads.size} recipients from Contacts.</div>
                  <div className="text-xs text-gray-500">
                    {form.skip_contacted ? 'Duplicates and people already contacted will be skipped.' : 'No duplicate filtering active.'}
                  </div>
                </div>
              </div>
              <div className="flex gap-8 pt-4">
                <div className="w-24 text-xs text-gray-400 uppercase tracking-wider flex-shrink-0">Message</div>
                <div className="flex-1">
                  <div className="text-sm text-gray-800 mb-1">First DM: {form.personalization_mode === 'template' ? 'Template' : 'Template + personalization'}</div>
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] text-gray-400 uppercase tracking-wider">
                        Example {previewLead ? `for @${previewLead.username}` : ''}
                      </div>
                      {selectedLeads.size > 0 && (
                        <button
                          disabled={previewLoading}
                          onClick={async () => {
                            const selectedArr = leads.filter(l => selectedLeads.has(l.id));
                            if (!selectedArr.length) return;
                            const randomLead = selectedArr[Math.floor(Math.random() * selectedArr.length)];
                            setPreviewLead(randomLead);
                            setPreviewMessage('');
                            setPreviewPersonalization(null);

                            if (form.personalization_mode !== 'personalized') {
                              const contactFirstName = getContactFirstName(randomLead);
                              setPreviewMessage(prepareOutboundMessage(form.message_template, contactFirstName));
                              setPreviewSignature(currentPreviewSignature(randomLead.id));
                              return;
                            }

                            setPreviewLoading(true);
                            try {
                              const result = await api.post('/campaigns/preview-message', {
                                contact_id: randomLead.id,
                                message_template: form.message_template,
                                personalization_mode: form.personalization_mode,
                                personalization_style: form.personalization_style,
                                personalization_custom_prompt: form.personalization_custom_prompt,
                              });
                              setPreviewMessage(result.message || '');
                              setPreviewPersonalization(result.personalization || null);
                              setPreviewSignature(JSON.stringify({
                                leadId: randomLead.id,
                                personalization_mode: form.personalization_mode,
                                message_template: form.message_template,
                                personalization_style: form.personalization_style,
                                personalization_custom_prompt: form.personalization_custom_prompt,
                                ai_agent_version: result.personalization?.ai_agent_version || aiAgentStatus.ai_agent_version || 0,
                              }));
                            } catch (e) {
                              setPreviewMessage('');
                              setPreviewPersonalization(null);
                              setPreviewSignature('');
                              setError(e?.error || e?.message || 'Не удалось создать превью сообщения');
                            } finally {
                              setPreviewLoading(false);
                            }
                          }}
                          className="text-[10px] text-orange-600 hover:text-orange-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {previewLoading ? 'Generating…' : 'Random lead'}
                        </button>
                      )}
                    </div>
                    {previewLead ? (
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-400 to-pink-500 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                            {(previewLead.username || '?')[0].toUpperCase()}
                          </div>
                          <span className="text-xs text-gray-500">@{previewLead.username}</span>
                          {previewLead.full_name && <span className="text-xs text-gray-400">({previewLead.full_name})</span>}
                        </div>
                        <div className="text-sm text-gray-700 whitespace-pre-wrap">{previewLoading ? 'Generating the exact send message…' : (previewMessage || '—')}</div>
                        {previewMessage && form.personalization_mode === 'personalized' && (
                          <div className={`mt-2 pt-2 border-t ${previewIsCurrent ? 'border-green-200' : 'border-orange-200'}`}>
                            <div className={`text-[10px] uppercase tracking-wider mb-1 ${previewIsCurrent ? 'text-green-600' : 'text-orange-600'}`}>
                              {previewIsCurrent ? 'Exact send preview' : 'Preview needs refresh'}
                            </div>
                            <div className="text-xs text-gray-500">
                              {previewIsCurrent
                                ? 'Generated by the same AI personalization pipeline used by the campaign. If you launch with this lead selected, this exact generated message is saved for that lead and sent as shown.'
                                : 'Campaign or AI Agent settings changed after this preview. Click Random lead again to generate the current message that would be sent.'}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-sm text-gray-700 whitespace-pre-wrap">
                        {(() => {
                          const selectedArr = leads.filter(l => selectedLeads.has(l.id));
                          if (selectedArr.length > 0) {
                            const lead = selectedArr[0];
                            const contactFirstName = getContactFirstName(lead);
                            return prepareOutboundMessage(form.message_template, contactFirstName) || '—';
                          }
                          return prepareOutboundMessage(form.message_template, '') || '—';
                        })()}
                      </div>
                    )}
                  </div>
                  {form.personalization_mode === 'personalized' && form.ai_prompt && (
                    <div className="mt-2 bg-purple-50 border border-purple-200 rounded-lg p-3">
                      <div className="text-[10px] text-purple-500 uppercase tracking-wider mb-1">AI Prompt</div>
                      <div className="text-xs text-purple-700">{form.ai_prompt}</div>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-8 pt-4">
                <div className="w-24 text-xs text-gray-400 uppercase tracking-wider flex-shrink-0">Workflow</div>
                <div className="text-sm text-gray-800">
                  {form.prewarm_follow && form.follow_profile
                    ? <>{form.like_last_post ? 'Like → ' : ''}Follow profile <span className="text-orange-500">→ ⏳ {form.prewarm_delay_hours}ч прогрев →</span> First DM</>
                    : <>{form.follow_profile ? 'Follow profile → ' : ''}{form.like_last_post ? 'Like last post → ' : ''}First DM</>
                  }{form.wait_for_reply ? ' → Wait for reply' : ''}
                </div>
              </div>
              <div className="flex gap-8 pt-4">
                <div className="w-24 text-xs text-gray-400 uppercase tracking-wider flex-shrink-0">Schedule</div>
                <div>
                  <div className="text-sm text-gray-800">{form.daily_limit} cold outreach DMs per day</div>
                  <div className="text-xs text-gray-500 mt-1">Estimated pace: about {form.daily_limit} leads/day in this schedule.</div>
                  <div className="text-xs text-gray-500">Timezone: UTC+3 (Moscow)</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {activeDaysList.map(d => d.label.slice(0, 3)).join(', ')} · {form.schedule_start}–{form.schedule_end}
                  </div>
                </div>
              </div>
              <div className="flex gap-8 pt-4">
                <div className="w-24 text-xs text-gray-400 uppercase tracking-wider flex-shrink-0">Safety</div>
                <div>
                  <div className="text-sm font-medium text-gray-800 mb-2">
                    Sending mode: {warmup?.enabled
                      ? <span className="text-orange-600">Warm-up · Day {warmup.day_number}/21</span>
                      : warmup?.warmed_up
                        ? <span className="text-green-600">Warmed up</span>
                        : <span className="text-gray-600">Default</span>
                    }
                  </div>
                  {warmup?.enabled && (
                    <div className="text-xs text-gray-500 mb-2">Warm-up enforces max {warmup.max_messages} DMs/day.</div>
                  )}
                  <div className="space-y-1.5">
                    {[
                      'Skip people already contacted',
                      'Stop if someone replies',
                      'Pause if Instagram cannot send safely',
                      'Use safe delays between DMs',
                      'Respect warm-up limits',
                    ].map(label => (
                      <div key={label} className="flex items-center gap-2">
                        <span className="text-sm text-green-600">✓</span>
                        <span className="text-sm text-gray-700">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between mt-6">
        <button onClick={() => step > 1 ? setStep(s => s - 1) : onBack()}
          className="text-sm text-gray-600 hover:text-gray-800 font-medium">
          Back
        </button>
        {step < 5 ? (
          <button onClick={() => {
            if (step === 1 && !form.name.trim()) return setError('Enter campaign name');
            if (step === 2 && selectedLeads.size === 0) return setError('Select at least one contact');
            setError('');
            setStep(s => s + 1);
          }} className="btn-primary px-8">
            Next
          </button>
        ) : (
          <button onClick={handleLaunch} disabled={loading}
            className="bg-gray-900 hover:bg-gray-800 text-white font-semibold px-8 py-2.5 rounded-lg transition-colors disabled:opacity-50 text-sm">
            {loading ? 'Launching...' : 'Launch campaign'}
          </button>
        )}
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg p-3 text-xs">
      <div className="font-medium text-gray-700 dark:text-gray-200 mb-1.5">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-gray-500 dark:text-gray-400">{p.name}:</span>
          <span className="font-semibold" style={{ color: p.color }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
}

function useCountdown(targetDate) {
  const [timeLeft, setTimeLeft] = useState('');
  useEffect(() => {
    if (!targetDate) { setTimeLeft(''); return; }
    const tick = () => {
      const diff = new Date(targetDate).getTime() - Date.now();
      if (diff <= 0) { setTimeLeft('Now'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${h > 0 ? h + 'h ' : ''}${m}m ${s}s`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [targetDate]);
  return timeLeft;
}

function CampaignCard({ campaign, onStart, onPause, onDelete, onArchive, onRestart, onContinueDraft, onDiscard }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [chartRange, setChartRange] = useState('all');
  const menuRef = useRef(null);

  const isDraft = campaign.status === 'draft';
  const isRunning = campaign.status === 'running';
  const isCompleted = campaign.status === 'completed';
  const isPaused = campaign.status === 'paused';
  const isWaitingHours = campaign.status === 'paused_by_schedule';
  const isActive = isRunning || isWaitingHours;

  const progress = campaign.total_leads > 0 ? Math.round((campaign.sent_count / campaign.total_leads) * 100) : 0;
  const replyRate = campaign.sent_count > 0 ? Math.round(((campaign.replied_count || 0) / campaign.sent_count) * 100) : 0;
  const scheduleInfo = campaign.schedule_info || {};
  const countdown = useCountdown(isWaitingHours && scheduleInfo.next_window ? scheduleInfo.next_window : null);

  const allStats = campaign.daily_stats || [];
  const filteredStats = chartRange === 'all' ? allStats : allStats.slice(-Number(chartRange));
  const chartData = filteredStats.map(d => ({
    date: new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' }),
    Sent: d.sent,
    Replied: d.replied,
    Skipped: d.skipped,
  }));

  useEffect(() => {
    const handleClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const metrics = [
    { label: 'AUDIENCE', value: campaign.total_leads, color: 'text-gray-900 dark:text-gray-100', iconBg: 'bg-gray-100 dark:bg-gray-700', iconEl: <Users size={14} className="text-gray-500" /> },
    { label: 'SENT', value: campaign.sent_count, color: 'text-blue-600', iconBg: 'bg-blue-100 dark:bg-blue-900/40', iconEl: <Send size={14} className="text-blue-500" /> },
    { label: 'REPLIED', value: campaign.replied_count || 0, color: 'text-green-600', iconBg: 'bg-green-100 dark:bg-green-900/40', iconEl: <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg> },
    { label: 'REPLY RATE', value: `${replyRate}%`, color: 'text-gray-900 dark:text-gray-100', iconBg: 'bg-purple-100 dark:bg-purple-900/40', iconEl: <svg className="w-3.5 h-3.5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg> },
    { label: 'SKIPPED', value: campaign.failed_count || 0, color: 'text-red-500', iconBg: 'bg-red-100 dark:bg-red-900/40', iconEl: <svg className="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg> },
    { label: 'CAMPAIGN VALUE', value: `$${(campaign.campaign_value || 0).toLocaleString()}`, color: 'text-gray-900 dark:text-gray-100', iconBg: 'bg-orange-100 dark:bg-orange-900/40', iconEl: <svg className="w-3.5 h-3.5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
  ];

  function getNextActionText() {
    if (isCompleted) return 'Campaign completed';
    if (isPaused) return 'Campaign paused — will NOT auto-resume';
    if (isWaitingHours) {
      const si = campaign.schedule_info || {};
      if (si.next_window) {
        const nw = new Date(si.next_window);
        const timeStr = nw.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Europe/Moscow' });
        const dayStr = nw.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Europe/Moscow' });
        return `Auto-resumes ${dayStr} at ${timeStr} MSK`;
      }
      return 'Waiting for working hours — will auto-resume';
    }
    if (campaign.pending_count === 0 && campaign.followed_count > 0)
      return `🔥 ${campaign.followed_count} на прогреве — DM после ${campaign.prewarm_delay_hours || 24}ч`;
    if (campaign.pending_count === 0 && campaign.total_leads > 0) return 'All leads processed';
    if (isRunning && campaign.next_username) {
      if (campaign.prewarm_follow && campaign.follow_profile) {
        const soft = campaign.like_last_post ? 'Like + Follow' : 'Follow';
        return `🔥 Прогрев: ${soft} @${campaign.next_username} → DM через ${campaign.prewarm_delay_hours || 24}ч`;
      }
      const steps = [];
      if (campaign.follow_profile) steps.push('Follow');
      if (campaign.like_last_post) steps.push('Like');
      steps.push('DM');
      return `${steps.join(' + ')} @${campaign.next_username}`;
    }
    if (isRunning) return 'Processing...';
    return 'Ready to start';
  }

  function getContinuesText() {
    if (isWaitingHours && countdown) return countdown;
    if (isRunning && campaign.next_username) return `${campaign.min_delay}–${campaign.max_delay}m delay`;
    return null;
  }

  return (
    <div className="card hover:shadow-md transition-all">
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <div className="flex items-center gap-2.5">
            <Link to={`/campaigns/${campaign.id}`} className="text-lg font-bold text-gray-900 dark:text-gray-100 hover:text-orange-600 transition-colors">
              {campaign.name}
            </Link>
            <StatusBadge status={campaign.status} />
          </div>
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            {campaign.total_leads} recipients from Contacts
            {campaign.started_at && <span className="ml-1">· Started {new Date(campaign.started_at.replace(' ', 'T')).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, {new Date(campaign.started_at.replace(' ', 'T')).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {(isActive || isPaused) && (
            <Toggle value={isActive} onChange={() => isActive ? onPause(campaign.id) : onStart(campaign.id)} />
          )}
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenuOpen(!menuOpen)} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
              <MoreVertical size={16} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-xl z-20 py-1">
                <Link to={`/campaigns/${campaign.id}`} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 w-full" onClick={() => setMenuOpen(false)}>
                  <Eye size={14} /> Details
                </Link>
                {isCompleted && (
                  <button onClick={() => { onRestart(campaign.id); setMenuOpen(false); }} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 w-full text-left">
                    <RotateCcw size={14} /> Restart
                  </button>
                )}
                <button onClick={() => { onArchive(campaign.id); setMenuOpen(false); }} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 w-full text-left">
                  <Archive size={14} /> Archive
                </button>
                <hr className="my-1 border-gray-100 dark:border-gray-700" />
                <button onClick={() => { onDelete(campaign.id); setMenuOpen(false); }} className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 w-full text-left">
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {isDraft ? (
        <div className="flex items-center justify-between py-8 px-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl mt-3">
          <div className="text-gray-500 dark:text-gray-400 text-sm">This campaign is still a draft. Continue setting it up or discard it.</div>
          <div className="flex items-center gap-3">
            <button onClick={() => onDiscard(campaign.id)} className="text-sm text-gray-500 hover:text-red-500 font-medium px-4 py-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors">
              Discard
            </button>
            <button onClick={() => onContinueDraft(campaign.id)} className="text-sm font-medium px-4 py-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors">
              Continue setup
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Metrics Row */}
          <div className="grid grid-cols-6 gap-2 mt-3 mb-3">
            {metrics.map((m) => (
              <div key={m.label} className="border border-gray-100 dark:border-gray-700 rounded-xl px-3 py-2.5 relative">
                <div className={`absolute top-2.5 right-2.5 w-6 h-6 rounded-full ${m.iconBg} flex items-center justify-center`}>
                  {m.iconEl}
                </div>
                <div className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wider font-medium mb-0.5">{m.label}</div>
                <div className={`text-lg font-bold ${m.color}`}>{m.value}</div>
              </div>
            ))}
          </div>

          {/* Retry failed/skipped notice */}
          {((campaign.failed_count || 0) + (campaign.skipped_count || 0)) > 0 && (
            <div className="flex items-center justify-between border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-4 py-2.5 mb-3">
              <div className="text-xs text-amber-800 dark:text-amber-300">
                <span className="font-semibold">{(campaign.failed_count || 0) + (campaign.skipped_count || 0)}</span> leads errored on the first try. Their AI messages are cached — retry won't burn API credits.
              </div>
              <button
                onClick={async () => {
                  const total = (campaign.failed_count || 0) + (campaign.skipped_count || 0);
                  if (!confirm(`Retry ${total} leads?\n\nThese are leads we already attempted but errored (IG lag, page not loaded, button not found). Their personalized messages are cached — AI will NOT be called again.`)) return;
                  try {
                    const res = await api.post(`/campaigns/${campaign.id}/restore-skipped`, { disable_skip_contacted: true, include_failed: true });
                    const bd = res.breakdown || {};
                    const parts = Object.entries(bd).map(([k, v]) => `${v} ${k}`).join(', ');
                    alert(`Requeued ${res.restored} leads${parts ? ` (${parts})` : ''}. Cached AI messages will be reused.`);
                    window.location.reload();
                  } catch (e) {
                    alert('Retry failed: ' + (e.error || e.message || 'unknown'));
                  }
                }}
                className="text-xs font-semibold text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          )}

          {/* Chart */}
          {chartData.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /><span className="text-[11px] text-gray-500 dark:text-gray-400">Sent</span></div>
                  <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500" /><span className="text-[11px] text-gray-500 dark:text-gray-400">Replied</span></div>
                  <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-400" /><span className="text-[11px] text-gray-500 dark:text-gray-400">Skipped</span></div>
                </div>
                <div className="flex items-center gap-1">
                  {[{ label: '7d', value: '7' }, { label: '30d', value: '30' }, { label: 'All', value: 'all' }].map(opt => (
                    <button key={opt.value} onClick={() => setChartRange(opt.value)}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                        chartRange === opt.value
                          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400'
                          : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}>{opt.label}</button>
                  ))}
                </div>
              </div>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id={`gs-${campaign.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id={`gr-${campaign.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id={`gk-${campaign.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#ef4444" stopOpacity={0.1} />
                        <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip />} />
                    <Area type="monotone" dataKey="Sent" stroke="#3b82f6" fill={`url(#gs-${campaign.id})`} strokeWidth={2} dot={false} />
                    <Area type="monotone" dataKey="Replied" stroke="#22c55e" fill={`url(#gr-${campaign.id})`} strokeWidth={2} dot={false} />
                    <Area type="monotone" dataKey="Skipped" stroke="#ef4444" fill={`url(#gk-${campaign.id})`} strokeWidth={1.5} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Next Action */}
          <div className="flex items-center justify-between border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 mb-3">
            <div>
              <div className="text-[10px] text-orange-500 uppercase tracking-wider font-semibold mb-0.5">NEXT ACTION</div>
              <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{getNextActionText()}</div>
            </div>
            {getContinuesText() && (
              <div className="text-right">
                <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">CONTINUES</div>
                <div className="text-sm font-bold text-orange-600">{getContinuesText()}</div>
              </div>
            )}
          </div>

          {/* Processed + Details */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-gray-700 dark:text-gray-300">Processed</span>
              <span className="font-bold text-gray-900 dark:text-gray-100">{campaign.sent_count} / {campaign.total_leads}</span>
              <span className="text-gray-400">{progress}%</span>
            </div>
            <Link to={`/campaigns/${campaign.id}`} className="text-xs text-gray-500 hover:text-orange-600 font-medium transition-colors">
              Details
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function ArchivedCampaignCard({ campaign, onUnarchive, onDelete }) {
  return (
    <div className="card opacity-75 hover:opacity-100 transition-all">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to={`/campaigns/${campaign.id}`} className="text-base font-semibold text-gray-600 dark:text-gray-300 hover:text-orange-600 transition-colors">
            {campaign.name}
          </Link>
          <StatusBadge status={campaign.status} />
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-gray-400 mr-3">
            {campaign.sent_count} sent · {campaign.replied_count || 0} replied
          </div>
          <button onClick={() => onUnarchive(campaign.id)} className="text-xs text-blue-600 hover:text-blue-700 font-medium px-3 py-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors">
            Restore
          </button>
          <button onClick={() => onDelete(campaign.id)} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Campaigns() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState([]);
  const [archivedCampaigns, setArchivedCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editDraftId, setEditDraftId] = useState(null);
  const [tab, setTab] = useState('current');

  const loadCurrent = () => api.get('/campaigns').then(setCampaigns).catch(console.error);
  const loadArchived = () => api.get('/campaigns?archived=1').then(setArchivedCampaigns).catch(console.error);

  const load = () => {
    Promise.all([loadCurrent(), loadArchived()]).finally(() => setLoading(false));
  };

  useEffect(() => { load(); const t = setInterval(loadCurrent, 5000); return () => clearInterval(t); }, []);

  const handleStart = async (id) => { await api.post(`/campaigns/${id}/start`); loadCurrent(); };
  const handlePause = async (id) => { await api.post(`/campaigns/${id}/pause`); loadCurrent(); };
  const handleDelete = async (id) => { if (!confirm('Delete this campaign?')) return; await api.delete(`/campaigns/${id}`); load(); };
  const handleArchive = async (id) => { await api.post(`/campaigns/${id}/archive`); load(); };
  const handleUnarchive = async (id) => { await api.post(`/campaigns/${id}/unarchive`); load(); };
  const handleRestart = async (id) => { await api.post(`/campaigns/${id}/restart`); loadCurrent(); };

  const handleContinueDraft = (id) => {
    navigate(`/campaigns/${id}`);
  };

  const handleDiscard = async (id) => {
    if (!confirm('Discard this draft campaign?')) return;
    await api.delete(`/campaigns/${id}`);
    load();
  };

  if (showCreate) return <CreateCampaign onBack={() => { setShowCreate(false); setEditDraftId(null); }} onCreated={() => { load(); setShowCreate(false); setEditDraftId(null); }} editDraftId={editDraftId} />;

  const currentCount = campaigns.length;
  const archivedCount = archivedCampaigns.length;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Campaigns</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">{currentCount + archivedCount} campaigns</p>
        </div>
        <button onClick={() => { setEditDraftId(null); setShowCreate(true); }} className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={15} /> New campaign
        </button>
      </div>

      <div className="flex gap-0 border-b border-gray-200 dark:border-gray-700">
        <button onClick={() => setTab('current')} className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === 'current' ? 'border-gray-900 dark:border-gray-100 text-gray-900 dark:text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}>
          Current {currentCount > 0 && <span className="ml-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded-full text-xs">{currentCount}</span>}
        </button>
        <button onClick={() => setTab('archived')} className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${tab === 'archived' ? 'border-gray-900 dark:border-gray-100 text-gray-900 dark:text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}>
          <Archive size={14} /> Archived {archivedCount > 0 && <span className="ml-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded-full text-xs">{archivedCount}</span>}
        </button>
      </div>

      {loading ? <div className="text-center py-16 text-gray-400">Loading...</div> :
       tab === 'current' ? (
        campaigns.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-5xl mb-4">📢</div>
            <div className="text-gray-600 dark:text-gray-300 text-lg font-medium">No campaigns yet</div>
            <p className="text-gray-400 text-sm mt-1">Create your first campaign to start reaching out</p>
            <button onClick={() => setShowCreate(true)} className="btn-primary mt-4">Create campaign</button>
          </div>
        ) : (
          <div className="space-y-4">
            {campaigns.map(c => (
              <CampaignCard key={c.id} campaign={c}
                onStart={handleStart} onPause={handlePause} onDelete={handleDelete}
                onArchive={handleArchive} onRestart={handleRestart}
                onContinueDraft={handleContinueDraft} onDiscard={handleDiscard}
              />
            ))}
          </div>
        )
      ) : (
        archivedCampaigns.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-5xl mb-4">📦</div>
            <div className="text-gray-600 dark:text-gray-300 text-lg font-medium">No archived campaigns</div>
          </div>
        ) : (
          <div className="space-y-3">
            {archivedCampaigns.map(c => (
              <ArchivedCampaignCard key={c.id} campaign={c} onUnarchive={handleUnarchive} onDelete={handleDelete} />
            ))}
          </div>
        )
      )}
    </div>
  );
}
