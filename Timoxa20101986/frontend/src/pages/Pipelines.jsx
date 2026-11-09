import React, { useEffect, useRef, useState } from 'react';
import {
  Plus, Trophy, Trash2, X, Search, Check, MessageSquareReply,
  Send, Pencil, GripVertical, UserPlus, MoreVertical
} from 'lucide-react';
import api from '../utils/api.js';

const STAGE_COLORS = [
  '#3b82f6', '#f59e0b', '#8b5cf6', '#22c55e', '#ef4444',
  '#ec4899', '#14b8a6', '#6366f1', '#f97316', '#64748b',
];

function OutreachBadge({ status }) {
  if (status === 'replied') return <span className="badge-green inline-flex items-center gap-1"><MessageSquareReply size={11} /> Ответил</span>;
  if (status === 'sent') return <span className="badge-blue inline-flex items-center gap-1"><Send size={11} /> Отправлено</span>;
  if (status === 'failed') return <span className="badge-red">Ошибка</span>;
  return null;
}

export default function Pipelines() {
  const [pipelines, setPipelines] = useState([]);
  const [activePipeline, setActivePipeline] = useState(null);
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);

  const [newColumn, setNewColumn] = useState('');
  const [editingStage, setEditingStage] = useState(null); // { id, value }
  const [menuStage, setMenuStage] = useState(null);        // stage id whose menu is open
  const [dragOverStage, setDragOverStage] = useState(null);
  const [addModal, setAddModal] = useState(null);          // { stageId }
  const [detail, setDetail] = useState(null);              // { contact, pcId, stageId }
  const [renamingPipeline, setRenamingPipeline] = useState(false);
  const [pipelineName, setPipelineName] = useState('');

  const dragRef = useRef(null); // { pcId, fromStageId }

  const loadPipelines = async () => {
    const data = await api.get('/pipelines');
    setPipelines(data);
    setActivePipeline(prev => data.find(p => p.id === prev?.id) || data[0] || null);
    return data;
  };

  const loadStages = async (pid) => {
    if (!pid) { setStages([]); return; }
    const data = await api.get(`/pipelines/${pid}/stages`);
    setStages(data);
  };

  useEffect(() => {
    loadPipelines().catch(console.error).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activePipeline) loadStages(activePipeline.id).catch(console.error);
  }, [activePipeline?.id]);

  // ----- Columns (stages) -----
  const addColumn = async () => {
    const name = newColumn.trim();
    if (!name || !activePipeline) return;
    const color = STAGE_COLORS[stages.length % STAGE_COLORS.length];
    await api.post(`/pipelines/${activePipeline.id}/stages`, { name, color });
    setNewColumn('');
    loadStages(activePipeline.id);
  };

  const renameStage = async (stageId, name) => {
    setEditingStage(null);
    const clean = (name || '').trim();
    if (!clean) return;
    setStages(prev => prev.map(s => s.id === stageId ? { ...s, name: clean } : s));
    await api.put(`/pipelines/stages/${stageId}`, { name: clean }).catch(() => loadStages(activePipeline.id));
  };

  const recolorStage = async (stageId, color) => {
    setMenuStage(null);
    setStages(prev => prev.map(s => s.id === stageId ? { ...s, color } : s));
    await api.put(`/pipelines/stages/${stageId}`, { color }).catch(() => loadStages(activePipeline.id));
  };

  const deleteStage = async (stageId) => {
    setMenuStage(null);
    const st = stages.find(s => s.id === stageId);
    if (st?.contacts?.length && !confirm(`Удалить колонку «${st.name}» и убрать ${st.contacts.length} лид(ов) с доски?`)) return;
    if (!st?.contacts?.length && !confirm('Удалить эту колонку?')) return;
    await api.delete(`/pipelines/stages/${stageId}`);
    loadStages(activePipeline.id);
  };

  // ----- Drag & drop of cards -----
  const onDrop = async (targetStageId) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragOverStage(null);
    if (!drag || drag.fromStageId === targetStageId) return;

    // Optimistic move.
    setStages(prev => {
      let moved = null;
      const stripped = prev.map(s => {
        if (s.id !== drag.fromStageId) return s;
        const contacts = (s.contacts || []).filter(c => {
          if (c.pipeline_contact_id === drag.pcId) { moved = c; return false; }
          return true;
        });
        return { ...s, contacts };
      });
      if (!moved) return prev;
      return stripped.map(s => s.id === targetStageId ? { ...s, contacts: [moved, ...(s.contacts || [])] } : s);
    });

    try {
      await api.put(`/pipelines/pipeline-contacts/${drag.pcId}`, { stage_id: targetStageId });
    } catch {
      loadStages(activePipeline.id);
    }
  };

  const removeFromBoard = async (pcId) => {
    setDetail(null);
    setStages(prev => prev.map(s => ({ ...s, contacts: (s.contacts || []).filter(c => c.pipeline_contact_id !== pcId) })));
    await api.delete(`/pipelines/pipeline-contacts/${pcId}`).catch(() => loadStages(activePipeline.id));
  };

  // ----- Pipelines -----
  const createPipeline = async () => {
    const name = prompt('Название новой доски:');
    if (!name?.trim()) return;
    const p = await api.post('/pipelines', { name: name.trim() });
    const data = await loadPipelines();
    setActivePipeline(data.find(x => x.id === p.id) || p);
  };

  const savePipelineName = async () => {
    const name = pipelineName.trim();
    setRenamingPipeline(false);
    if (!name || !activePipeline || name === activePipeline.name) return;
    await api.put(`/pipelines/${activePipeline.id}`, { name });
    loadPipelines();
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="text-gray-400">Загрузка...</div></div>;

  return (
    <div className="p-6 h-full flex flex-col" onClick={() => setMenuStage(null)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Воронка (CRM)</h1>
          <p className="text-gray-500 text-sm mt-1">Перетаскивай лидов между колонками. Держи карточку мышкой и веди в нужный столбец.</p>
        </div>
        <div className="flex items-center gap-2">
          {pipelines.map(p => (
            <button key={p.id} onClick={() => setActivePipeline(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                activePipeline?.id === p.id ? 'bg-orange-50 text-orange-700 border border-orange-200' : 'text-gray-500 hover:bg-gray-100'
              }`}>
              {p.name}
            </button>
          ))}
          <button onClick={createPipeline} className="btn-secondary text-sm py-1.5 flex items-center gap-1"><Plus size={15} /> Доска</button>
        </div>
      </div>

      {activePipeline && (
        <div className="flex items-center gap-2 mb-4 flex-shrink-0">
          {renamingPipeline ? (
            <input autoFocus className="input max-w-xs text-sm" value={pipelineName}
              onChange={e => setPipelineName(e.target.value)}
              onBlur={savePipelineName}
              onKeyDown={e => { if (e.key === 'Enter') savePipelineName(); if (e.key === 'Escape') setRenamingPipeline(false); }} />
          ) : (
            <button onClick={() => { setRenamingPipeline(true); setPipelineName(activePipeline.name); }}
              className="text-sm text-gray-500 hover:text-gray-800 flex items-center gap-1">
              <Pencil size={13} /> Переименовать доску
            </button>
          )}
        </div>
      )}

      {/* Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex gap-4 h-full items-start pb-4">
          {stages.map(stage => (
            <div
              key={stage.id}
              onDragOver={e => { e.preventDefault(); setDragOverStage(stage.id); }}
              onDragLeave={() => setDragOverStage(prev => prev === stage.id ? null : prev)}
              onDrop={() => onDrop(stage.id)}
              className={`w-80 flex-shrink-0 rounded-xl flex flex-col max-h-full transition-colors ${
                dragOverStage === stage.id ? 'bg-orange-50 ring-2 ring-orange-300' : 'bg-gray-50'
              }`}
            >
              {/* Column header */}
              <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-200 relative">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: stage.color }} />
                {editingStage?.id === stage.id ? (
                  <input autoFocus className="input py-1 text-sm flex-1"
                    value={editingStage.value}
                    onChange={e => setEditingStage({ id: stage.id, value: e.target.value })}
                    onBlur={() => renameStage(stage.id, editingStage.value)}
                    onKeyDown={e => { if (e.key === 'Enter') renameStage(stage.id, editingStage.value); if (e.key === 'Escape') setEditingStage(null); }} />
                ) : (
                  <h3 className="text-sm font-semibold text-gray-800 flex-1 cursor-text truncate"
                    onClick={() => setEditingStage({ id: stage.id, value: stage.name })} title="Нажми, чтобы переименовать">
                    {stage.name}
                  </h3>
                )}
                <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">{stage.contacts?.length || 0}</span>
                <button onClick={e => { e.stopPropagation(); setMenuStage(menuStage === stage.id ? null : stage.id); }}
                  className="text-gray-400 hover:text-gray-700 p-0.5"><MoreVertical size={15} /></button>

                {menuStage === stage.id && (
                  <div className="absolute right-2 top-11 z-20 card p-2 w-44" onClick={e => e.stopPropagation()}>
                    <div className="text-[11px] text-gray-400 px-1 pb-1">Цвет колонки</div>
                    <div className="grid grid-cols-5 gap-1.5 mb-2 px-1">
                      {STAGE_COLORS.map(col => (
                        <button key={col} onClick={() => recolorStage(stage.id, col)}
                          className="w-6 h-6 rounded-full border border-black/10 hover:scale-110 transition-transform"
                          style={{ background: col }} />
                      ))}
                    </div>
                    <button onClick={() => deleteStage(stage.id)}
                      className="w-full text-left text-sm text-red-500 hover:bg-red-50 rounded-md px-2 py-1.5 flex items-center gap-2">
                      <Trash2 size={14} /> Удалить колонку
                    </button>
                  </div>
                )}
              </div>

              {/* Cards */}
              <div className="p-2 space-y-2 overflow-y-auto flex-1 min-h-[120px]">
                {(stage.contacts || []).map(c => (
                  <div
                    key={c.pipeline_contact_id}
                    draggable
                    onDragStart={() => { dragRef.current = { pcId: c.pipeline_contact_id, fromStageId: stage.id }; }}
                    onDragEnd={() => { dragRef.current = null; setDragOverStage(null); }}
                    onClick={() => setDetail({ contact: c, pcId: c.pipeline_contact_id, stageId: stage.id })}
                    className="group bg-white border border-gray-200 rounded-lg p-3 cursor-grab active:cursor-grabbing hover:shadow-md hover:border-gray-300 transition-all"
                  >
                    <div className="flex items-start gap-2">
                      <GripVertical size={14} className="text-gray-300 mt-0.5 flex-shrink-0 group-hover:text-gray-400" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-gray-900 truncate">@{c.username}</span>
                          {c.deal_won ? <Trophy className="text-yellow-500 flex-shrink-0" size={13} /> : null}
                        </div>
                        {c.full_name && <p className="text-xs text-gray-500 truncate mt-0.5">{c.full_name}</p>}
                        {(c.outreach_status || c.deal_value > 0) && (
                          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                            <OutreachBadge status={c.outreach_status} />
                            {c.deal_value > 0 && <span className="badge-green">{Number(c.deal_value).toLocaleString('ru-RU')} ₽</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                <button onClick={() => setAddModal({ stageId: stage.id })}
                  className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg py-2 transition-colors">
                  <UserPlus size={15} /> Добавить лида
                </button>
              </div>
            </div>
          ))}

          {/* Add column */}
          <div className="w-72 flex-shrink-0">
            <div className="flex gap-2">
              <input className="input text-sm" placeholder="Новая колонка..." value={newColumn}
                onChange={e => setNewColumn(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addColumn()} />
              <button onClick={addColumn} className="btn-primary text-sm px-3"><Plus size={16} /></button>
            </div>
            {stages.length === 0 && (
              <p className="text-xs text-gray-400 mt-3 px-1">Создай первую колонку — например «Ответили», «Переговоры», «Оплатил».</p>
            )}
          </div>
        </div>
      </div>

      {addModal && (
        <AddLeadModal
          stageId={addModal.stageId}
          stageName={stages.find(s => s.id === addModal.stageId)?.name}
          onClose={() => setAddModal(null)}
          onAdded={() => { setAddModal(null); loadStages(activePipeline.id); }}
        />
      )}

      {detail && (
        <LeadDrawer
          detail={detail}
          onClose={() => setDetail(null)}
          onRemove={() => removeFromBoard(detail.pcId)}
          onSaved={() => { setDetail(null); loadStages(activePipeline.id); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-lead modal: search existing contacts (with a "replied" filter) or quick-
// add a brand-new one by @username. All routed through /add-lead so it works
// whether the contact exists yet or not.
// ---------------------------------------------------------------------------
function AddLeadModal({ stageId, stageName, onClose, onAdded }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [repliedOnly, setRepliedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        // Pull the full contact list (not a 30-row slice) so the whole book is
        // browsable here; search narrows it server-side when the user types.
        const params = new URLSearchParams({ limit: '1000' });
        if (query.trim()) params.set('search', query.trim());
        const data = await api.get(`/contacts?${params.toString()}`);
        if (alive) { setResults(data.contacts || []); setTotal(data.total || 0); }
      } catch { if (alive) { setResults([]); setTotal(0); } }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  const shown = repliedOnly ? results.filter(c => c.outreach_status === 'replied') : results;
  const cleanQuery = query.trim().replace('@', '');
  const exactExists = results.some(c => c.username.toLowerCase() === cleanQuery.toLowerCase());

  const add = async (username, full_name) => {
    setBusy(true); setErr('');
    try {
      await api.post(`/pipelines/stages/${stageId}/add-lead`, { username, full_name });
      onAdded();
    } catch (e) {
      setErr(e.error || 'Не удалось добавить');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 p-4 pt-16 overflow-y-auto" onClick={onClose}>
      <div className="card w-full max-w-md p-0 overflow-hidden my-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900">Добавить лида в «{stageName}»</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>

        <div className="p-4">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input autoFocus className="input pl-9 text-sm" placeholder="Поиск по @username или имени..."
              value={query} onChange={e => setQuery(e.target.value)} />
          </div>

          <div className="flex items-center justify-between gap-2 mt-3">
            <button onClick={() => setRepliedOnly(v => !v)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors flex items-center gap-1 ${
                repliedOnly ? 'bg-green-50 text-green-700 border-green-200' : 'text-gray-500 border-gray-200 hover:bg-gray-100'
              }`}>
              <MessageSquareReply size={12} /> Только ответившие
            </button>
            <span className="text-xs text-gray-400">
              {repliedOnly ? `${shown.length} ответивших` : `${results.length}${total > results.length ? ` из ${total}` : ''} контактов`}
            </span>
          </div>

          {err && <p className="text-xs text-red-500 mt-3">{err}</p>}
          {!repliedOnly && total > results.length && (
            <p className="text-[11px] text-gray-400 mt-2">Показаны первые {results.length}. Введите @username или имя, чтобы найти остальных.</p>
          )}

          <div className="mt-3 max-h-[55vh] overflow-y-auto space-y-1">
            {cleanQuery && !exactExists && (
              <button disabled={busy} onClick={() => add(cleanQuery)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-orange-300 text-orange-600 hover:bg-orange-50 text-sm">
                <Plus size={15} /> Создать и добавить <span className="font-semibold">@{cleanQuery}</span>
              </button>
            )}
            {shown.map(c => (
              <button key={c.id} disabled={busy} onClick={() => add(c.username, c.full_name)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-100 text-left">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">@{c.username}</div>
                  {c.full_name && <div className="text-xs text-gray-500 truncate">{c.full_name}</div>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <OutreachBadge status={c.outreach_status} />
                  <Plus size={15} className="text-gray-400" />
                </div>
              </button>
            ))}
            {shown.length === 0 && !cleanQuery && (
              <p className="text-xs text-gray-400 text-center py-6">Начни вводить @username, чтобы найти или создать лида.</p>
            )}
            {shown.length === 0 && cleanQuery && exactExists && (
              <p className="text-xs text-gray-400 text-center py-4">Ничего не найдено по фильтру.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lead card drawer: view/edit contact details, mark a deal won, remove from
// the board.
// ---------------------------------------------------------------------------
const QUALITY = [
  { v: 'unknown', label: 'Не определено' },
  { v: 'hot', label: '🔥 Горячий' },
  { v: 'warm', label: 'Тёплый' },
  { v: 'cold', label: 'Холодный' },
];

function LeadDrawer({ detail, onClose, onRemove, onSaved }) {
  const c = detail.contact;
  const [form, setForm] = useState({
    username: c.username || '',
    full_name: c.full_name || '',
    email: c.email || '',
    phone: c.phone || '',
    company: c.company || '',
    notes: c.notes || '',
    lead_quality: c.lead_quality || 'unknown',
    deal_won: !!c.deal_won,
    deal_value: c.deal_value || 0,
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/contacts/${c.id}`, {
        ...form,
        deal_won: form.deal_won ? 1 : 0,
        deal_value: Number(form.deal_value) || 0,
      });
      onSaved();
    } catch {
      setSaving(false);
    }
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-md h-full bg-white border-l border-gray-200 shadow-xl flex flex-col animate-[slideIn_.15s_ease-out]"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-gray-900 truncate">@{form.username}</h3>
              {form.deal_won && <Trophy size={16} className="text-yellow-500" />}
            </div>
            <a href={`https://instagram.com/${form.username}`} target="_blank" rel="noreferrer"
              className="text-xs text-orange-600 hover:underline">Открыть в Instagram ↗</a>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {c.outreach_status && (
            <div className="flex items-center gap-2"><span className="text-xs text-gray-400">Статус рассылки:</span><OutreachBadge status={c.outreach_status} /></div>
          )}

          <Field label="Имя"><input className="input text-sm" value={form.full_name} onChange={e => set('full_name', e.target.value)} placeholder="Имя лида" /></Field>

          <Field label="Качество лида">
            <select className="input text-sm" value={form.lead_quality} onChange={e => set('lead_quality', e.target.value)}>
              {QUALITY.map(q => <option key={q.v} value={q.v}>{q.label}</option>)}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Телефон"><input className="input text-sm" value={form.phone} onChange={e => set('phone', e.target.value)} /></Field>
            <Field label="Email"><input className="input text-sm" value={form.email} onChange={e => set('email', e.target.value)} /></Field>
          </div>

          <Field label="Заметки">
            <textarea className="input text-sm min-h-[90px] resize-y" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Договорённости, детали переписки..." />
          </Field>

          <div className="card bg-gray-50 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.deal_won} onChange={e => set('deal_won', e.target.checked)} />
              <span className="text-sm font-medium text-gray-800 flex items-center gap-1"><Trophy size={14} className="text-yellow-500" /> Сделка закрыта</span>
            </label>
            {form.deal_won && (
              <Field label="Сумма сделки (₽)">
                <input type="number" className="input text-sm" value={form.deal_value} onChange={e => set('deal_value', e.target.value)} />
              </Field>
            )}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-gray-200 flex items-center justify-between gap-2">
          <button onClick={onRemove} className="text-sm text-red-500 hover:text-red-600 flex items-center gap-1">
            <Trash2 size={14} /> Убрать с доски
          </button>
          <button onClick={save} disabled={saving} className="btn-primary text-sm flex items-center gap-1">
            <Check size={15} /> {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
