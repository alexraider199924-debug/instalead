import React, { useState, useEffect } from 'react';
import { Plus, Play, Pause, Trash2, ChevronRight, Clock, Users, Send } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../utils/api.js';

function StatusBadge({ status }) {
  const map = {
    draft: <span className="badge-gray">Черновик</span>,
    scheduled: <span className="badge-yellow"><Clock size={10} className="mr-1" />Запланирована</span>,
    running: <span className="badge-green">Работает</span>,
    paused: <span className="badge-blue">Пауза</span>,
    completed: <span className="badge-purple">Завершена</span>
  };
  return map[status] || <span className="badge-gray">{status}</span>;
}

function CreateCampaignModal({ onClose, onCreated }) {
  const [step, setStep] = useState(1);
  const [leads, setLeads] = useState([]);
  const [selectedLeads, setSelectedLeads] = useState(new Set());
  const [searchLead, setSearchLead] = useState('');
  const [form, setForm] = useState({
    name: '',
    message_template: '',
    ai_provider: 'claude',
    ai_generated: false,
    delay_seconds: 30,
    scheduled_at: ''
  });
  const [aiLoading, setAiLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/leads?limit=500').then(r => setLeads(r.leads));
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

  const generateAI = async () => {
    if (!form.message_template.trim()) return setError('Введите шаблон оффера для AI');
    setAiLoading(true);
    setError('');
    try {
      const res = await api.post('/ai/generate', {
        provider: form.ai_provider,
        template: form.message_template,
        lead: { username: 'example', full_name: '', niche: '' }
      });
      setForm(f => ({ ...f, message_template: res.message, ai_generated: true }));
    } catch (e) {
      setError(e.error || 'Ошибка AI генерации');
    } finally {
      setAiLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!form.name.trim()) return setError('Название обязательно');
    if (!form.message_template.trim()) return setError('Сообщение обязательно');
    setLoading(true);
    setError('');
    try {
      const campaign = await api.post('/campaigns', {
        ...form,
        lead_ids: [...selectedLeads],
        scheduled_at: form.scheduled_at || null
      });
      onCreated();
      navigate(`/campaigns/${campaign.id}`);
    } catch (e) {
      setError(e.error || 'Ошибка создания');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div>
            <h2 className="font-semibold text-white">Новая кампания</h2>
            <div className="flex gap-1 mt-1">
              {[1, 2, 3].map(s => (
                <div key={s} className={`h-1 w-8 rounded-full transition-colors ${s <= step ? 'bg-brand-500' : 'bg-gray-700'}`} />
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl font-light">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {error && <div className="text-red-400 text-sm bg-red-900/20 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-300">Шаг 1: Основная информация</h3>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Название кампании *</label>
                <input className="input" placeholder="Например: Фитнес-блогеры Январь 2025" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-400">Сообщение / Оффер *</label>
                  <div className="flex items-center gap-2">
                    <select className="text-xs bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-gray-300"
                      value={form.ai_provider} onChange={e => setForm(f => ({ ...f, ai_provider: e.target.value }))}>
                      <option value="claude">Claude AI</option>
                      <option value="openai">OpenAI GPT</option>
                    </select>
                    <button onClick={generateAI} disabled={aiLoading} className="text-xs bg-brand-600 hover:bg-brand-500 text-white px-3 py-1 rounded-md transition-colors disabled:opacity-50">
                      {aiLoading ? '...' : '✨ Генерировать AI'}
                    </button>
                  </div>
                </div>
                <textarea className="input resize-none" rows={5} value={form.message_template}
                  placeholder="Привет! Напишите ваш оффер здесь, или опишите нишу и нажмите 'Генерировать AI'"
                  onChange={e => setForm(f => ({ ...f, message_template: e.target.value, ai_generated: false }))} />
                <div className="text-xs text-gray-600 mt-1">{form.message_template.length} символов</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Задержка между сообщениями (сек)</label>
                  <input type="number" className="input" min={10} max={300} value={form.delay_seconds}
                    onChange={e => setForm(f => ({ ...f, delay_seconds: Number(e.target.value) }))} />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Запустить в (опционально)</label>
                  <input type="datetime-local" className="input" value={form.scheduled_at}
                    onChange={e => setForm(f => ({ ...f, scheduled_at: e.target.value }))} />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-300">Шаг 2: Выберите лиды</h3>
                <span className="text-xs text-gray-500">Выбрано: {selectedLeads.size}</span>
              </div>
              <input className="input text-sm" placeholder="Поиск лидов..." value={searchLead}
                onChange={e => setSearchLead(e.target.value)} />
              <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
                {filteredLeads.map(lead => (
                  <label key={lead.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-800 cursor-pointer">
                    <input type="checkbox" checked={selectedLeads.has(lead.id)} onChange={() => toggleLead(lead.id)}
                      className="accent-brand-500 cursor-pointer" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-200 font-medium">@{lead.username}</div>
                      {lead.full_name && <div className="text-xs text-gray-500 truncate">{lead.full_name}</div>}
                    </div>
                    {lead.niche && <span className="text-xs text-gray-600">{lead.niche}</span>}
                  </label>
                ))}
                {filteredLeads.length === 0 && (
                  <div className="text-center py-8 text-gray-600 text-sm">
                    {leads.length === 0 ? 'Нет лидов. Сначала добавьте лиды.' : 'Не найдено'}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-300">Шаг 3: Подтверждение</h3>
              <div className="space-y-3">
                <div className="bg-gray-800 rounded-xl p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Кампания:</span>
                    <span className="text-white font-medium">{form.name}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Лидов:</span>
                    <span className="text-white">{selectedLeads.size}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">AI провайдер:</span>
                    <span className="text-white">{form.ai_provider === 'claude' ? 'Claude AI' : 'OpenAI GPT'}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Задержка:</span>
                    <span className="text-white">{form.delay_seconds} сек</span>
                  </div>
                  {form.scheduled_at && (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Запуск:</span>
                      <span className="text-yellow-400">{new Date(form.scheduled_at).toLocaleString('ru')}</span>
                    </div>
                  )}
                </div>
                <div className="bg-gray-800 rounded-xl p-4">
                  <div className="text-xs text-gray-400 mb-2">Сообщение:</div>
                  <div className="text-sm text-gray-200 whitespace-pre-wrap">{form.message_template}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3 p-5 border-t border-gray-800">
          {step > 1 && <button onClick={() => setStep(s => s - 1)} className="btn-secondary">Назад</button>}
          {step < 3 ? (
            <button onClick={() => { setError(''); setStep(s => s + 1); }} className="btn-primary flex-1">
              Далее <ChevronRight size={15} className="inline" />
            </button>
          ) : (
            <button onClick={handleCreate} disabled={loading} className="btn-primary flex-1">
              {loading ? 'Создание...' : '🚀 Создать кампанию'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = () => {
    api.get('/campaigns').then(setCampaigns).catch(console.error).finally(() => setLoading(false));
  };

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const handleStart = async (id) => {
    await api.post(`/campaigns/${id}/start`);
    load();
  };

  const handlePause = async (id) => {
    await api.post(`/campaigns/${id}/pause`);
    load();
  };

  const handleDelete = async (id) => {
    if (!confirm('Удалить кампанию?')) return;
    await api.delete(`/campaigns/${id}`);
    load();
  };

  return (
    <div className="p-6 space-y-5">
      {showCreate && <CreateCampaignModal onClose={() => setShowCreate(false)} onCreated={load} />}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Кампании</h1>
          <p className="text-gray-500 text-sm mt-1">{campaigns.length} кампаний</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={15} /> Новая кампания
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-600">Загрузка...</div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-5xl mb-4">📢</div>
          <div className="text-gray-400 text-lg font-medium">Нет кампаний</div>
          <p className="text-gray-600 text-sm mt-1 mb-4">Создайте первую кампанию и начните рассылку</p>
          <button onClick={() => setShowCreate(true)} className="btn-primary">Создать кампанию</button>
        </div>
      ) : (
        <div className="grid gap-4">
          {campaigns.map(campaign => (
            <div key={campaign.id} className="card hover:border-gray-700 transition-colors">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Link to={`/campaigns/${campaign.id}`} className="text-base font-semibold text-white hover:text-brand-300 transition-colors">
                      {campaign.name}
                    </Link>
                    <StatusBadge status={campaign.status} />
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                    <span className="flex items-center gap-1"><Users size={13} /> {campaign.total_leads} лидов</span>
                    <span className="flex items-center gap-1"><Send size={13} className="text-green-500" /> {campaign.sent_count} отправлено</span>
                    {campaign.pending_count > 0 && (
                      <span className="flex items-center gap-1"><Clock size={13} className="text-yellow-500" /> {campaign.pending_count} в очереди</span>
                    )}
                    {campaign.failed_count > 0 && (
                      <span className="text-red-400">{campaign.failed_count} ошибок</span>
                    )}
                  </div>
                  <div className="mt-2 text-xs text-gray-600 truncate max-w-lg">{campaign.message_template}</div>
                  {campaign.total_leads > 0 && (
                    <div className="mt-2 w-full bg-gray-800 rounded-full h-1.5">
                      <div className="bg-brand-500 h-1.5 rounded-full transition-all"
                        style={{ width: `${Math.round((campaign.sent_count / campaign.total_leads) * 100)}%` }} />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                  {campaign.status === 'running' && (
                    <button onClick={() => handlePause(campaign.id)} className="btn-secondary text-xs flex items-center gap-1 py-1.5">
                      <Pause size={13} /> Пауза
                    </button>
                  )}
                  {(campaign.status === 'draft' || campaign.status === 'paused') && (
                    <button onClick={() => handleStart(campaign.id)} className="btn-primary text-xs flex items-center gap-1 py-1.5">
                      <Play size={13} /> Запустить
                    </button>
                  )}
                  <Link to={`/campaigns/${campaign.id}`} className="btn-secondary text-xs py-1.5">Открыть</Link>
                  <button onClick={() => handleDelete(campaign.id)} className="p-2 text-gray-600 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
