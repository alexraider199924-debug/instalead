import React, { useEffect, useState, useRef, useCallback } from 'react';
import { MessageSquare, Search, RefreshCw, Circle, ExternalLink, Send, Inbox as InboxIcon, Loader, AlertCircle, Clock } from 'lucide-react';
import api from '../utils/api.js';

const LABEL_COLORS = {
  needs_reply: '#64748b',
  waiting: '#94a3b8',
  'follow-up': '#475569',
  no_action: '#10b981',
  do_not_contact: '#cbd5e1',
};

const LABEL_NAMES = {
  needs_reply: 'Нужен ответ',
  waiting: 'Ожидание',
  'follow-up': 'Follow-up',
  no_action: 'Без действий',
  do_not_contact: 'Не писать',
};

const FILTER_TABS = [
  { key: '', label: 'Все' },
  { key: 'needs_reply', label: 'Нужен ответ' },
  { key: 'waiting', label: 'Ожидание' },
  { key: 'follow-up', label: 'Follow-up' },
];

// Instagram-style short relative time for the conversation list.
function formatListTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return 'сейчас';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' мин';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч';
  if (diff < 604800000) return Math.floor(diff / 86400000) + ' д';
  if (diff < 2592000000) return Math.floor(diff / 604800000) + ' нед';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

function formatMessageTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

