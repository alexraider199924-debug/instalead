import React, { useState, useEffect, useRef } from 'react';
import { Plus, Upload, Search, Trash2, Edit2, X, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import api from '../utils/api.js';

const STATUS_OPTIONS = ['new', 'contacted', 'replied', 'converted', 'ignored'];
const STATUS_LABELS = { new: 'Новый', contacted: 'Написано', replied: 'Ответил', converted: 'Конвертирован', ignored: 'Игнор' };

function StatusBadge({ status }) {
  const map = {
    new: 'badge-blue', contacted: 'badge-yellow', replied: 'badge-green',
    converted: 'badge-purple', ignored: 'badge-gray'
  };
  return <span className={map[status] || 'badge-gray'}>{STATUS_LABELS[status] || status}</span>;
}

function LeadModal({ lead, onClose, onSave }) {
  const [form, setForm] = useState(lead || { username: '', full_name: '', email: '', bio: '', niche: '', notes: '', status: 'new' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!form.username.trim()) return setError('Username обязателен');
    setLoading(true);
    try {
      if (form.id) {
        await api.put(`/leads/${form.id}`, form);
      } else {
        await api.post('/leads', form);
      }
      onSave();
    } catch (e) {
      setError(e.error || 'Ошибка сохранения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white">{form.id ? 'Редактировать лид' : 'Добавить лид'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          {error && <div className="text-red-400 text-sm bg-red-900/20 rounded-lg px-3 py-2">{error}</div>}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Username Instagram *</label>
            <input className="input" placeholder="username" value={form.username}
              onChange={e => setForm(f => ({ ...f, username: e.target.value.replace('@', '') }))} />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Полное имя</label>
            <input className="input" placeholder="Иван Иванов" value={form.full_name || ''}
              onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Email</label>
              <input className="input" placeholder="email@example.com" value={form.email || ''}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Ниша</label>
              <input className="input" placeholder="Фитнес, Бизнес..." value={form.niche || ''}
                onChange={e => setForm(f => ({ ...f, niche: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Bio</label>
            <input className="input" placeholder="Описание из профиля" value={form.bio || ''}
              onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Заметки</label>
            <textarea className="input resize-none" rows={2} placeholder="Внутренние заметки" value={form.notes || ''}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          {form.id && (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Статус</label>
              <select className="input" value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="flex gap-3 p-5 border-t border-gray-800">
          <button onClick={onClose} className="btn-secondary flex-1">Отмена</button>
          <button onClick={handleSave} disabled={loading} className="btn-primary flex-1">
            {loading ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const fileRef = useRef();

  const handleImport = async () => {
    if (!file) return setError('Выберите файл');
    setLoading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post('/leads/import', formData);
      setResult(res);
    } catch (e) {
      setError(e.error || 'Ошибка импорта');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white">Импорт лидов</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          {error && <div className="text-red-400 text-sm bg-red-900/20 rounded-lg px-3 py-2">{error}</div>}
          {result ? (
            <div className="text-center space-y-2">
              <div className="text-4xl">✅</div>
              <div className="text-green-400 font-medium">Импорт завершён</div>
              <div className="text-gray-400 text-sm">Импортировано: <strong className="text-white">{result.imported}</strong></div>
              <div className="text-gray-400 text-sm">Пропущено (дубли): <strong className="text-white">{result.skipped}</strong></div>
            </div>
          ) : (
            <>
              <div
                className="border-2 border-dashed border-gray-700 rounded-xl p-8 text-center cursor-pointer hover:border-brand-500 transition-colors"
                onClick={() => fileRef.current.click()}
              >
                <Upload className="mx-auto text-gray-600 mb-2" size={32} />
                <p className="text-gray-400 text-sm">{file ? file.name : 'Нажмите или перетащите файл'}</p>
                <p className="text-gray-600 text-xs mt-1">Поддерживаются CSV, XLSX, XLS</p>
                <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
                  onChange={e => setFile(e.target.files[0])} />
              </div>
              <div className="bg-gray-800 rounded-lg p-3 text-xs text-gray-400">
                <div className="font-medium text-gray-300 mb-1">Колонки в файле:</div>
                <div>username / instagram / handle <span className="text-brand-400">(обязательно)</span></div>
                <div>full_name / name, email, bio, niche, notes <span className="text-gray-600">(опционально)</span></div>
              </div>
            </>
          )}
        </div>
        <div className="flex gap-3 p-5 border-t border-gray-800">
          {result ? (
            <button onClick={() => { onImported(); onClose(); }} className="btn-primary w-full">Готово</button>
          ) : (
            <>
              <button onClick={onClose} className="btn-secondary flex-1">Отмена</button>
              <button onClick={handleImport} disabled={loading || !file} className="btn-primary flex-1">
                {loading ? 'Загрузка...' : 'Импортировать'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Leads() {
  const [leads, setLeads] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editLead, setEditLead] = useState(null);
  const LIMIT = 50;

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      const res = await api.get(`/leads?${params}`);
      setLeads(res.leads);
      setTotal(res.total);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [page, statusFilter]);
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); load(); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const handleDelete = async (id) => {
    if (!confirm('Удалить лид?')) return;
    try {
      await api.delete(`/leads/${id}`);
      load();
    } catch (e) {
      console.error('Delete error:', e);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selected.size || !confirm(`Удалить ${selected.size} лид(ов)?`)) return;
    try {
      await api.post('/leads/bulk-delete', { ids: [...selected] });
      setSelected(new Set());
      load();
    } catch (e) {
      console.error('Bulk delete error:', e);
    }
  };

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === leads.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(leads.map(l => l.id)));
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="p-6 space-y-5">
      {(showAdd || editLead) && (
        <LeadModal lead={editLead} onClose={() => { setShowAdd(false); setEditLead(null); }} onSave={() => { setShowAdd(false); setEditLead(null); load(); }} />
      )}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={load} />}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Лиды</h1>
          <p className="text-gray-500 text-sm mt-1">Всего: {total}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowImport(true)} className="btn-secondary flex items-center gap-2 text-sm">
            <Upload size={15} /> Импорт CSV/Excel
          </button>
          <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={15} /> Добавить лид
          </button>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={15} />
          <input className="input pl-9 text-sm" placeholder="Поиск по username, имени..." value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input text-sm w-44" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="">Все статусы</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        {selected.size > 0 && (
          <button onClick={handleDeleteSelected} className="btn-danger flex items-center gap-2 text-sm">
            <Trash2 size={14} /> Удалить ({selected.size})
          </button>
        )}
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800">
              <tr className="text-left text-gray-500 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 w-8">
                  <input type="checkbox" checked={leads.length > 0 && selected.size === leads.length}
                    onChange={toggleAll} className="accent-brand-500 cursor-pointer" />
                </th>
                <th className="px-4 py-3">Username</th>
                <th className="px-4 py-3">Имя</th>
                <th className="px-4 py-3">Ниша</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Статус</th>
                <th className="px-4 py-3">Дата</th>
                <th className="px-4 py-3 w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {loading ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-600">Загрузка...</td></tr>
              ) : leads.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-600">Нет лидов</td></tr>
              ) : leads.map(lead => (
                <tr key={lead.id} className={`hover:bg-gray-800/40 transition-colors ${selected.has(lead.id) ? 'bg-gray-800/60' : ''}`}>
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(lead.id)} onChange={() => toggleSelect(lead.id)}
                      className="accent-brand-500 cursor-pointer" />
                  </td>
                  <td className="px-4 py-3">
                    <a href={`https://instagram.com/${lead.username}`} target="_blank" rel="noopener noreferrer"
                      className="text-brand-400 hover:text-brand-300 font-medium">@{lead.username}</a>
                  </td>
                  <td className="px-4 py-3 text-gray-300">{lead.full_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-400">{lead.niche || '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{lead.email || '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={lead.status} /></td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{lead.created_at?.slice(0, 10)}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => setEditLead(lead)} className="p-1.5 text-gray-500 hover:text-gray-300 rounded-md hover:bg-gray-800">
                        <Edit2 size={13} />
                      </button>
                      <button onClick={() => handleDelete(lead.id)} className="p-1.5 text-gray-500 hover:text-red-400 rounded-md hover:bg-gray-800">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
            <span className="text-xs text-gray-500">Стр. {page} из {totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">
                <ChevronLeft size={14} />
              </button>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
