import React, { useEffect, useState } from 'react';
import { Plus, Instagram, ExternalLink, Trash2, RefreshCw, ShieldCheck, Wifi, WifiOff, AlertCircle, X, Save, Globe2 } from 'lucide-react';
import api from '../utils/api.js';

const desktop = () => window.instaleadDesktop?.isDesktop;
const emptyForm = { name: '', username: '', proxy: { enabled: false, type: 'http', host: '', port: '8080', authUser: '', authPassword: '' } };

function ProfileModal({ initial, onClose, onSave }) {
  const [form, setForm] = useState(initial || emptyForm);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [saving, setSaving] = useState(false);
  const setProxy = patch => setForm(f => ({ ...f, proxy: { ...f.proxy, ...patch } }));
  const submit = async e => { e.preventDefault(); setSaving(true); try { await onSave(form); onClose(); } catch (err) { alert(err.message || 'Не удалось сохранить профиль'); } finally { setSaving(false); } };
  const testProxy = async () => {
    setTesting(true); setTest(null);
    try { const result = await window.instaleadDesktop.profiles.testProxy(form.proxy); setTest(result); }
    catch (e) { setTest({ ok: false, error: e.message }); }
    finally { setTesting(false); }
  };
  return <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <form onSubmit={submit} className="card w-full max-w-xl max-h-[90vh] overflow-y-auto !p-6">
      <div className="flex items-center justify-between mb-5"><div><h2 className="text-xl font-bold text-gray-900 dark:text-white">{initial ? 'Настройки профиля' : 'Новый профиль'}</h2><p className="text-xs text-gray-500 mt-1">Отдельная браузерная сессия и сетевые настройки</p></div><button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"><X size={18}/></button></div>
      <div className="space-y-4">
        <label className="block"><span className="text-xs font-semibold text-gray-500">Название профиля *</span><input required maxLength={60} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Клиент 01 — Instagram" className="mt-1 w-full input" /></label>
        <label className="block"><span className="text-xs font-semibold text-gray-500">Instagram username (необязательно)</span><input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="username" className="mt-1 w-full input" /></label>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
          <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Globe2 size={17}/><span className="font-semibold text-sm text-gray-900 dark:text-white">Индивидуальный прокси</span></div><input type="checkbox" checked={!!form.proxy.enabled} onChange={e => setProxy({ enabled: e.target.checked })} /></div>
          {form.proxy.enabled && <>
            <div className="grid grid-cols-3 gap-2"><label className="block col-span-1"><span className="text-xs text-gray-500">Тип</span><select value={form.proxy.type} onChange={e => setProxy({ type: e.target.value })} className="mt-1 w-full input"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></select></label><label className="block col-span-2"><span className="text-xs text-gray-500">Host / IP</span><input required value={form.proxy.host} onChange={e => setProxy({ host: e.target.value })} placeholder="proxy.example.com" className="mt-1 w-full input" /></label></div>
            <div className="grid grid-cols-2 gap-2"><label className="block"><span className="text-xs text-gray-500">Port</span><input required type="number" min="1" max="65535" value={form.proxy.port} onChange={e => setProxy({ port: e.target.value })} className="mt-1 w-full input" /></label><label className="block"><span className="text-xs text-gray-500">Логин прокси</span><input value={form.proxy.authUser} onChange={e => setProxy({ authUser: e.target.value })} placeholder="Необязательно" className="mt-1 w-full input" /></label></div>
            <label className="block"><span className="text-xs text-gray-500">Пароль прокси</span><input type="password" value={form.proxy.authPassword || ''} onChange={e => setProxy({ authPassword: e.target.value })} placeholder={initial ? 'Оставьте пустым, чтобы не менять' : 'Необязательно'} className="mt-1 w-full input" /></label>
            <button type="button" onClick={testProxy} disabled={testing || !form.proxy.host || !form.proxy.port} className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-50"><RefreshCw size={14} className={testing ? 'animate-spin' : ''}/>{testing ? 'Проверка…' : 'Проверить соединение'}</button>
            {test && <div className={`text-xs rounded-lg p-2 ${test.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{test.ok ? `Соединение установлено (HTTP ${test.status})` : `Не удалось подключиться: ${test.error || `HTTP ${test.status}`}`}</div>}
          </>}
          {!form.proxy.enabled && <p className="text-xs text-gray-500">Профиль будет использовать обычное сетевое подключение компьютера.</p>}
        </div>
        <div className="text-xs text-gray-500 flex gap-2"><ShieldCheck size={15} className="shrink-0"/> Пароль прокси сохраняется в локальном защищённом хранилище ОС. Instagram-пароль Instalead не запрашивает.</div>
      </div>
      <div className="flex justify-end gap-2 mt-6"><button type="button" onClick={onClose} className="btn-secondary">Отмена</button><button disabled={saving} className="btn-primary flex items-center gap-2"><Save size={15}/>{saving ? 'Сохранение…' : 'Сохранить профиль'}</button></div>
    </form>
  </div>;
}

export default function Accounts() {
  const [profiles, setProfiles] = useState([]);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [modal, setModal] = useState(null);
  const [account, setAccount] = useState(null);
  const [warmup, setWarmup] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [pairCode, setPairCode] = useState(null);
  const [pairLoading, setPairLoading] = useState(false);
  const load = async () => {
    if (desktop()) { try { setProfiles(await window.instaleadDesktop.profiles.list()); } catch (e) { console.error(e); } }
    api.get('/extension/account').then(d => setAccount(d.username)).catch(() => {});
    api.get('/accounts/warmup').then(setWarmup).catch(() => {});
    setLoadingProfiles(false);
  };
  useEffect(() => { load(); }, []);
  const saveProfile = async form => {
    const payload = { ...form, proxy: { ...form.proxy, port: Number(form.proxy.port) } };
    if (form.id) await window.instaleadDesktop.profiles.update(payload);
    else await window.instaleadDesktop.profiles.create(payload);
    await load();
  };
  const openProfile = async (p, target = 'instagram') => { const key = `${p.id}:${target}`; setBusyId(key); try { await window.instaleadDesktop.profiles.open(p.id, target); } catch (e) { alert(e.message); } finally { setBusyId(null); } };
  const deleteProfile = async p => { if (!confirm(`Удалить профиль «${p.name}» и его локальную браузерную сессию?`)) return; await window.instaleadDesktop.profiles.remove(p.id); await load(); };
  const generatePairCode = async () => { setPairLoading(true); try { setPairCode(await api.post('/extension/pair/code')); } catch (e) { alert(e.message); } finally { setPairLoading(false); } };
  return <div className="p-8 max-w-5xl mx-auto">
    <div className="flex items-start justify-between gap-4 mb-6"><div><h1 className="text-2xl font-bold text-gray-900 dark:text-white">Accounts</h1><p className="text-sm text-gray-500 mt-1">Управление локальными браузерными профилями, Instagram и проверкой fingerprint.</p></div>{desktop() && <button onClick={() => setModal({})} className="btn-primary flex items-center gap-2"><Plus size={16}/> Добавить профиль</button>}</div>
    {desktop() && <section className="card mb-6"><div className="flex items-center justify-between mb-4"><div><h2 className="font-semibold text-gray-900 dark:text-white">Browser Profiles</h2><p className="text-xs text-gray-500 mt-1">Каждый профиль открывается в отдельном окне с собственной постоянной сессией Chromium.</p></div><span className="text-xs text-gray-500">{profiles.length} профилей</span></div>
      {loadingProfiles ? <p className="text-sm text-gray-500">Загрузка…</p> : profiles.length === 0 ? <div className="text-center py-10 border border-dashed border-gray-300 dark:border-gray-700 rounded-xl"><Instagram size={34} className="mx-auto text-gray-400 mb-3"/><p className="font-medium text-gray-800 dark:text-gray-200">Профилей пока нет</p><p className="text-xs text-gray-500 mt-1">Создай профиль, настрой прокси и открой Instagram для ручной авторизации.</p><button onClick={() => setModal({})} className="btn-primary mt-4"><Plus size={15} className="inline mr-1"/> Создать первый профиль</button></div> : <div className="space-y-3">{profiles.map(p => <div key={p.id} className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 flex flex-wrap items-center gap-3"><div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-400 to-pink-500 flex items-center justify-center text-white"><Instagram size={20}/></div><div className="flex-1 min-w-[180px]"><div className="font-semibold text-sm text-gray-900 dark:text-white">{p.name}</div><div className="text-xs text-gray-500 mt-1">{p.username ? `@${p.username} · ` : ''}{p.proxy?.enabled ? `${p.proxy.type.toUpperCase()} · ${p.proxy.host}:${p.proxy.port}` : 'Без прокси'}</div></div><span className="text-[11px] text-gray-500 flex items-center gap-1"><Wifi size={13}/> Локальный профиль</span><div className="flex gap-2"><button onClick={() => openProfile(p, 'instagram')} disabled={busyId === `${p.id}:instagram`} className="btn-primary text-xs flex items-center gap-1"><ExternalLink size={13}/>{busyId === `${p.id}:instagram` ? 'Открытие…' : 'Instagram'}</button><button onClick={() => openProfile(p, 'fingerprint')} disabled={busyId === `${p.id}:fingerprint`} className="btn-secondary text-xs flex items-center gap-1"><Globe2 size={13}/>{busyId === `${p.id}:fingerprint` ? 'Открытие…' : 'Fingerprint Test'}</button><button onClick={() => setModal({ ...p, proxy: { enabled: !!p.proxy?.enabled, type: p.proxy?.type || 'http', host: p.proxy?.host || '', port: p.proxy?.port || '8080', authUser: '', authPassword: '' } })} className="btn-secondary text-xs">Настройки</button><button onClick={() => deleteProfile(p)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg" title="Удалить"><Trash2 size={15}/></button></div></div>)}</div>}
    </section>}
    <section className="card"><div className="flex items-center justify-between mb-4"><div><h2 className="font-semibold text-gray-900 dark:text-white">Chrome Extension</h2><p className="text-xs text-gray-500 mt-1">Существующее подключение расширения сохраняется отдельно.</p></div><span className="text-xs text-gray-500">Legacy integration</span></div>
      <div className="rounded-xl border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900 p-4"><div className="flex items-center justify-between gap-3"><div><div className="text-sm font-semibold text-blue-900 dark:text-blue-200">Pair Chrome extension</div><div className="text-xs text-blue-700 dark:text-blue-300 mt-1">Сгенерируй одноразовый код и введи его в расширении.</div></div><button onClick={generatePairCode} disabled={pairLoading} className="btn-secondary text-sm">{pairLoading ? 'Создание…' : 'Получить код'}</button></div>{pairCode && <div className="mt-3 bg-white dark:bg-gray-900 rounded-lg border p-3 flex justify-between items-center"><div><div className="text-[10px] text-gray-500">Код действует 10 минут</div><div className="font-mono text-2xl tracking-widest">{pairCode.code}</div></div><button onClick={() => navigator.clipboard?.writeText(pairCode.code)} className="text-xs text-blue-600">Копировать</button></div>}</div>
      <div className="mt-4 flex items-center gap-3"><div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center"><Instagram size={19}/></div><div className="flex-1"><div className="text-sm font-semibold text-gray-900 dark:text-white">{account ? `@${account}` : 'Расширение не подключено'}</div><div className="text-xs text-gray-500">{account ? 'Аккаунт, подключённый через Chrome Extension' : 'Можно продолжать использовать существующий сценарий подключения.'}</div></div>{account ? <span className="text-xs text-green-600 flex items-center gap-1"><Wifi size={13}/> Подключён</span> : <span className="text-xs text-gray-400 flex items-center gap-1"><WifiOff size={13}/> Offline</span>}</div>
    </section>
    <div className="mt-4 text-xs text-gray-500 flex gap-2"><AlertCircle size={14} className="shrink-0"/>Профили предназначены для раздельного ручного входа и управления аккаунтами. Сохранение сессии зависит от настроек Instagram; прокси не гарантирует отсутствие проверок или ограничений платформы.</div>
    {modal && <ProfileModal initial={modal.id ? modal : null} onClose={() => setModal(null)} onSave={saveProfile}/>}
  </div>;
}
