import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, Pause, Sparkles, Users, Send, Clock, AlertCircle, RefreshCw, Plus } from 'lucide-react';
import api from '../utils/api.js';

const STATUS_MAP = {
  pending: { label: 'Ожидает', cls: 'badge-yellow' },
  sent: { label: 'Отправлено', cls: 'badge-green' },
  failed: { label: 'Ошибка', cls: 'badge-red' }
};

function CampaignStatusBadge({ status }) {
  const map = {
    draft: <span className="badge-gray">Черновик</span>,
    scheduled: <span className="badge-yellow">Запланирована</span>,
    running: <span className="badge-green animate-pulse">Работает</span>,
    paused: <span className="badge-blue">Пауза</span>,
    completed: <span className="badge-purple">Завершена</span>
  };
  return map[status] || <span className="badge-gray">{status}</span>;
}

export default function CampaignDetail() {
  const { id } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [campaignLeads, setCampaignLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [editMsg, setEditMsg] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [allLeads, setAllLeads] = useState([]);
  const [showAddLeads, setShowAddLeads] = useState(false);
  const [selectedNew, setSelectedNew] = useState(new Set());

  const load = async () => {
    const [c, cl] = await Promise.all([
      api.get(`/campaigns/${id}`),
      api.get(`/campaigns/${id}/leads`)
    ]);
    setCampaign(c);
    setCampaignLeads(cl);
    setMsg(c.message_template);
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    if (campaign?.status === 'running') {
      const t = setInterval(load, 3000);
      return () => clearInterval(t);
    }
  }, [campaign?.status]);

  const handleStart = async () => {
    await api.post(`/campaigns/${id}/start`);
    load();
  };

  const handlePause = async () => {
    await api.post(`/campaigns/${id}/pause`);
    load();
  };

  const handleSaveMessage = async () => {
    await api.put(`/campaigns/${id}`, { ...campaign, message_template: msg });
    setEditMsg(false);
    setSuccess('Сообщение сохранено');
    setTimeout(() => setSuccess(''), 3000);
    load();
  };

  const generateAI = async () => {
    setAiLoading(true);
    setError('');
    try {
      const res = await api.post('/ai/generate', {
        provider: campaign.ai_provider,
        template: msg,
        lead: { username: 'example', full_name: '', niche: '' }
      });
      setMsg(res.message);
      setEditMsg(true);
    } catch (e) {
      setError(e.error || 'Ошибка AI');
    } finally {
      setAiLoading(false);
    }
  };

  const generateBulkAI = async () => {
    if (!confirm('Генерировать персонализированные сообщения для всех лидов в очереди?')) return;
    setAiLoading(true);
    setError('');
    try {
      const res = await api.post('/ai/generate-bulk', {
        provider: campaign.ai_provider,
        template: campaign.message_template,
        campaign_id: id
      });
      setSuccess(`Сгенерировано ${res.results.filter(r => r.success).length} из ${res.total}`);
      setTimeout(() => setSuccess(''), 4000);
      load();
    } catch (e) {
      setError(e.error || 'Ошибка bulk AI');
    } finally {
      setAiLoading(false);
    }
  };

  const handleAddLeads = async () => {
    if (!selectedNew.size) return;
    await api.post(`/campaigns/${id}/leads`, { lead_ids: [...selectedNew] });
    setShowAddLeads(false);
    setSelectedNew(new Set());
    load();
  };

  const openAddLeads = async () => {
    const res = await api.get('/leads?limit=500');
    const existingIds = new Set(campaignLeads.map(l => l.id));
    setAllLeads(res.leads.filter(l => !existingIds.has(l.id)));
    setShowAddLeads(true);
  };

  if (loading) return <div className="flex items-center justify-center h-full text-gray-600">Загрузка...</div>;
  if (!campaign) return <div className="text-center py-20 text-gray-600">Кампания не найдена</div>;

  const sentPercent = campaign.total_leads ? Math.round((campaign.sent_count / campaign.total_leads) * 100) : 0;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link to="/campaigns" className="p-2 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white">{campaign.name}</h1>
              <CampaignStatusBadge status={campaign.status} />
            </div>
            <p className="text-gray-500 text-xs mt-0.5">ID #{campaign.id} · Создана {campaign.created_at?.slice(0, 10)}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {campaign.status === 'running' ? (
            <button onClick={handlePause} className="btn-secondary flex items-center gap-2">
              <Pause size={15} /> Пауза
            </button>
          ) : campaign.status !== 'completed' ? (
            <button onClick={handleStart} className="btn-primary flex items-center gap-2">
              <Play size={15} /> Запустить
            </button>
          ) : null}
        </div>
      </div>

      {error && <div className="text-red-400 text-sm bg-red-900/20 rounded-lg px-4 py-3">{error}</div>}
      {success && <div className="text-green-400 text-sm bg-green-900/20 rounded-lg px-4 py-3">{success}</div>}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Всего лидов', value: campaign.total_leads, icon: Users, color: 'text-blue-400' },
          { label: 'Отправлено', value: campaign.sent_count, icon: Send, color: 'text-green-400' },
          { label: 'В очереди', value: campaign.pending_count, icon: Clock, color: 'text-yellow-400' },
          { label: 'Ошибок', value: campaign.failed_count, icon: AlertCircle, color: 'text-red-400' }
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card flex items-center gap-3">
            <Icon size={20} className={color} />
            <div>
              <div className="text-xl font-bold text-white">{value}</div>
              <div className="text-xs text-gray-500">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Progress */}
      {campaign.total_leads > 0 && (
        <div className="card">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-400">Прогресс</span>
            <span className="text-white font-medium">{sentPercent}%</span>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-2">
            <div className="bg-brand-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${sentPercent}%` }} />
          </div>
        </div>
      )}

      {/* Message */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Сообщение кампании</h2>
          <div className="flex gap-2">
            <button onClick={generateAI} disabled={aiLoading} className="text-xs btn-secondary flex items-center gap-1 py-1.5">
              <Sparkles size={13} className="text-brand-400" />
              {aiLoading ? 'Генерация...' : 'AI перегенерировать'}
            </button>
            <button onClick={generateBulkAI} disabled={aiLoading} className="text-xs bg-brand-600/20 hover:bg-brand-600/30 text-brand-300 border border-brand-800 rounded-lg px-3 py-1.5 flex items-center gap-1 transition-colors">
              <Sparkles size={13} />
              {aiLoading ? '...' : 'AI для всех лидов'}
            </button>
            {!editMsg ? (
              <button onClick={() => setEditMsg(true)} className="text-xs btn-secondary py-1.5">Редактировать</button>
            ) : (
              <button onClick={handleSaveMessage} className="text-xs btn-primary py-1.5">Сохранить</button>
            )}
          </div>
        </div>
        {editMsg ? (
          <textarea className="input resize-none text-sm" rows={4} value={msg}
            onChange={e => setMsg(e.target.value)} />
        ) : (
          <div className="bg-gray-800 rounded-lg p-3 text-sm text-gray-200 whitespace-pre-wrap">{campaign.message_template}</div>
        )}
        <div className="flex gap-2 text-xs text-gray-600">
          <span>AI: {campaign.ai_provider === 'claude' ? 'Claude' : 'OpenAI'}</span>
          <span>·</span>
          <span>Задержка: {campaign.delay_seconds}с</span>
          {campaign.scheduled_at && <><span>·</span><span>Запуск: {new Date(campaign.scheduled_at).toLocaleString('ru')}</span></>}
        </div>
      </div>

      {/* Extension hint */}
      {campaign.status === 'running' && (
        <div className="card border-brand-800 bg-brand-900/10">
          <div className="flex items-start gap-3">
            <div className="text-2xl">🔌</div>
            <div>
              <div className="text-sm font-semibold text-brand-300">Браузерное расширение активно</div>
              <p className="text-xs text-gray-400 mt-1">
                Откройте расширение InstaWorm в браузере. Оно будет автоматически открывать Instagram DM и отправлять сообщения лидам из очереди.
              </p>
              <p className="text-xs text-gray-600 mt-1">API: http://localhost:3001/api/extension/queue</p>
            </div>
          </div>
        </div>
      )}

      {/* Leads table */}
      <div className="card p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white">Лиды кампании ({campaignLeads.length})</h2>
          <button onClick={openAddLeads} className="text-xs btn-secondary flex items-center gap-1 py-1.5">
            <Plus size={13} /> Добавить лиды
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800">
              <tr className="text-left text-gray-500 text-xs uppercase tracking-wider">
                <th className="px-4 py-2.5">Username</th>
                <th className="px-4 py-2.5">Сообщение</th>
                <th className="px-4 py-2.5">Статус</th>
                <th className="px-4 py-2.5">Отправлено</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {campaignLeads.length === 0 ? (
                <tr><td colSpan={4} className="text-center py-8 text-gray-600">Нет лидов в кампании</td></tr>
              ) : campaignLeads.map(lead => {
                const s = STATUS_MAP[lead.campaign_status] || { label: lead.campaign_status, cls: 'badge-gray' };
                return (
                  <tr key={lead.id} className="hover:bg-gray-800/30">
                    <td className="px-4 py-2.5">
                      <a href={`https://instagram.com/${lead.username}`} target="_blank" rel="noopener noreferrer"
                        className="text-brand-400 hover:text-brand-300">@{lead.username}</a>
                      {lead.full_name && <div className="text-xs text-gray-600">{lead.full_name}</div>}
                    </td>
                    <td className="px-4 py-2.5 max-w-xs">
                      <div className="text-xs text-gray-400 truncate">{lead.message_sent || <span className="text-gray-700 italic">шаблон</span>}</div>
                    </td>
                    <td className="px-4 py-2.5"><span className={s.cls}>{s.label}</span></td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">{lead.sent_at?.slice(0, 16) || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add leads modal */}
      {showAddLeads && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <h3 className="font-semibold text-white">Добавить лиды</h3>
              <button onClick={() => setShowAddLeads(false)} className="text-gray-500 hover:text-gray-300">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-1">
              {allLeads.length === 0 ? (
                <div className="text-center py-8 text-gray-600 text-sm">Все лиды уже добавлены</div>
              ) : allLeads.map(lead => (
                <label key={lead.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-800 cursor-pointer">
                  <input type="checkbox" checked={selectedNew.has(lead.id)}
                    onChange={() => setSelectedNew(prev => { const n = new Set(prev); n.has(lead.id) ? n.delete(lead.id) : n.add(lead.id); return n; })}
                    className="accent-brand-500" />
                  <div>
                    <div className="text-sm text-gray-200">@{lead.username}</div>
                    {lead.niche && <div className="text-xs text-gray-600">{lead.niche}</div>}
                  </div>
                </label>
              ))}
            </div>
            <div className="flex gap-3 p-4 border-t border-gray-800">
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