function formatDateSeparator(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export default function Inbox() {
  const [conversations, setConversations] = useState([]);
  const [stats, setStats] = useState({});
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);
  const refreshTimerRef = useRef(null);
  const messagePollerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const params = {};
      if (search) params.search = search;
      if (labelFilter) params.label = labelFilter;
      const [convRes, s] = await Promise.all([
        api.get('/inbox', { params }),
        api.get('/inbox/stats')
      ]);
      const convList = convRes.conversations || (Array.isArray(convRes) ? convRes : []);
      setConversations(convList);
      setStats(s);
      if (activeConv) {
        const updated = convList.find(c => c.id === activeConv.id);
        if (updated) setActiveConv(updated);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, labelFilter, activeConv?.id]);

  useEffect(() => { load(); }, [load]);

  // Polls our own backend only — never Instagram.
  useEffect(() => {
    refreshTimerRef.current = setInterval(load, 15000);
    return () => clearInterval(refreshTimerRef.current);
  }, [load]);

  // Instagram is contacted only here, when the user asks for it.
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncNote('Запрос отправлен расширению...');

    try {
      await api.post('/extension/request-sync');

      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const st = await api.get('/extension/sync-state');
        if (!st.pending) {
          await load();
          if (activeConv) {
            try {
              const msgs = await api.get(`/inbox/${activeConv.id}/messages`);
              setMessages(Array.isArray(msgs) ? msgs : []);
            } catch {}
          }
          // Show what actually happened instead of always saying "Обновлено".
          // A failed or empty sync used to look identical to a successful one.
          if (st.last_error) {
            setSyncNote('⚠️ ' + st.last_error);
            setTimeout(() => setSyncNote(''), 12000);
          } else if (st.last_count === 0) {
            setSyncNote('Диалогов не найдено. Откройте Instagram в этом браузере и войдите в аккаунт.');
            setTimeout(() => setSyncNote(''), 10000);
          } else {
            setSyncNote(st.last_count ? `Обновлено: ${st.last_count} диалог(ов)` : 'Обновлено');
            setTimeout(() => setSyncNote(''), 4000);
          }
          setSyncing(false);
          return;
        }
      }
      setSyncNote('Расширение не ответило. Проверьте, что оно включено и открыта вкладка Instagram.');
    } catch (e) {
      setSyncNote('Не удалось запросить синхронизацию');
    }
    setSyncing(false);
  };

  const selectConversation = async (conv) => {
    setActiveConv(conv);
    if (conv.unread) {
      api.put(`/inbox/${conv.id}`, { unread: false }).catch(() => {});
    }
    try {
      const msgs = await api.get(`/inbox/${conv.id}/messages`);
      setMessages(Array.isArray(msgs) ? msgs : []);
    } catch {
      setMessages([]);
    }
  };

  useEffect(() => {
    if (!activeConv) return;
    messagePollerRef.current = setInterval(async () => {
      try {
        const msgs = await api.get(`/inbox/${activeConv.id}/messages`);
        setMessages(Array.isArray(msgs) ? msgs : []);
      } catch {}
    }, 3000);
    return () => clearInterval(messagePollerRef.current);
  }, [activeConv?.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!messageInput.trim() || !activeConv || sending) return;

    const text = messageInput.trim();
    setSending(true);
    setMessageInput('');

    try {
      await api.post(`/inbox/${activeConv.id}/messages`, {
        text,
        sender: 'me',
        pending_send: true
      });

      const msgs = await api.get(`/inbox/${activeConv.id}/messages`);
      setMessages(Array.isArray(msgs) ? msgs : []);
    } catch (e) {
      console.error('Send error:', e);
      setMessageInput(text);
    } finally {
      setSending(false);
    }
  };

  const updateLabel = async (id, label) => {
    await api.put(`/inbox/${id}`, { label });
    load();
    if (activeConv?.id === id) {
      setActiveConv(prev => ({ ...prev, label }));
    }
  };

  const replyCount = stats.needs_reply || 0;

  return (
    <div className="flex h-full">
      <div className="w-80 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-gray-900">Inbox</h1>
              <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-medium">{conversations.length}</span>
              {replyCount > 0 && (
                <span className="text-xs bg-red-500 text-white px-2 py-0.5 rounded-full font-medium">{replyCount}</span>
              )}
            </div>
            <button onClick={handleSync} disabled={syncing}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
              title="Загрузить из Instagram">
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
            </button>
          </div>

          {syncNote && (
            <div className="mb-3 text-[11px] text-gray-500 bg-gray-50 rounded-lg px-2.5 py-1.5">{syncNote}</div>
          )}

          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input className="w-full bg-gray-100 border-0 rounded-lg pl-9 pr-3 py-2 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:bg-white"
              placeholder="Поиск..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          <div className="flex gap-1">
            {FILTER_TABS.map(tab => (
              <button key={tab.key}
                onClick={() => setLabelFilter(tab.key)}
                className={`text-[11px] px-2 py-1 rounded-md transition-colors ${
                  labelFilter === tab.key
                    ? 'bg-slate-800 text-white font-medium'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}>
                {tab.label}
                {tab.key === 'needs_reply' && replyCount > 0 && (
                  <span className="ml-1 text-[10px]">({replyCount})</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-gray-400 text-sm">Загрузка...</div>
          ) : conversations.length === 0 ? (
            <div className="p-8 text-center">
              <InboxIcon className="mx-auto text-gray-300 mb-2" size={32} />
              <p className="text-sm text-gray-400">
                {labelFilter ? 'Нет чатов с этим фильтром' : 'Нет переписок'}
              </p>
              <p className="text-xs text-gray-300 mt-1">
                Нажмите значок обновления, чтобы загрузить из Instagram
              </p>
            </div>
          ) : (
            conversations.map(c => (
              <div key={c.id} onClick={() => selectConversation(c)}
                className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors border-b border-gray-50 ${
                  activeConv?.id === c.id ? 'bg-slate-100' : 'hover:bg-gray-50'
                }`}>
                <div className="relative flex-shrink-0">
                  {c.avatar_url ? (
                    <img src={c.avatar_url} alt="" className="w-11 h-11 rounded-full object-cover" />
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center text-white font-bold text-sm">
                      {(c.contact_username || '?')[0].toUpperCase()}
                    </div>
                  )}
                  <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white"
                    style={{ backgroundColor: LABEL_COLORS[c.label] || '#9ca3af' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`text-sm truncate ${c.unread ? 'text-gray-900 font-semibold' : 'text-gray-800'}`}>
                      {c.contact_name || '@' + c.contact_username}
                    </span>
                    <span className="text-[10px] text-gray-400 flex-shrink-0">{formatListTime(c.updated_at)}</span>
                  </div>
                  <p className={`text-xs truncate mt-0.5 ${c.unread ? 'text-gray-900 font-medium' : 'text-gray-400'}`}>
                    {c.last_message || 'Нет сообщений'}
                  </p>
                </div>
                {c.unread ? <Circle className="text-blue-500 fill-blue-500 flex-shrink-0" size={8} /> : null}
              </div>
            ))
          )}
        </div>

        <div className="p-3 border-t border-gray-100 bg-gray-50">
          <p className="text-[11px] text-gray-400 leading-snug">
            Instagram опрашивается только по кнопке обновления — фоновых запросов нет.
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col bg-gray-50">
        {activeConv ? (
          <>
            <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {activeConv.avatar_url ? (
                  <img src={activeConv.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center text-white font-bold text-sm">
                    {(activeConv.contact_username || '?')[0].toUpperCase()}
                  </div>
                )}
                <div>
                  <div className="text-sm font-semibold text-gray-900">@{activeConv.contact_username}</div>
                  {activeConv.contact_name && <div className="text-xs text-gray-500">{activeConv.contact_name}</div>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-slate-400"
                  value={activeConv.label}
                  onChange={e => updateLabel(activeConv.id, e.target.value)}>
                  {Object.entries(LABEL_NAMES).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <a href={`https://instagram.com/${activeConv.contact_username}`} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-slate-700 hover:text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg transition-colors">
                  <ExternalLink size={12} /> IG
                </a>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-2">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm gap-2">
                  <MessageSquare size={32} className="text-gray-300" />
                  <span>Сообщения ещё не загружены</span>
                  <button onClick={handleSync} disabled={syncing}
                    className="text-xs text-slate-700 hover:text-slate-900 underline disabled:opacity-50">
                    Загрузить из Instagram
                  </button>
                </div>
              ) : (
                messages.map((msg, i) => {
                  const prev = messages[i - 1];
                  const showDate = !prev ||
                    new Date(prev.created_at).toDateString() !== new Date(msg.created_at).toDateString();
                  const mine = msg.sender === 'me';

                  return (
                    <React.Fragment key={msg.id}>
                      {showDate && (
                        <div className="flex justify-center py-3">
                          <span className="text-[11px] text-gray-500 bg-gray-200 px-3 py-1 rounded-full">
                            {formatDateSeparator(msg.created_at)}
                          </span>
                        </div>
                      )}
                      <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
                          mine
                            ? 'bg-slate-800 text-white rounded-br-md'
                            : 'bg-white text-gray-800 border border-gray-200 rounded-bl-md shadow-sm'
                        }`}>
                          <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
                          <div className={`flex items-center gap-1 text-[10px] mt-1 ${mine ? 'text-slate-200' : 'text-gray-400'}`}>
                            {msg.pending_send ? (
                              <><Clock size={10} /> отправляется…</>
                            ) : msg.error_message ? (
                              <span className={`flex items-center gap-1 ${mine ? 'text-yellow-200' : 'text-red-500'}`}>
                                <AlertCircle size={10} /> {msg.error_message}
                              </span>
                            ) : (
                              formatMessageTime(msg.created_at)
                            )}
                          </div>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="bg-white border-t border-gray-200 px-6 py-4">
              <div className="flex items-end gap-3">
                <textarea
                  className="flex-1 bg-gray-100 border-0 rounded-xl px-4 py-2.5 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:bg-white resize-none"
                  placeholder="Напишите сообщение..."
                  value={messageInput}
                  onChange={e => setMessageInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  rows="3"
                  disabled={sending}
                />
                <button
                  onClick={sendMessage}
                  disabled={!messageInput.trim() || sending}
                  className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-xl transition-colors font-medium text-sm">
                  {sending ? <Loader size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-2 ml-1">
                Расширение доставит сообщение в Instagram в течение ~30 секунд
              </p>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquare className="mx-auto text-gray-300 mb-3" size={48} />
              <h3 className="text-lg font-medium text-gray-500">Выберите чат</h3>
              <p className="text-sm text-gray-400 mt-1">Выберите переписку слева</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
