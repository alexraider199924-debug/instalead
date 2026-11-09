import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Edit2, Trash2, X, Trophy, ChevronLeft, ChevronRight, Send, Upload, Download, Columns, MessageSquare, Check, Sparkles, Pause, Play, CircleAlert } from 'lucide-react';
import api, { getCurrentWorkspace } from '../utils/api.js';

const QUALITY_OPTIONS = ['hot', 'warm', 'cold', 'unqualified'];
const QUALITY_MAP = {
  hot: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', label: 'Hot' },
  warm: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', label: 'Warm' },
  cold: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', label: 'Cold' },
  unqualified: { bg: 'bg-gray-100', text: 'text-gray-600', border: 'border-gray-200', label: 'Unqualified' },
  unknown: { bg: 'bg-gray-50', text: 'text-gray-500', border: 'border-gray-200', label: 'N/A' },
};

const ALL_COLUMNS = [
  { key: 'username', label: 'Instagram', default: true },
  { key: 'full_name', label: 'Имя', default: true },
  { key: 'enrich_status', label: 'Конспект', default: true },
  { key: 'outreach', label: 'Рассылка', default: true },
  { key: 'email', label: 'Email', default: true },
  { key: 'phone', label: 'Телефон', default: true },
  { key: 'pipeline_name', label: 'Pipeline', default: true },
  { key: 'stage_name', label: 'Этап', default: true },
  { key: 'lead_quality', label: 'Качество', default: true },
  { key: 'deal', label: 'Сделка', default: true },
  { key: 'profile_summary', label: 'Конспект (текст)', default: false },
  { key: 'company', label: 'Компания', default: false },
  { key: 'created_at', label: 'Создан', default: false },
  { key: 'notes', label: 'Заметки', default: false },
];

