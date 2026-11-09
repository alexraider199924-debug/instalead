import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Briefcase, Check, CircleAlert, Pencil, Target, Sparkles, Shield } from 'lucide-react';
import api from '../utils/api.js';

// The field list is NOT defined here. The backend owns it (services/offerContext.js)
// and hands it over in the GET response, so a field added to the manifest shows up
// in this wizard automatically and — more importantly — cannot be collected in the
// UI while staying invisible to the prompt builder. That drift is what left
// voice_tone readable by the engine with no input anywhere.

const SECTION_ICONS = { business: Briefcase, offer: Sparkles, voice: Bot, personalization: Target, guardrails: Shield, review: Shield };

function CharCounter({ value, max }) {
  const len = (value || '').length;
  if (!max) return null;
  return (
    <div className={`text-xs text-right mt-1 ${len >= max ? 'text-red-500' : 'text-gray-400'}`}>
      {len}/{max}
    </div>
  );
}

function Field({ field, value, onChange, invalid }) {
  const id = `agent-${field.key}`;

  if (field.type === 'select') {
    return (
      <div className="card">
        <label htmlFor={id} className="text-sm font-medium text-gray-700 mb-3 block">{field.label}</label>
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(field.options.length, 2)}, minmax(0, 1fr))` }}>
          {field.options.map(opt => {
            const active = value === opt.value;
            return (
              <button key={opt.value} type="button" onClick={() => onChange(field.key, opt.value)}
                className={`p-3 rounded-xl border-2 text-left transition-all ${
                  active ? 'border-orange-500 bg-orange-50' : 'border-gray-200 hover:border-gray-300'
                }`}>
                <div className="text-sm font-semibold text-gray-900">{opt.label}</div>
                {opt.desc && <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>}
              </button>
            );
          })}
        </div>
        {field.hint && <p className="text-xs text-gray-500 mt-2">{field.hint}</p>}
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div className="card">
        <label htmlFor={id} className="text-sm font-medium text-gray-700 mb-2 block">{field.label}</label>
        <input id={id} type="number" className="input text-sm" min={field.min} max={field.max} step={field.step}
          value={value ?? field.default ?? ''}
          onChange={e => onChange(field.key, e.target.value)} />
        {field.hint && <p className="text-xs text-gray-500 mt-2">{field.hint}</p>}
      </div>
    );
  }

  const maxLength = field.maxLength;
  const shown = field.maxLength ? String(value || '').slice(0, field.maxLength) : (value || '');

  return (
    <div className="card">
      <label htmlFor={id} className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
        {field.label}
        {field.required && <span className="text-[10px] text-red-500 font-normal">обязательно</span>}
        {invalid && <span className="text-[10px] text-orange-600 font-normal">не заполнено</span>}
      </label>
      {field.type === 'textarea' ? (
        <textarea id={id} className="input resize-y text-sm min-h-[80px]" value={shown}
          onChange={e => onChange(field.key, maxLength ? e.target.value.slice(0, maxLength) : e.target.value)}
          placeholder={field.placeholder} />
      ) : (
        <input id={id} className="input text-sm" value={shown}
          onChange={e => onChange(field.key, maxLength ? e.target.value.slice(0, maxLength) : e.target.value)}
          placeholder={field.placeholder} />
      )}
      {field.hint && <p className="text-xs text-gray-500 mt-2">{field.hint}</p>}
      <CharCounter value={shown} max={maxLength} />
    </div>
  );
}

function StepIndicator({ steps, current }) {
  return (
    <div className="flex items-center gap-0 mb-8 overflow-x-auto">
      {steps.map((s, i) => (
        <div key={s.id} className={`flex-1 min-w-[150px] flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
          i < current ? 'bg-white border-gray-200' :
          i === current ? 'bg-white border-gray-300 shadow-sm' :
          'bg-gray-50 border-gray-100'
        }`}>
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
            i < current ? 'bg-green-500 text-white' :
            i === current ? 'bg-gray-800 text-white' :
            'bg-gray-200 text-gray-400'
          }`}>
            {i < current ? <Check size={14} /> : i + 1}
          </div>
          <div className="min-w-0">
            <div className="text-[10px] text-gray-400 uppercase tracking-wider">Шаг {i + 1}</div>
            <div className={`text-sm font-medium truncate ${i <= current ? 'text-gray-900' : 'text-gray-400'}`}>{s.title}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SummarySection({ section, data, onEdit }) {
  const Icon = SECTION_ICONS[section.id] || Bot;
  const filled = section.fields.filter(f => String(data[f.key] || '').trim());

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon size={16} className="text-gray-400" />
          <h3 className="text-sm font-semibold text-gray-900">{section.title}</h3>
          <span className="text-xs text-gray-400">{filled.length}/{section.fields.length}</span>
        </div>
        <button onClick={onEdit} className="text-xs text-orange-600 hover:text-orange-700 font-medium flex items-center gap-1">
          <Pencil size={12} /> Редактировать
        </button>
      </div>
      {filled.length ? (
        <div className="space-y-2 text-sm">
          {filled.map(f => (
            <div key={f.key} className="flex gap-3">
              <span className="text-gray-400 w-40 flex-shrink-0">{f.label}</span>
              <span className="text-gray-800 whitespace-pre-wrap break-words">
                {f.type === 'select'
                  ? f.options.find(o => o.value === data[f.key])?.label || data[f.key]
                  : data[f.key]}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-gray-300 italic">Не заполнено</div>
      )}
    </div>
  );
}

export default function AIAgents() {
  const [step, setStep] = useState(0);
  const [data, setData] = useState({});
  const [sections, setSections] = useState([]);
  const [missing, setMissing] = useState([]);
  const [standards, setStandards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [agentVersion, setAgentVersion] = useState(1);

  useEffect(() => {
    api.get('/ai-agents/business-context')
      .then(res => {
        // The payload is flat field->value plus the manifest. Splitting them
        // here keeps `data` saveable as-is: a PUT only writes manifest keys.
        const { sections: manifest, missing_fields, internal_standards, ai_agent_version, ...values } = res;
        setData(values);
        setSections(manifest || []);
        setMissing(missing_fields || []);
        setStandards(internal_standards || []);
        setAgentVersion(ai_agent_version || 1);
      })
      .catch(e => setLoadError(e?.error || 'Не удалось загрузить настройки'))
      .finally(() => setLoading(false));
  }, []);

  const update = (key, value) => setData(prev => ({ ...prev, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const payload = {};
      for (const section of sections) {
        for (const field of section.fields) {
          if (data[field.key] !== undefined) payload[field.key] = data[field.key];
        }
      }
      const res = await api.put('/ai-agents/business-context', payload);
      const { sections: manifest, missing_fields, internal_standards, ai_agent_version, ...values } = res;
      setData(values);
      setSections(manifest || []);
      setMissing(missing_fields || []);
      setStandards(internal_standards || []);
      setAgentVersion(ai_agent_version || 1);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setLoadError(e?.error || 'Не удалось сохранить');
    }
    setSaving(false);
  };

  const isReview = step === sections.length;
  const isSummary = false;
  const current = sections[step];

  // Which required fields are still empty, bucketed by the step that owns them.
  const missingByStep = useMemo(() => {
    const map = new Map();
    for (const key of missing) {
      const owner = sections.find(s => s.fields.some(f => f.key === key));
      if (owner) map.set(owner.id, (map.get(owner.id) || 0) + 1);
    }
    return map;
  }, [missing, sections]);

  if (loading) return <div className="p-6 max-w-4xl mx-auto text-sm text-gray-500">Загрузка…</div>;
  if (loadError && !sections.length) {
    return <div className="p-6 max-w-4xl mx-auto text-sm text-red-600">{loadError}</div>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-3 rounded-xl bg-green-50 text-green-600"><Bot size={24} /></div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">AI Agents</h1>
          <p className="text-gray-500 text-sm">Бизнес, оффер и манера общения — из этих полей собирается каждое сообщение</p>
        </div>
        {missing.length === 0
          ? <span className="badge-green">Готово к работе</span>
          : <span className="badge-yellow">{missing.length} обязательных не заполнено</span>}
      </div>

      {sections.length > 0 && <StepIndicator steps={sections.concat([{ id: 'review', title: 'Проверка' }])} current={step} />}

      {current && !isReview && !isSummary && (
        <div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">
            Шаг {step + 1} из {sections.length + 1}
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-1">{current.title}</h2>
          <p className="text-sm text-gray-500 mb-6">{current.subtitle}</p>

          {current.id === 'business' && (
            <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <div className="font-semibold mb-1">Внутренние стандарты персонализации включены всегда</div>
              <ul className="list-disc pl-5 space-y-0.5 text-blue-800">
                {standards.map(s => <li key={s}>{s}</li>)}
              </ul>
            </div>
          )}

          <div className="space-y-4">
            {current.fields.map(f => (
              <Field key={f.key} field={f} value={data[f.key]} onChange={update}
                invalid={missing.includes(f.key)} />
            ))}
          </div>
        </div>
      )}

      {isReview && (
        <div>
          <h2 className="text-xl font-bold text-gray-900 mb-1">Проверка AI Agent</h2>
          <p className="text-sm text-gray-500 mb-6">Система проверяет, достаточно ли настроек для создания персонализированных сообщений.</p>
          <div className="card space-y-2">
            {[
              ['Компания', 'company_description'], ['Что вы продаёте', 'product_name'], ['Целевая аудитория', 'target_audience'],
              ['Проблема', 'problem_solved'], ['Оффер', 'business_offer'], ['CTA', 'offer_cta'], ['Структура сообщения', 'message_structure'],
              ['How It Works', 'how_it_works'], ['Proof', 'proof'], ['Guarantee', 'guarantee'], ['Tone of Voice', 'voice_tone']
            ].map(([label, key]) => {
              const ok = String(data[key] || '').trim().length > 0 || (key === 'tone' && data[key]);
              return <div key={key} className="flex items-center justify-between text-sm"><span>{label}</span><span className={ok ? 'text-green-600' : 'text-gray-400'}>{ok ? '✓' : 'не заполнено'}</span></div>;
            })}
            <div className={`mt-4 rounded-lg p-3 text-sm ${missing.length ? 'bg-amber-50 text-amber-800' : 'bg-green-50 text-green-800'}`}>
              {missing.length ? `🟡 AI Agent частично настроен. Обязательных полей не заполнено: ${missing.length}.` : '🟢 AI Agent готов к персонализации.'}
            </div>
            <div className="text-xs text-gray-400 mt-2">Версия AI Agent: v{agentVersion}</div>
          </div>
        </div>
      )}

      {isSummary && (
        <div>
          <h2 className="text-xl font-bold text-gray-900 mb-1">Обзор настроек</h2>
          <p className="text-sm text-gray-500 mb-6">
            {missing.length
              ? <>Не хватает: <span className="text-orange-600">{missing.length}</span> обязательных полей — без них сообщения не будут персонализироваться.</>
              : 'Всё готово. Эти данные используются при обогащении контактов и при генерации каждого сообщения.'}
          </p>
          <div className="space-y-4">
            {sections.map((s, i) => (
              <SummarySection key={s.id} section={s} data={data} onEdit={() => setStep(i)} />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mt-6">
        <button onClick={() => step > 0 && setStep(s => s - 1)}
          disabled={step === 0}
          className={`text-sm font-medium ${step > 0 ? 'text-gray-600 hover:text-gray-800' : 'text-gray-300 cursor-default'}`}>
          Назад
        </button>
        <div className="flex items-center gap-3">
          {!isSummary && missingByStep.get(current?.id) > 0 && (
            <span className="flex items-center gap-1 text-xs text-orange-600">
              <CircleAlert size={13} /> не заполнено {missingByStep.get(current.id)} обязательных
            </span>
          )}
          {isReview ? (
            <button onClick={save} disabled={saving}
              className="bg-gray-900 hover:bg-gray-800 text-white font-semibold px-8 py-2.5 rounded-lg transition-colors disabled:opacity-50 text-sm">
              {saving ? 'Сохранение...' : saved ? 'Сохранено!' : 'Сохранить AI Agent'}
            </button>
          ) : (
            <button onClick={() => setStep(s => s + 1)} className="btn-primary px-8">Далее</button>
          )}
        </div>
      </div>

      {saved && (
        <div className="mt-4 text-green-600 text-sm bg-green-50 rounded-lg px-4 py-3 text-center">
          Настройки успешно сохранены!
        </div>
      )}
      {loadError && sections.length > 0 && (
        <div className="mt-4 text-red-600 text-sm bg-red-50 rounded-lg px-4 py-3 text-center">{loadError}</div>
      )}
    </div>
  );
}