const ENRICH_MAP = {
  done: { label: 'Готов', cls: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' },
  queued: { label: 'В очереди', cls: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-500' },
  working: { label: 'Читаю', cls: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-400' },
  failed: { label: 'Нет данных', cls: 'bg-gray-100 text-gray-600 border-gray-200', dot: 'bg-gray-400' },
  none: { label: '—', cls: 'bg-gray-50 text-gray-400 border-gray-200', dot: 'bg-gray-300' },
};

// Only outcomes that actually occurred. A contact with no send history shows
// a dash rather than an "awaiting"-style label.
const OUTREACH_MAP = {
  replied: { label: 'Ответил', cls: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' },
  sent: { label: 'Отправлено', cls: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-500' },
  failed: { label: 'Не дошло', cls: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
  skipped: { label: 'Пропущен', cls: 'bg-gray-100 text-gray-600 border-gray-200', dot: 'bg-gray-400' },
};

function OutreachBadge({ status, at }) {
  const s = OUTREACH_MAP[status];
  if (!s) return <span className="text-gray-400 text-xs">—</span>;
  const when = at ? String(at).slice(0, 16).replace('T', ' ') : null;
  return (
    <span
      title={when ? `${s.label} · ${when}` : s.label}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${s.cls}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function QualityBadge({ quality }) {
  const q = QUALITY_MAP[quality] || QUALITY_MAP.unknown;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${q.bg} ${q.text} border ${q.border}`}>{q.label}</span>;
}

function EnrichBadge({ contact }) {
  const s = ENRICH_MAP[contact.enrich_status] || ENRICH_MAP.none;
  // A note written under the previous contract still gets used by the send
  // path — it is not broken, just weaker than what the current one produces.
  // Marked rather than hidden so the difference is a visible fact instead of a
  // vague sense that some contacts write better than others.
  const stale = contact.enrich_status === 'done' && contact.note_stale;

  const title = stale
    ? `${contact.profile_summary || 'Конспект готов'}\n\nКонспект сохранён по старому формату. Обновите его — новая версия ищет больше конкретики.`
    : contact.enrich_status === 'failed'
      ? (contact.enrich_error || 'Не удалось прочитать профиль')
      : contact.enrich_status === 'done'
        ? (contact.profile_summary || 'Конспект готов')
        : s.label;

  return (
    <span title={title}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${s.cls} ${contact.enrich_status === 'none' ? 'cursor-default' : 'cursor-help'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${contact.enrich_status === 'working' ? 'animate-pulse' : ''}`} />
      {s.label}
      {stale && <span className="text-amber-600 font-semibold" aria-label="старый формат">*</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Readiness
//
// Enrichment depends on two things this page cannot see by looking at a row: a
// paid AI key (the note is written by a model) and a browser extension signed
// into Instagram (the profiles are read by it — the server cannot read them).
// Both used to be invisible until something failed, so a user with no key could
// press the button, watch ten profiles get read, and end up with nothing. The
// server is asked once and the answer is shown before the click.
// ---------------------------------------------------------------------------
function useEnrichReadiness(active) {
  const [readiness, setReadiness] = useState(null);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const res = await api.get('/contact-enrich/readiness');
        if (!stopped) setReadiness(res);
      } catch (e) {
        if (!stopped) setReadiness(null);
      }
    };
    check();
    const t = setInterval(check, active ? 10000 : 30000);
    return () => { stopped = true; clearInterval(t); };
  }, [active]);

  return readiness;
}

function EnrichNotice({ readiness }) {
  if (!readiness) return null;
  const blockers = readiness.blockers || [];
  const warnings = readiness.warnings || [];
  if (!blockers.length && !warnings.length) return null;

  return (
    <div className="space-y-2">
      {blockers.map(b => (
        <div key={b.code} className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 flex items-start gap-2">
          <CircleAlert size={16} className="mt-0.5 flex-shrink-0" />
          <span>
            <b>{b.title}.</b> {b.message}
            {b.fix === '/integrations' && (
              <> <Link to="/integrations" className="underline font-medium">Перейти в Интеграции</Link></>
            )}
          </span>
        </div>
      ))}
      {warnings.map(w => (
        <div key={w.code} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2">
          <CircleAlert size={16} className="mt-0.5 flex-shrink-0" />
          <span><b>{w.title}.</b> {w.message}</span>
        </div>
      ))}
    </div>
  );
}

// The three actors in the pipeline. This is the single most misunderstood thing
// about the feature — "обогащение сломано" is very often "расширение закрыто" or
// "не задан ключ", both of which look identical from the Contacts table.
const ENRICH_STEPS = [
  {
    title: '1. Расширение читает профиль',
    text: 'Chrome с Instalead заходит на страницу контакта и снимает био и подписи последних постов. Это единственный источник данных: с сервера профили Instagram прочитать нельзя.'
  },
  {
    title: '2. ИИ пишет конспект',
    text: 'Модель читает снятое и записывает, чем человек зарабатывает, чем занят помимо Instagram, что о нём видно из постов — в одном абзаце, начинающемся со слов «В профиле».'
  },
  {
    title: '3. Конспект уходит в персонализацию',
    text: 'Из конспекта берутся три коротких крючка — то, с чего начинается личное сообщение. Именно на них получатель узнаёт, что профиль действительно прочитали, а не подставили имя.'
  },
];

function EnrichPipeline() {
  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">Как это работает</div>
      <ol className="space-y-2">
        {ENRICH_STEPS.map(s => (
          <li key={s.title} className="text-xs text-gray-700">
            <span className="font-semibold text-gray-900">{s.title}</span>
            <br />{s.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

// The note is written once and then trusted by the send path, so being able to
// read it — and to throw it away — is part of the feature, not a nicety. A bad
// note is otherwise invisible until a DM goes out built on it.
function SummaryModal({ contact, onClose }) {
  const [summary, setSummary] = useState(contact.profile_summary || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/contacts/${contact.id}/enrich-note`, { summary });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onClose(true);
    } catch (e) {
      alert('Не удалось сохранить: ' + (e?.error || e.message));
    }
    setSaving(false);
  };

  const clear = async () => {
    if (!confirm('Удалить конспект? При следующей рассылке ИИ не будет на него опираться.')) return;
    await api.post(`/contacts/${contact.id}/enrich-note`, { summary: '' });
    onClose(true);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Конспект @{contact.username}</h2>
            <p className="text-xs text-gray-500 mt-1">
              Подготовлен {contact.profile_enriched_at ? new Date(contact.profile_enriched_at).toLocaleString('ru') : '—'}.
              При рассылке ИИ опирается на этот конспект и внутренние сигналы профиля.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <textarea className="input resize-y text-sm min-h-[180px] w-full" value={summary}
          onChange={e => setSummary(e.target.value)}
          placeholder="Конспект пуст — при рассылке модель не будет делать вид, что знает профиль." />

        <div className="flex items-center justify-between mt-4">
          <button onClick={clear} className="text-sm text-red-600 hover:text-red-700">Удалить конспект</button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="btn-secondary text-sm">Закрыть</button>
            <button onClick={save} disabled={saving} className="btn-primary text-sm">
              {saving ? 'Сохранение…' : saved ? 'Сохранено' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [step, setStep] = useState('upload');
  const [columns, setColumns] = useState([]);
  const [preview, setPreview] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [mapping, setMapping] = useState({ username: '', full_name: '', bio: '' });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleFileSelect = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setLoading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', f);
      const res = await fetch('/api/contacts/import/preview', { method: 'POST', body: formData, headers: { 'X-Workspace': getCurrentWorkspace() } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setColumns(data.columns || []);
      setPreview(data.preview || []);
      setTotalRows(data.total_rows || 0);
      const auto = {};
      const colLower = data.columns.map(c => c.toLowerCase());
      const usernameIdx = colLower.findIndex(c => c.includes('username') || c.includes('instagram') || c === 'ig');
      const nameIdx = colLower.findIndex(c => c.includes('name') || c.includes('имя') || c === 'full_name' || c === 'first_name');
      const bioIdx = colLower.findIndex(c => c.includes('bio') || c.includes('описание') || c.includes('about'));
      auto.username = usernameIdx >= 0 ? data.columns[usernameIdx] : '';
      auto.full_name = nameIdx >= 0 ? data.columns[nameIdx] : '';
      auto.bio = bioIdx >= 0 ? data.columns[bioIdx] : '';
      setMapping(auto);
      setStep('map');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!mapping.username) return setError('Username column is required');
    setLoading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('mapping', JSON.stringify(mapping));
      const res = await fetch('/api/contacts/import', { method: 'POST', body: formData, headers: { 'X-Workspace': getCurrentWorkspace() } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setResult(data);
      setStep('done');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const SYSTEM_FIELDS = [
    { key: 'username', label: 'Instagram Username', required: true },
    { key: 'full_name', label: 'First Name / Full Name', required: false },
    { key: 'bio', label: 'Bio', required: false },
  ];

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-2xl shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">
            {step === 'upload' && 'Import from CSV/Excel'}
            {step === 'map' && 'Map columns'}
            {step === 'done' && 'Import complete'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {error && <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {step === 'upload' && (
            <div className="text-center py-8">
              <div className="w-16 h-16 mx-auto mb-4 bg-orange-50 rounded-2xl flex items-center justify-center">
                <Upload className="text-orange-500" size={28} />
              </div>
              <p className="text-sm text-gray-600 mb-4">Upload a CSV or Excel file with your leads.</p>
              <label className="btn-primary inline-flex items-center gap-2 cursor-pointer text-sm">
                <Upload size={14} /> Choose file
                <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} className="hidden" />
              </label>
              {loading && <p className="text-sm text-gray-400 mt-4">Analyzing file...</p>}
            </div>
          )}

          {step === 'map' && (
            <div>
              <p className="text-sm text-gray-600 mb-4">
                Found <span className="font-semibold">{totalRows}</span> rows and <span className="font-semibold">{columns.length}</span> columns in your file.
                Map file columns to system fields below.
              </p>

              <div className="space-y-3 mb-6">
                {SYSTEM_FIELDS.map(sf => (
                  <div key={sf.key} className="flex items-center gap-4">
                    <div className="w-48 flex-shrink-0">
                      <div className="text-sm font-medium text-gray-800">
                        {sf.label} {sf.required && <span className="text-red-500">*</span>}
                      </div>
                    </div>
                    <select
                      className="input text-sm flex-1"
                      value={mapping[sf.key]}
                      onChange={e => setMapping(m => ({ ...m, [sf.key]: e.target.value }))}
                    >
                      <option value="">— Skip —</option>
                      {columns.map(col => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {preview.length > 0 && (
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Preview (first {preview.length} rows)</div>
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          {columns.map(col => (
                            <th key={col} className="px-3 py-2 text-left text-gray-500 font-medium">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {preview.map((row, i) => (
                          <tr key={i}>
                            {columns.map(col => (
                              <td key={col} className="px-3 py-2 text-gray-700 max-w-40 truncate">{row[col] || ''}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 'done' && result && (
            <div className="text-center py-8">
              <div className="w-16 h-16 mx-auto mb-4 bg-green-50 rounded-2xl flex items-center justify-center">
                <Check className="text-green-500" size={28} />
              </div>
              <p className="text-lg font-semibold text-gray-900 mb-2">Import successful</p>
              <div className="flex justify-center gap-6 text-sm">
                <div>
                  <div className="text-2xl font-bold text-green-600">{result.imported}</div>
                  <div className="text-gray-500">Imported</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-400">{result.skipped}</div>
                  <div className="text-gray-500">Skipped (duplicates)</div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3 p-5 border-t border-gray-100">
          {step === 'map' && (
            <>
              <button onClick={() => { setStep('upload'); setFile(null); setColumns([]); setPreview([]); }} className="btn-secondary flex-1">Back</button>
              <button onClick={handleImport} disabled={loading || !mapping.username} className="btn-primary flex-1">
                {loading ? 'Importing...' : `Import ${totalRows} leads`}
              </button>
            </>
          )}
          {step === 'done' && (
            <button onClick={() => { onImported(); onClose(); }} className="btn-primary flex-1">Done</button>
          )}
          {step === 'upload' && !loading && (
            <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}

function ContactModal({ contact, onClose, onSave }) {
  const [form, setForm] = useState(
    contact || { username: '', full_name: '', email: '', phone: '', company: '', lead_quality: 'warm', notes: '' }
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!form.username.trim()) return setError('Username обязателен');
    setLoading(true);
    try {
      if (form.id) {
        await api.put(`/contacts/${form.id}`, form);
      } else {
        await api.post('/contacts', form);
      }
      onSave();
    } catch (e) {
      setError(e.error || 'Ошибка сохранения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">{form.id ? 'Редактировать' : 'Добавить контакт'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          {error && <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Instagram Username *</label>
            <input className="input" placeholder="username" value={form.username}
              onChange={e => setForm(f => ({ ...f, username: e.target.value.replace('@', '') }))} />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Полное имя</label>
            <input className="input" placeholder="Иван Иванов" value={form.full_name || ''}
              onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Email</label>
              <input className="input" placeholder="email@example.com" value={form.email || ''}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Телефон</label>
              <input className="input" placeholder="+7 999..." value={form.phone || ''}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Компания</label>
              <input className="input" placeholder="ООО Пример" value={form.company || ''}
                onChange={e => setForm(f => ({ ...f, company: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Качество лида</label>
              <select className="input" value={form.lead_quality || 'warm'}
                onChange={e => setForm(f => ({ ...f, lead_quality: e.target.value }))}>
                {QUALITY_OPTIONS.map(q => (
                  <option key={q} value={q}>{q.charAt(0).toUpperCase() + q.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Заметки</label>
            <textarea className="input resize-none" rows={2} placeholder="Заметки о контакте..." value={form.notes || ''}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t border-gray-100">
          <button onClick={onClose} className="btn-secondary flex-1">Отмена</button>
          <button onClick={handleSave} disabled={loading} className="btn-primary flex-1">
            {loading ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Enrichment runs inside the extension's heartbeat, so this modal's real job is
// to make an unattended background run legible: what is left, what it will cost
// in time, whether the extension is even the thing that has to be on.
function EnrichProgressModal({ jobId, onClose, onChanged }) {
  const [job, setJob] = useState(null);
  const [results, setResults] = useState([]);
  const [tab, setTab] = useState('progress');
  const [extensionOnline, setExtensionOnline] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get(`/contact-enrich/jobs/${jobId}`);
      setJob(res.job);
      setResults(res.results || []);
    } catch (e) { /* job may have been deleted under us */ }
  }, [jobId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // Enrichment only runs inside the extension's heartbeat, so "is the browser
  // even asking for work?" is the first thing to rule out when nothing moves.
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const res = await api.get('/extension/heartbeat');
        if (!stopped) setExtensionOnline(res?.connected === true);
      } catch (e) {
        if (!stopped) setExtensionOnline(null);
      }
    };
    check();
    const t = setInterval(check, 15000);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  const act = async (action) => {
    try {
      await api.post(`/contact-enrich/jobs/${jobId}/${action}`);
      await refresh();
      onChanged();
    } catch (e) {
      alert(e?.error || 'Не удалось');
    }
  };

  const running = job && ['pending', 'running'].includes(job.status);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-3xl w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">ИИ-обогащение контактов</h2>
            <p className="text-xs text-gray-500 mt-1">
              Работает в фоне и уступает кампании рассылки автоматически. Расширение может закрыться — задача продолжится сама.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <EnrichPipeline />

        {!job ? (
          <div className="text-sm text-gray-500">Загрузка…</div>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-3">
              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-orange-500 transition-all" style={{ width: `${job.percent}%` }} />
              </div>
              <span className="text-sm font-semibold text-gray-700 w-12 text-right">{job.percent}%</span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4 text-center">
              {[
                { label: 'Готово', value: job.summarized, cls: 'text-green-600' },
                { label: 'Осталось', value: job.pending, cls: 'text-blue-600' },
                { label: 'Без данных', value: job.failed, cls: 'text-gray-500' },
                { label: 'Всего', value: job.total ?? job.total_count, cls: 'text-gray-900' },
              ].map(s => (
                <div key={s.label} className="rounded-xl border border-gray-200 py-2">
                  <div className={`text-xl font-bold ${s.cls}`}>{s.value ?? 0}</div>
                  <div className="text-[11px] text-gray-500">{s.label}</div>
                </div>
              ))}
            </div>

            {extensionOnline === false && running && (
              <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 flex items-start gap-2">
                <CircleAlert size={16} className="mt-0.5 flex-shrink-0" />
                <span>
                  Расширение не на связи — читать профили некому, поэтому задача стоит.
                  Откройте Chrome с расширением Instalead и нажмите его иконку.
                </span>
              </div>
            )}

            {job.stalled_reason && (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2">
                <CircleAlert size={16} className="mt-0.5 flex-shrink-0" />
                <span>{job.stalled_reason}</span>
              </div>
            )}

            {job.error_message && (
              <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900 flex items-start gap-2">
                <CircleAlert size={16} className="mt-0.5 flex-shrink-0" />
                <span>{job.error_message}</span>
              </div>
            )}

            {job.status === 'paused' && (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2">
                <CircleAlert size={16} className="mt-0.5 flex-shrink-0" />
                <span>{job.error_message || 'На паузе'}</span>
              </div>
            )}
            {job.status === 'completed' && (
              <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-900">
                Готово. {job.summarized} конспектов записаны — их видно в колонке «Конспект».
              </div>
            )}

            <div className="flex items-center gap-2 mb-4">
              {running && (
                <button onClick={() => act('pause')} className="btn-secondary text-sm flex items-center gap-1.5">
                  <Pause size={14} /> Пауза
                </button>
              )}
              {job.status === 'paused' && (
                <button onClick={() => act('resume')} className="btn-primary text-sm flex items-center gap-1.5">
                  <Play size={14} /> Продолжить
                </button>
              )}
              {['pending', 'running', 'paused'].includes(job.status) && (
                <button onClick={() => act('cancel')} className="text-sm text-red-600 hover:text-red-700 ml-auto">Остановить</button>
              )}
            </div>

            <div className="flex gap-1 border-b border-gray-200 mb-3">
              {[['progress', 'Прогресс'], ['notes', 'Конспекты'], ['log', 'Журнал']].map(([key, label]) => (
                <button key={key} onClick={() => setTab(key)}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === key ? 'border-orange-500 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}>
                  {label}
                </button>
              ))}
            </div>

            {tab === 'log' ? (
              <div className="space-y-1 max-h-[45vh] overflow-y-auto">
                <p className="text-xs text-gray-500 mb-2">
                  Что происходит с каждым контактом. Полный лог сервера: <code>journalctl -u instalead-backend -f</code>
                </p>
                {results.length === 0 && (
                  <div className="text-sm text-gray-400 py-4 text-center">Задача ещё не получила ни одного контакта</div>
                )}
                {results.map(r => {
                  const state = r.error ? 'error' : r.summary ? 'ok' : r.scraped ? 'wait' : 'idle';
                  const label = {
                    ok: 'Конспект готов',
                    error: r.error,
                    wait: 'Профиль прочитан, ждёт ИИ',
                    idle: 'В очереди — расширение ещё не прочитало профиль',
                  }[state];
                  return (
                    <div key={r.username}
                      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                        state === 'error' ? 'border-gray-200 bg-gray-50 text-gray-600'
                        : state === 'ok' ? 'border-green-200 bg-green-50 text-green-900'
                        : state === 'wait' ? 'border-amber-200 bg-amber-50 text-amber-900'
                        : 'border-blue-200 bg-blue-50 text-blue-900'}`}>
                      <span className="font-medium shrink-0">@{r.username}</span>
                      <span className="break-words">{label}</span>
                    </div>
                  );
                })}
              </div>
            ) : tab === 'notes' ? (
              <div className="space-y-2">
                {results.filter(r => r.summary).length === 0 && (
                  <div className="text-sm text-gray-400 py-4 text-center">Пока нет готовых конспектов</div>
                )}
                {results.filter(r => r.summary).map(r => (
                  <div key={r.username} className="border border-gray-200 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-900">@{r.username}</span>
                      <span className="text-[11px] text-gray-400">{r.full_name || ''}</span>
                    </div>
                    <div className="text-sm text-gray-700">{r.summary}</div>

                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-gray-600 space-y-2">
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: 'Прочитано', value: job.scraped, cls: 'text-gray-900' },
                    { label: 'Конспектов', value: job.summarized, cls: 'text-green-600' },
                    { label: 'Очередь', value: job.pending, cls: 'text-blue-600' },
                  ].map(s => (
                    <div key={s.label} className="rounded-xl border border-gray-200 py-2">
                      <div className={`text-lg font-bold ${s.cls}`}>{s.value ?? 0}</div>
                      <div className="text-[11px] text-gray-500">{s.label}</div>
                    </div>
                  ))}
                </div>
                <p>Оценка времени: ~{job.estimated_minutes} мин, пока расширение на связи и аккаунт не упёрся в ограничения Instagram.</p>
                <p>Блок работы: {job.run_minutes ? `${job.run_minutes} мин` : 'без ограничения'}, дальше задача встаёт на паузу и ждёт «Продолжить».</p>
                <p className="text-gray-500">Приватные профили без открытого био попадут в «Без данных» — для них конспект невозможен, и ИИ здесь ни при чём.</p>
                <p className="text-gray-500">Если «Прочитано» растёт, а «Конспектов» нет — смотрите красное сообщение выше: это проблема ключа или модели, а не Instagram.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function Contacts() {
  const [contacts, setContacts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [qualityFilter, setQualityFilter] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [showAdd, setShowAdd] = useState(false);
  const [editContact, setEditContact] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [visibleCols, setVisibleCols] = useState(() => ALL_COLUMNS.filter(c => c.default).map(c => c.key));
  const [selected, setSelected] = useState(new Set());
  const [enrichJobId, setEnrichJobId] = useState(null);
  const [viewSummary, setViewSummary] = useState(null);
  const [enrichStatusFilter, setEnrichStatusFilter] = useState('');
  const [activeJob, setActiveJob] = useState(null);
  const [readinessError, setReadinessError] = useState(null);

  const readiness = useEnrichReadiness(!!activeJob);
  // Only a missing AI key is a hard stop. An offline extension is not: the job
  // waits for it and resumes on its own, and refusing to start in that state
  // would make "queue it overnight, open Chrome in the morning" impossible —
  // which is exactly how this feature is meant to be used.
  const enrichBlocked = readiness ? readiness.blockers.some(b => b.code === 'no_ai_key') : false;

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit });
      if (search) params.set('search', search);
      if (qualityFilter) params.set('lead_quality', qualityFilter);
      if (enrichStatusFilter) params.set('enrich_status', enrichStatusFilter);
      const res = await api.get(`/contacts?${params}`);
      setContacts(res.contacts || []);
      setTotal(res.total || 0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // An unfinished job from a previous session is still running server-side, so
  // the button has to know about it before it offers to start another.
  const loadActiveJob = useCallback(async () => {
    try {
      const res = await api.get('/contact-enrich/jobs');
      setActiveJob(res.active || null);
    } catch (e) { /* endpoint unavailable on an older backend */ }
  }, []);

  useEffect(() => { load(); }, [page, qualityFilter, limit, enrichStatusFilter]);
  useEffect(() => { loadActiveJob(); }, [loadActiveJob]);
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); load(); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  // Exports whatever the current filters show, so the file matches the view.
  // Direct fetch rather than the axios instance: we need the raw blob plus the
  // workspace header, and the response interceptor unwraps to .data.
  const handleExport = async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (qualityFilter) params.set('lead_quality', qualityFilter);
      const qs = params.toString();
      const res = await fetch(`/api/contacts/export.csv${qs ? '?' + qs : ''}`, {
        headers: { 'X-Workspace': getCurrentWorkspace() },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Не удалось скачать CSV: ' + e.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Удалить контакт?')) return;
    await api.delete(`/contacts/${id}`);
    load();
  };

  const handleDeleteSelected = async () => {
    if (!selected.size || !confirm(`Удалить ${selected.size} контакт(ов)?`)) return;
    try {
      await api.post('/contacts/bulk-delete', { ids: [...selected] });
      setSelected(new Set());
      load();
    } catch (e) {
      console.error(e);
    }
  };

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === contacts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(contacts.map(c => c.id)));
    }
  };

  const handleDealWon = async (id) => {
    await api.post(`/contacts/${id}/deal-won`);
    load();
  };

  // The server refuses to start a run it knows cannot succeed, and says why in
  // a shape the notice can render. Falling back to alert() loses that: the
  // user sees a sentence with no way to act on it, which is the state this
  // whole preflight exists to remove.
  const explainFailure = (e, fallback) => {
    const blockers = Array.isArray(e?.blockers) ? e.blockers : [];
    if (blockers.length) {
      setReadinessError(blockers.map(b => `${b.title}. ${b.message}`).join(' '));
      return;
    }
    setReadinessError(e?.error || fallback);
  };

  const handleEnrichSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setReadinessError(null);
    try {
      const res = await api.post('/contact-enrich/jobs', { contact_ids: ids, run_minutes: 60 });
      setEnrichJobId(res.job.id);
      setActiveJob(res.job);
      if (res.warnings?.length) setReadinessError(res.warnings.join(' '));
    } catch (e) {
      if (e?.job_id) {
        setEnrichJobId(e.job_id);
        return;
      }
      explainFailure(e, 'Не удалось запустить обогащение');
    }
  };

  const handleEnrichOne = async (id) => {
    setReadinessError(null);
    try {
      const res = await api.post(`/contacts/${id}/enrich-now`);
      setEnrichJobId(res.job.id);
      // The single-contact path did not refresh the active-job banner, so a
      // run started from a row looked like nothing had started at all.
      setActiveJob(res.job);
      if (res.warnings?.length) setReadinessError(res.warnings.join(' '));
    } catch (e) {
      if (e?.job_id) { setEnrichJobId(e.job_id); return; }
      explainFailure(e, 'Не удалось запустить обогащение');
    }
  };

  const toggleCol = (key) => {
    setVisibleCols(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const totalPages = Math.ceil(total / limit);

  const renderCell = (contact, colKey) => {
    switch (colKey) {
      case 'username':
        return (
          <a href={`https://instagram.com/${contact.username}`} target="_blank" rel="noopener noreferrer"
            className="text-orange-600 hover:text-orange-500 font-medium">@{contact.username}</a>
        );
      case 'full_name':
        return <span className="text-gray-800">{contact.full_name || '—'}</span>;
      case 'enrich_status': {
        // Three states, three affordances: a finished note opens for review, an
        // untouched or failed one offers to run it for this contact alone, and
        // a queued one is already someone's job — clicking it would only 409.
        // A stale note gets both: it can be read and re-read.
        const rerun = (
          <button onClick={() => handleEnrichOne(contact.id)}
            className="text-gray-400 hover:text-orange-600 transition-colors"
            title={contact.note_stale ? 'Перезаписать конспект по актуальному формату' : 'Прочитать этот профиль и составить конспект'}>
            <Sparkles size={13} />
          </button>
        );

        if (contact.enrich_status === 'done') {
          return (
            <span className="inline-flex items-center gap-1.5">
              <button onClick={() => setViewSummary(contact)} className="hover:opacity-70"
                title={contact.profile_summary || 'Открыть конспект'}>
                <EnrichBadge contact={contact} />
              </button>
              {contact.note_stale && rerun}
            </span>
          );
        }
        if (['none', 'failed'].includes(contact.enrich_status)) {
          return (
            <span className="inline-flex items-center gap-1.5">
              <EnrichBadge contact={contact} />
              {rerun}
            </span>
          );
        }
        return <EnrichBadge contact={contact} />;
      }
      case 'profile_summary':
        return contact.profile_summary
          ? <span className="text-gray-600 text-xs max-w-64 line-clamp-2 block" title={contact.profile_summary}>{contact.profile_summary}</span>
          : <span className="text-gray-400 text-xs">—</span>;
      case 'outreach':
        return <OutreachBadge status={contact.outreach_status} at={contact.outreach_at} />;
      case 'email':
        return <span className="text-gray-600 text-xs">{contact.email || '—'}</span>;
      case 'phone':
        return <span className="text-gray-600 text-xs">{contact.phone || '—'}</span>;
      case 'pipeline_name':
        return <span className="text-gray-600 text-xs">{contact.pipeline_name || '—'}</span>;
      case 'stage_name':
        return contact.stage_name ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: contact.stage_color || '#6b7280' }} />
            {contact.stage_name}
          </span>
        ) : <span className="text-gray-400 text-xs">—</span>;
      case 'lead_quality':
        return <QualityBadge quality={contact.lead_quality} />;
      case 'deal':
        return contact.deal_won ? (
          <span className="inline-flex items-center gap-1 text-yellow-600">
            <Trophy size={13} /><span className="text-xs font-medium">Won</span>
          </span>
        ) : (
          <button onClick={() => handleDealWon(contact.id)} className="text-xs text-gray-400 hover:text-yellow-600 transition-colors">
            Mark won
          </button>
        );
      case 'company':
        return <span className="text-gray-600 text-xs">{contact.company || '—'}</span>;
      case 'created_at':
        return <span className="text-gray-400 text-xs">{contact.created_at ? new Date(contact.created_at).toLocaleDateString('ru') : '—'}</span>;
      case 'notes':
        return <span className="text-gray-400 text-xs max-w-32 truncate block">{contact.notes || '—'}</span>;
      default:
        return '—';
    }
  };

  return (
    <div className="p-6 space-y-4">
      {showImport && (
        <ImportModal onClose={() => setShowImport(false)} onImported={load} />
      )}
      {(showAdd || editContact) && (
        <ContactModal
          contact={editContact}
          onClose={() => { setShowAdd(false); setEditContact(null); }}
          onSave={() => { setShowAdd(false); setEditContact(null); load(); }}
        />
      )}
      {enrichJobId && (
        <EnrichProgressModal
          jobId={enrichJobId}
          onClose={() => { setEnrichJobId(null); loadActiveJob(); }}
          onChanged={load}
        />
      )}
      {viewSummary && (
        <SummaryModal contact={viewSummary} onClose={(reload) => { setViewSummary(null); if (reload) load(); }} />
      )}

      {activeJob && (
        <button onClick={() => setEnrichJobId(activeJob.id)}
          className="w-full flex items-center gap-2 text-sm bg-blue-50 border border-blue-200 text-blue-800 rounded-xl px-4 py-2 hover:bg-blue-100 transition-colors">
          <Sparkles size={15} className="animate-pulse" />
          Обогащение идёт: {activeJob.summarized} из {activeJob.total ?? activeJob.total_count} готово — открыть прогресс
        </button>
      )}

      <EnrichNotice readiness={readiness} />

      {readinessError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 flex items-start gap-2">
          <CircleAlert size={16} className="mt-0.5 flex-shrink-0" />
          <span className="flex-1">{readinessError}</span>
          <button onClick={() => setReadinessError(null)} className="text-rose-400 hover:text-rose-700">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Контакты</h1>
          <p className="text-gray-500 text-sm mt-1">{total} контактов</p>
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <button onClick={handleEnrichSelected} disabled={enrichBlocked}
                className="btn-primary flex items-center gap-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                title={enrichBlocked
                  ? 'Сначала добавьте API-ключ ИИ в «Интеграции» — без него конспект составить некому'
                  : 'Расширение прочитает профили выбранных контактов, ИИ составит конспект и три крючка для персонализации'}>
                <Sparkles size={14} /> ИИ-обогатить ({selected.size})
              </button>
              <button onClick={handleDeleteSelected} className="bg-red-500 hover:bg-red-600 text-white text-sm px-3 py-2 rounded-lg flex items-center gap-1.5 transition-colors">
                <Trash2 size={14} /> Удалить ({selected.size})
              </button>
            </>
          )}
          <button onClick={handleExport} disabled={total === 0} className="btn-secondary flex items-center gap-1.5 text-sm disabled:opacity-40"
            title="Скачать контакты в CSV — файл можно загрузить обратно без настройки колонок">
            <Download size={14} /> Экспорт
          </button>
          <button onClick={() => setShowImport(true)} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Upload size={14} /> Импорт
          </button>
          <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={15} /> Добавить
          </button>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
          <input className="input pl-9 text-sm" placeholder="Поиск по username, имени, email..." value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input text-sm w-40" value={qualityFilter} onChange={e => { setQualityFilter(e.target.value); setPage(1); }}>
          <option value="">Все качества</option>
          {QUALITY_OPTIONS.map(q => (
            <option key={q} value={q}>{q.charAt(0).toUpperCase() + q.slice(1)}</option>
          ))}
        </select>
        <select className="input text-sm w-40" value={enrichStatusFilter} onChange={e => { setEnrichStatusFilter(e.target.value); setPage(1); }}>
          <option value="">Все конспекты</option>
          <option value="done">Есть конспект</option>
          <option value="none">Без конспекта</option>
          <option value="failed">Нет данных в профиле</option>
        </select>
        <div className="relative">
          <button onClick={() => setShowColumns(!showColumns)} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Columns size={14} /> Столбцы
          </button>
          {showColumns && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg p-3 z-20 w-48">
              {ALL_COLUMNS.map(col => (
                <label key={col.key} className="flex items-center gap-2 py-1.5 cursor-pointer text-sm text-gray-700 hover:text-gray-900">
                  <input type="checkbox" checked={visibleCols.includes(col.key)} onChange={() => toggleCol(col.key)}
                    className="accent-orange-500" />
                  {col.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr className="text-left text-gray-500 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 w-8">
                  <input type="checkbox" checked={contacts.length > 0 && selected.size === contacts.length}
                    onChange={toggleSelectAll} className="accent-orange-500 cursor-pointer" />
                </th>
                {visibleCols.map(key => (
                  <th key={key} className="px-4 py-3 font-medium">{ALL_COLUMNS.find(c => c.key === key)?.label}</th>
                ))}
                <th className="px-4 py-3 w-24 font-medium">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={visibleCols.length + 2} className="text-center py-12 text-gray-400">Загрузка...</td></tr>
              ) : contacts.length === 0 ? (
                <tr><td colSpan={visibleCols.length + 2} className="text-center py-12 text-gray-400">
                  {search || qualityFilter ? 'Ничего не найдено' : 'Нет контактов. Добавьте первый!'}
                </td></tr>
              ) : contacts.map(contact => (
                <tr key={contact.id} className={`hover:bg-gray-50 transition-colors ${selected.has(contact.id) ? 'bg-orange-50/50' : ''}`}>
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(contact.id)} onChange={() => toggleSelect(contact.id)}
                      className="accent-orange-500 cursor-pointer" />
                  </td>
                  {visibleCols.map(key => (
                    <td key={key} className="px-4 py-3">{renderCell(contact, key)}</td>
                  ))}
                  <td className="px-4 py-3">
                    <div className="flex gap-1 justify-end">
                      <a href={`https://instagram.com/direct/t/${contact.username}`} target="_blank" rel="noopener noreferrer"
                        className="p-1.5 text-gray-400 hover:text-orange-500 rounded-md hover:bg-orange-50 transition-colors" title="DM">
                        <MessageSquare size={13} />
                      </a>
                      <button onClick={() => setEditContact(contact)} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100" title="Редактировать">
                        <Edit2 size={13} />
                      </button>
                      <button onClick={() => handleDelete(contact.id)} className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-red-50 transition-colors" title="Удалить">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">Показывать:</span>
            <select className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-white text-gray-600"
              value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <span className="text-xs text-gray-400">из {total}</span>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Стр. {page} из {totalPages}</span>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-40">
                <ChevronLeft size={14} />
              </button>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-40">
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
