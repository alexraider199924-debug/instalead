import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { getDB } from '../db/workspaceManager.js';
import { getLink, redeemLinkCode, unlinkTelegram } from './telegramLinkService.js';
import { setNotifySender, setNotifyFileSender } from './notifier.js';
import {
  activateCampaign,
  pauseCampaign,
  logCampaignEvent,
  getMoscowISO,
  getCampaignScheduleInfo,
} from './schedulerService.js';
import { buildSearchPlan, planSourceCount } from './leadSearchService.js';
import {
  createSearchJob,
  jobWithProgress,
  buildXlsx,
  estimateSearchSeconds,
  SEARCH_LIMITS,
} from '../routes/lead-search.js';

// ---------------------------------------------------------------------------
// Telegram remote control.
//
// The bot is a remote, not an engine. Everything that touches Instagram is
// still done by the Chrome extension; the bot queues work, reads state and
// reports back. When the extension is offline the bot says so plainly instead
// of accepting a command that will silently never run.
//
// It calls services and getDB() in-process rather than looping back through
// its own HTTP API — it has no session cookie, and /api/* returns 401 without
// one as soon as auth is enabled.
//
// The token is read from the environment only. It is never written into
// source, because source goes into git.
// ---------------------------------------------------------------------------

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// api.telegram.org is unreachable from some networks (Russia among them), so
// the transport is configurable. TELEGRAM_PROXY takes precedence; SOCKS5_PROXY
// is reused as a fallback because the install already carries one.
// TELEGRAM_API_ROOT points at a self-hosted or mirrored Bot API server.
const PROXY_URL = process.env.TELEGRAM_PROXY || process.env.SOCKS5_PROXY || '';
const API_ROOT = process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org';

let bot = null;
let botInfo = null;
let started = false;

export function isBotEnabled() {
  return Boolean(TOKEN);
}

export function getBotInfo() {
  return botInfo;
}

async function buildProxyAgent() {
  if (!PROXY_URL) return null;
  try {
    if (/^socks/i.test(PROXY_URL)) {
      const { SocksProxyAgent } = await import('socks-proxy-agent');
      return new SocksProxyAgent(PROXY_URL);
    }
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    return new HttpsProxyAgent(PROXY_URL);
  } catch (e) {
    console.error('[TelegramBot] Не удалось настроить прокси:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function trim(value, max = 60) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function humanMinutes(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
}

const STATUS_ICON = {
  draft: '📝',
  scheduled: '🗓',
  active: '▶️',
  paused: '⏸',
  completed: '✅',
  failed: '⚠️',
  pending: '⏳',
  running: '▶️',
  cancelled: '⛔️',
};

function statusIcon(status) {
  return STATUS_ICON[status] || '•';
}

// ---------------------------------------------------------------------------
// Wizard state
//
// Deliberately in memory and deliberately without @grammyjs/conversations:
// a half-finished wizard is worth nothing after a restart, and an extra
// dependency that persists it would buy nothing.
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

function getSession(chatId) {
  const s = sessions.get(chatId);
  if (!s) return null;
  if (Date.now() - s.updated > SESSION_TTL_MS) {
    sessions.delete(chatId);
    return null;
  }
  return s;
}

function setSession(chatId, session) {
  sessions.set(chatId, { ...session, updated: Date.now() });
}

function clearSession(chatId) {
  sessions.delete(chatId);
}

// ---------------------------------------------------------------------------
// Authorization
//
// A chat id proves nothing — anyone can message the bot. The only thing that
// grants access to a workspace is a link code redeemed from the web UI, so
// every handler resolves the binding first.
// ---------------------------------------------------------------------------

async function requireLink(ctx) {
  const link = await getLink(ctx.from?.id);
  if (!link) {
    await ctx.reply(
      '🔒 Этот чат не привязан к аккаунту.\n\n' +
      'Откройте <b>Настройки → Телеграм</b> в панели Instalead, нажмите «Подключить Телеграм» ' +
      'и отправьте сюда полученный 6-значный код.',
      { parse_mode: 'HTML' }
    );
    return null;
  }
  return link;
}

async function workspaceDb(link) {
  return getDB(link.workspace);
}

// ---------------------------------------------------------------------------
// Shared state readers
// ---------------------------------------------------------------------------

function extensionState(db) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'extension_heartbeat'`).get();
  if (!row?.value) return { connected: false, running: false, age: null };
  try {
    const hb = JSON.parse(row.value);
    const age = Date.now() - new Date(hb.timestamp).getTime();
    return { connected: age < 60000, running: Boolean(hb.running), age };
  } catch {
    return { connected: false, running: false, age: null };
  }
}

function connectedAccount(db) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ig_connected_account'`).get();
  return row?.value || null;
}

function sentToday(db) {
  const today = getMoscowISO().slice(0, 10);
  return db.prepare(
    `SELECT COUNT(*) AS n FROM campaign_leads WHERE status = 'sent' AND sent_at LIKE ?`
  ).get(`${today}%`).n;
}

// ---------------------------------------------------------------------------
// /start — link redemption
// ---------------------------------------------------------------------------

async function handleStart(ctx) {
  const link = await getLink(ctx.from?.id);
  if (link) {
    await ctx.reply(
      `✅ Чат уже привязан к <b>${esc(link.workspace)}</b>.\n\n` + HELP_TEXT,
      { parse_mode: 'HTML' }
    );
    return;
  }
  await ctx.reply(
    '👋 <b>Instalead</b> — управление рассылками в Instagram.\n\n' +
    'Чтобы привязать чат:\n' +
    '1️⃣ Откройте панель Instalead → <b>Настройки → Телеграм</b>\n' +
    '2️⃣ Нажмите «Подключить Телеграм»\n' +
    '3️⃣ Отправьте сюда 6-значный код\n\n' +
    'Код живёт 15 минут.',
    { parse_mode: 'HTML' }
  );
}

async function handleCode(ctx, text) {
  const result = await redeemLinkCode(text, ctx.from.id, ctx.from.username);
  if (!result.ok) {
    await ctx.reply(`❌ ${esc(result.error)}`, { parse_mode: 'HTML' });
    return;
  }
  await ctx.reply(
    `✅ Чат привязан к <b>${esc(result.workspace)}</b>.\n\n` + HELP_TEXT,
    { parse_mode: 'HTML' }
  );
}

const HELP_TEXT =
  '<b>Команды</b>\n' +
  '/status — состояние аккаунта и расширения\n' +
  '/campaigns — кампании: запуск, пауза, статистика\n' +
  '/newcampaign — создать кампанию\n' +
  '/find — AI-поиск лидов\n' +
  '/inbox — диалоги, ждущие ответа\n' +
  '/cancel — прервать текущий диалог\n' +
  '/unlink — отвязать чат';

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

async function handleStatus(ctx, link) {
  const db = await workspaceDb(link);
  const ext = extensionState(db);
  const account = connectedAccount(db);

  const campaigns = db.prepare(
    `SELECT status, COUNT(*) AS n FROM campaigns WHERE COALESCE(archived, 0) = 0 GROUP BY status`
  ).all();
  const byStatus = Object.fromEntries(campaigns.map(r => [r.status, r.n]));

  const scrape = db.prepare(
    `SELECT id, status FROM scrape_jobs WHERE status IN ('pending','running','paused') ORDER BY id DESC LIMIT 1`
  ).get();
  const search = db.prepare(
    `SELECT id, status FROM lead_search_jobs WHERE status IN ('pending','running','paused') ORDER BY id DESC LIMIT 1`
  ).get();

  const needReply = db.prepare(
    `SELECT COUNT(*) AS n FROM inbox_conversations WHERE label = 'needs_reply'`
  ).get().n;

  const lines = [
    `<b>${esc(link.workspace)}</b>`,
    '',
    `📸 Instagram: ${account ? '@' + esc(account) : '<i>не подключён</i>'}`,
    ext.connected
      ? `🟢 Расширение: онлайн${ext.running ? ' (работает)' : ' (простаивает)'}`
      : '🔴 Расширение: офлайн — откройте Chrome с расширением, иначе задачи не выполнятся',
    '',
    `✉️ Отправлено сегодня: <b>${sentToday(db)}</b>`,
    `▶️ Активных кампаний: <b>${byStatus.active || 0}</b>` +
      (byStatus.paused ? ` · на паузе: ${byStatus.paused}` : '') +
      (byStatus.scheduled ? ` · запланировано: ${byStatus.scheduled}` : ''),
    `💬 Ждут ответа: <b>${needReply}</b>`,
  ];

  if (scrape) lines.push(`🔍 Lead Finder: задача #${scrape.id} — ${esc(scrape.status)}`);
  if (search) {
    const job = jobWithProgress(db, db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(search.id));
    lines.push(`✨ AI-поиск: #${job.id} — ${esc(job.status)}, ${job.percent}%`);
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// ---------------------------------------------------------------------------
// /campaigns
// ---------------------------------------------------------------------------

function campaignRow(db, id) {
  return db.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id) AS total,
           (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'sent') AS sent,
           (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND replied = 1) AS replied
    FROM campaigns c WHERE c.id = ?
  `).get(id);
}

async function handleCampaigns(ctx, link) {
  const db = await workspaceDb(link);
  const rows = db.prepare(`
    SELECT c.id, c.name, c.status,
           (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id) AS total,
           (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'sent') AS sent
    FROM campaigns c
    WHERE COALESCE(c.archived, 0) = 0
    ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'scheduled' THEN 2 ELSE 3 END,
             c.id DESC
    LIMIT 10
  `).all();

  if (!rows.length) {
    await ctx.reply('Кампаний пока нет. Создайте первую: /newcampaign');
    return;
  }

  for (const c of rows) {
    const kb = new InlineKeyboard();
    if (c.status === 'active') kb.text('⏸ Пауза', `c:pause:${c.id}`);
    else kb.text('▶️ Запустить', `c:run:${c.id}`);
    kb.text('📊 Статистика', `c:stat:${c.id}`);

    await ctx.reply(
      `${statusIcon(c.status)} <b>${esc(c.name)}</b> <code>#${c.id}</code>\n` +
      `${c.sent} / ${c.total} отправлено · ${esc(c.status)}`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }
}

async function handleCampaignAction(ctx, link, action, id) {
  const db = await workspaceDb(link);
  const campaign = campaignRow(db, id);
  if (!campaign) {
    await ctx.answerCallbackQuery({ text: 'Кампания не найдена', show_alert: true });
    return;
  }

  if (action === 'stat') {
    const schedule = getCampaignScheduleInfo(db, id);
    const pending = campaign.total - campaign.sent;
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📊 <b>${esc(campaign.name)}</b>\n\n` +
      `Статус: ${statusIcon(campaign.status)} ${esc(campaign.status)}\n` +
      `Отправлено: <b>${campaign.sent}</b> из ${campaign.total} (осталось ${pending})\n` +
      `Ответили: <b>${campaign.replied || 0}</b>` +
      (campaign.sent ? ` (${Math.round((campaign.replied || 0) / campaign.sent * 100)}%)` : '') + '\n' +
      `Лимит в день: ${campaign.daily_limit}\n` +
      `Расписание: ${esc(campaign.schedule_start)}–${esc(campaign.schedule_end)}, ${esc(campaign.schedule_days || '—')}\n` +
      (schedule?.in_working_hours
        ? '🟢 Сейчас рабочее время'
        : `⏸ Вне рабочего времени${schedule?.next_window ? `, следующее окно ${esc(schedule.next_window.slice(0, 16).replace('T', ' '))}` : ''}`),
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (action === 'run') {
    const ext = extensionState(db);
    activateCampaign(db, id);
    await ctx.answerCallbackQuery({ text: 'Кампания запущена' });
    await ctx.reply(
      `▶️ <b>${esc(campaign.name)}</b> запущена.` +
      (ext.connected ? '' : '\n\n⚠️ Расширение сейчас офлайн — отправка начнётся, когда откроется Chrome с расширением.'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (action === 'pause') {
    pauseCampaign(db, id);
    await ctx.answerCallbackQuery({ text: 'Кампания на паузе' });
    await ctx.reply(`⏸ <b>${esc(campaign.name)}</b> на паузе.`, { parse_mode: 'HTML' });
  }
}

// ---------------------------------------------------------------------------
// /newcampaign — wizard
// ---------------------------------------------------------------------------

const CAMPAIGN_STEPS = {
  name: 'Как назвать кампанию?',
  message: 'Пришлите текст сообщения.\n\nМожно использовать <code>{name}</code> и <code>{username}</code> — они подставятся автоматически.',
  ai: 'Персонализировать каждое сообщение через AI?',
  prompt: 'Опишите, как AI должен адаптировать текст под профиль. Например: «упомяни нишу человека одной фразой, тон дружелюбный, не более 2 предложений».',
  audience: 'Кого добавить в кампанию?',
  limit: 'Сколько сообщений в день? Рекомендую 15–20 для прогретого аккаунта, 5–10 для нового.',
};

async function startCampaignWizard(ctx, link) {
  const db = await workspaceDb(link);
  const contacts = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  if (!contacts) {
    await ctx.reply(
      'В базе нет контактов — кампанию некому отправлять.\n\n' +
      'Соберите базу через /find или загрузите контакты в панели.'
    );
    return;
  }
  setSession(ctx.chat.id, { flow: 'campaign', step: 'name', data: {} });
  await ctx.reply(
    `🆕 <b>Новая кампания</b> (шаг 1 из 6)\n\n${CAMPAIGN_STEPS.name}\n\n<i>/cancel — отменить</i>`,
    { parse_mode: 'HTML' }
  );
}

async function askAudience(ctx, link) {
  const db = await workspaceDb(link);
  const total = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const hot = db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE lead_quality = 'hot'`).get().n;
  const warm = db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE lead_quality = 'warm'`).get().n;

  const kb = new InlineKeyboard()
    .text(`🔥 Только hot (${hot})`, 'w:aud:hot').row()
    .text(`🌤 Hot + warm (${hot + warm})`, 'w:aud:warm').row()
    .text(`📋 Все контакты (${total})`, 'w:aud:all').row()
    .text('⏭ Без аудитории (добавлю в панели)', 'w:aud:none');

  await ctx.reply(`👥 <b>Шаг 5 из 6</b>\n\n${CAMPAIGN_STEPS.audience}`, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
}

function contactIdsFor(db, audience) {
  if (audience === 'none') return [];
  if (audience === 'hot') return db.prepare(`SELECT id FROM contacts WHERE lead_quality = 'hot'`).all().map(r => r.id);
  if (audience === 'warm') return db.prepare(`SELECT id FROM contacts WHERE lead_quality IN ('hot','warm')`).all().map(r => r.id);
  return db.prepare('SELECT id FROM contacts').all().map(r => r.id);
}

// Mirrors POST /api/campaigns so a campaign made from Telegram is
// indistinguishable from one made in the web UI.
function createCampaignFromWizard(db, data) {
  const result = db.prepare(`
    INSERT INTO campaigns (name, message_template, ai_provider, ai_generated, ai_prompt, scheduled_at, delay_seconds, status, daily_limit, send_time, min_delay, max_delay, follow_profile, wait_for_reply, value_per_lead, schedule_days, schedule_start, schedule_end, skip_contacted, stop_on_reply, pause_unsafe, safe_delays, warmup, like_last_post, prewarm_follow, prewarm_delay_hours)
    VALUES (?, ?, 'openrouter', ?, ?, NULL, 30, 'draft', ?, NULL, 7, 17, 1, 1, 0, 'mon,tue,wed,thu,fri', '09:00', '18:00', 1, 1, 1, 1, 1, 0, 0, 24)
  `).run(
    data.name,
    data.message,
    data.ai_prompt ? 1 : 0,
    data.ai_prompt || null,
    data.daily_limit
  );

  const campaignId = result.lastInsertRowid;

  const leadIds = [];
  for (const cid of data.contact_ids || []) {
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
    if (!contact) continue;
    const username = (contact.username || '').trim();
    if (!username) continue;
    let lead = db.prepare('SELECT id FROM leads WHERE username = ?').get(username);
    if (!lead) {
      const r = db.prepare(
        'INSERT INTO leads (username, full_name, email, bio, niche, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(username, contact.full_name || null, contact.email || null, null, null, 'new');
      lead = { id: r.lastInsertRowid };
    }
    leadIds.push(lead.id);
  }

  if (leadIds.length) {
    const insert = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)');
    db.transaction(() => leadIds.forEach(lid => insert.run(campaignId, lid)))();
  }

  logCampaignEvent(db, campaignId, 'created', `Кампания "${data.name}" создана из Телеграма`);
  return { campaignId, leadCount: leadIds.length };
}

async function showCampaignConfirm(ctx, link, session) {
  const db = await workspaceDb(link);
  const ids = contactIdsFor(db, session.data.audience);
  session.data.contact_ids = ids;
  setSession(ctx.chat.id, { ...session, step: 'confirm' });

  const kb = new InlineKeyboard()
    .text('✅ Создать', 'w:save:draft').row()
    .text('🚀 Создать и запустить', 'w:save:run').row()
    .text('✖️ Отмена', 'w:cancel');

  await ctx.reply(
    `<b>Шаг 6 из 6 — проверьте</b>\n\n` +
    `Название: <b>${esc(session.data.name)}</b>\n` +
    `Аудитория: <b>${ids.length}</b> контактов\n` +
    `Лимит в день: <b>${session.data.daily_limit}</b>\n` +
    `AI-персонализация: <b>${session.data.ai_prompt ? 'да' : 'нет'}</b>\n\n` +
    `<b>Текст:</b>\n${esc(trim(session.data.message, 500))}`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

async function handleCampaignText(ctx, link, session, text) {
  const chatId = ctx.chat.id;
  const data = session.data;

  if (session.step === 'name') {
    data.name = trim(text, 80);
    setSession(chatId, { ...session, step: 'message', data });
    await ctx.reply(`<b>Шаг 2 из 6</b>\n\n${CAMPAIGN_STEPS.message}`, { parse_mode: 'HTML' });
    return;
  }

  if (session.step === 'message') {
    if (text.length > 900) {
      await ctx.reply('Слишком длинно для первого сообщения в Instagram. Уложитесь в 900 символов.');
      return;
    }
    data.message = text;
    setSession(chatId, { ...session, step: 'ai', data });
    const kb = new InlineKeyboard().text('🤖 Да', 'w:ai:yes').text('✍️ Нет, как есть', 'w:ai:no');
    await ctx.reply(`<b>Шаг 3 из 6</b>\n\n${CAMPAIGN_STEPS.ai}`, { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  if (session.step === 'prompt') {
    data.ai_prompt = text;
    setSession(chatId, { ...session, step: 'audience', data });
    await askAudience(ctx, link);
    return;
  }

  if (session.step === 'limit') {
    const limit = parseInt(text.replace(/\D/g, ''), 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      await ctx.reply('Нужно число от 1 до 100.');
      return;
    }
    data.daily_limit = limit;
    await showCampaignConfirm(ctx, link, { ...session, data });
  }
}

// ---------------------------------------------------------------------------
// /find — AI lead search
// ---------------------------------------------------------------------------

const FIND_DEFAULT_TARGET = 150;
const FIND_DEFAULT_ENRICH = 80;

async function startFind(ctx, link, inlineQuery) {
  if (inlineQuery) {
    await runFindPlan(ctx, link, inlineQuery);
    return;
  }
  setSession(ctx.chat.id, { flow: 'find', step: 'query', data: {} });
  await ctx.reply(
    '✨ <b>AI-поиск лидов</b>\n\n' +
    'Опишите, кто вам нужен — ниша, город, размер аккаунта.\n\n' +
    '<i>Например: нутрициологи в Москве, 1–10к подписчиков</i>\n\n' +
    '<i>/cancel — отменить</i>',
    { parse_mode: 'HTML' }
  );
}

async function runFindPlan(ctx, link, query) {
  const db = await workspaceDb(link);
  const thinking = await ctx.reply('🧠 Составляю план поиска…');

  let plan;
  try {
    plan = await buildSearchPlan(db, query);
  } catch (e) {
    clearSession(ctx.chat.id);
    await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, `❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
    return;
  }

  const sources = planSourceCount(plan);
  if (!sources) {
    clearSession(ctx.chat.id);
    await ctx.api.editMessageText(
      ctx.chat.id, thinking.message_id,
      'AI не смог собрать источники по этому запросу. Попробуйте описать нишу и город конкретнее.'
    );
    return;
  }

  const seconds = estimateSearchSeconds(sources, FIND_DEFAULT_TARGET, FIND_DEFAULT_ENRICH);
  setSession(ctx.chat.id, { flow: 'find', step: 'confirm', data: { query, plan } });

  const kb = new InlineKeyboard()
    .text('🚀 Запустить поиск', 'f:run').row()
    .text('✖️ Отмена', 'f:cancel');

  const lines = [
    `<b>План поиска</b>`,
    `<i>${esc(trim(query, 120))}</i>`,
    '',
    plan.niche ? `Ниша: ${esc(plan.niche)}` : null,
    plan.geo ? `Гео: ${esc(plan.geo)}` : null,
    plan.hashtags?.length ? `#️⃣ ${plan.hashtags.map(h => '#' + esc(h)).join(' ')}` : null,
    plan.places?.length ? `📍 ${plan.places.map(esc).join(', ')}` : null,
    plan.keywords?.length ? `🔤 ${plan.keywords.map(esc).join(', ')}` : null,
    plan.exclude?.length ? `🚫 ${plan.exclude.map(esc).join(', ')}` : null,
    (plan.min_followers || plan.max_followers)
      ? `👥 ${plan.min_followers || 0}–${plan.max_followers || '∞'} подписчиков`
      : null,
    '',
    `Соберу до <b>${FIND_DEFAULT_TARGET}</b> кандидатов, разберу <b>${FIND_DEFAULT_ENRICH}</b> профилей.`,
    `⏱ Примерно ${humanMinutes(seconds)} — паузы между запросами обязательны, иначе Instagram ограничит аккаунт.`,
    '',
    '<i>Точнее настроить план можно на странице «AI Поиск» в панели.</i>',
  ].filter(Boolean);

  await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
}

async function launchFind(ctx, link, session) {
  const db = await workspaceDb(link);
  const ext = extensionState(db);

  let job;
  try {
    job = createSearchJob(db, {
      query: session.data.query,
      plan: session.data.plan,
      target_count: FIND_DEFAULT_TARGET,
      enrich_limit: FIND_DEFAULT_ENRICH,
    });
  } catch (e) {
    clearSession(ctx.chat.id);
    await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
    return;
  }

  clearSession(ctx.chat.id);
  await ctx.reply(
    `🚀 Поиск <code>#${job.id}</code> запущен.\n\n` +
    (ext.connected
      ? 'Пришлю таблицу в этот чат, когда закончу.'
      : '⚠️ Расширение офлайн — поиск начнётся, когда откроется Chrome с расширением.') +
    `\n\nПрогресс: /find_status`,
    { parse_mode: 'HTML' }
  );
}

async function handleFindStatus(ctx, link) {
  const db = await workspaceDb(link);
  const row = db.prepare('SELECT * FROM lead_search_jobs ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    await ctx.reply('Поисков ещё не было. Запустите: /find');
    return;
  }
  const job = jobWithProgress(db, row);
  const kb = new InlineKeyboard();
  if (job.status === 'running' || job.status === 'pending') kb.text('⏸ Пауза', `f:pause:${job.id}`);
  if (job.status === 'paused') kb.text('▶️ Продолжить', `f:resume:${job.id}`);
  if (['running', 'pending', 'paused'].includes(job.status)) kb.text('⛔️ Отменить', `f:cancel:${job.id}`);
  if (job.matched_count > 0) kb.row().text('📥 Скачать таблицу', `f:xlsx:${job.id}`);

  await ctx.reply(
    `${statusIcon(job.status)} <b>Поиск #${job.id}</b> — ${job.percent}%\n` +
    `<i>${esc(trim(job.query_text, 100))}</i>\n\n` +
    `Фаза: ${esc(job.phase)}\n` +
    `Найдено: ${job.discovered_count} · разобрано: ${job.enriched_count} · подходят: <b>${job.matched_count}</b>` +
    (job.error_message ? `\n\n⚠️ ${esc(job.error_message)}` : ''),
    { parse_mode: 'HTML', reply_markup: kb.inline_keyboard.length ? kb : undefined }
  );
}

async function sendSearchXlsx(chatId, workspace, jobId, caption) {
  const db = await getDB(workspace);
  const buffer = buildXlsx(db, jobId, true);
  await bot.api.sendDocument(
    chatId,
    new InputFile(buffer, `instalead-leads-${jobId}.xlsx`),
    caption ? { caption, parse_mode: 'HTML' } : {}
  );
}

// ---------------------------------------------------------------------------
// /inbox
//
// A reply goes into inbox_messages with pending_send = 1; the extension picks
// it up through the existing /extension/inbox-outbox route and delivers it.
// The bot never talks to Instagram itself.
// ---------------------------------------------------------------------------

async function handleInbox(ctx, link) {
  const db = await workspaceDb(link);
  const rows = db.prepare(`
    SELECT id, contact_username, contact_name, last_message, unread
    FROM inbox_conversations
    WHERE label = 'needs_reply'
    ORDER BY COALESCE(last_activity_at, 0) DESC, id DESC
    LIMIT 8
  `).all();

  if (!rows.length) {
    await ctx.reply('📭 Нет диалогов, ждущих ответа.');
    return;
  }

  for (const c of rows) {
    const kb = new InlineKeyboard().text('💬 Ответить', `i:open:${c.id}`);
    await ctx.reply(
      `${c.unread ? '🔵 ' : ''}<b>@${esc(c.contact_username)}</b>` +
      (c.contact_name ? ` · ${esc(c.contact_name)}` : '') + '\n' +
      `<i>${esc(trim(c.last_message, 150))}</i>`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }
}

async function openConversation(ctx, link, conversationId) {
  const db = await workspaceDb(link);
  const conv = db.prepare('SELECT * FROM inbox_conversations WHERE id = ?').get(conversationId);
  if (!conv) {
    await ctx.answerCallbackQuery({ text: 'Диалог не найден', show_alert: true });
    return;
  }

  const messages = db.prepare(`
    SELECT sender, text FROM inbox_messages
    WHERE conversation_id = ?
    ORDER BY COALESCE(ig_timestamp, 0) DESC, id DESC
    LIMIT 6
  `).all(conversationId).reverse();

  const history = messages
    .map(m => `${m.sender === 'me' ? '➡️' : '⬅️'} ${esc(trim(m.text, 200))}`)
    .join('\n');

  setSession(ctx.chat.id, { flow: 'reply', step: 'text', data: { conversationId, username: conv.contact_username } });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `💬 <b>@${esc(conv.contact_username)}</b>\n\n${history || '<i>История пуста</i>'}\n\n` +
    'Пришлите текст ответа — расширение отправит его в Instagram.\n<i>/cancel — не отвечать</i>',
    { parse_mode: 'HTML' }
  );
}

async function queueReply(ctx, link, session, text) {
  const db = await workspaceDb(link);
  const { conversationId, username } = session.data;
  const ext = extensionState(db);

  const nowMicros = Date.now() * 1000;
  const nowIso = new Date().toISOString();

  db.prepare(`
    INSERT INTO inbox_messages (conversation_id, sender, text, pending_send, created_at, ig_timestamp)
    VALUES (?, 'me', ?, 1, ?, ?)
  `).run(conversationId, text, nowIso, nowMicros);

  db.prepare(`
    UPDATE inbox_conversations
    SET last_message = ?, last_activity_at = ?, updated_at = ?, label = 'in_progress', unread = 0
    WHERE id = ?
  `).run('You: ' + text, nowMicros, nowIso, conversationId);

  clearSession(ctx.chat.id);
  await ctx.reply(
    `✅ Ответ для <b>@${esc(username)}</b> поставлен в очередь.` +
    (ext.connected ? '' : '\n\n⚠️ Расширение офлайн — сообщение уйдёт, когда оно подключится.'),
    { parse_mode: 'HTML' }
  );
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function registerHandlers() {
  bot.command('start', handleStart);

  bot.command('help', async ctx => {
    await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.command('cancel', async ctx => {
    const had = Boolean(getSession(ctx.chat.id));
    clearSession(ctx.chat.id);
    await ctx.reply(had ? '✖️ Отменено.' : 'Нечего отменять.');
  });

  bot.command('unlink', async ctx => {
    const removed = await unlinkTelegram(ctx.from.id);
    clearSession(ctx.chat.id);
    await ctx.reply(removed ? '🔓 Чат отвязан.' : 'Этот чат и не был привязан.');
  });

  bot.command('status', async ctx => {
    const link = await requireLink(ctx);
    if (link) await handleStatus(ctx, link);
  });

  bot.command('campaigns', async ctx => {
    const link = await requireLink(ctx);
    if (link) await handleCampaigns(ctx, link);
  });

  bot.command('newcampaign', async ctx => {
    const link = await requireLink(ctx);
    if (link) await startCampaignWizard(ctx, link);
  });

  bot.command('find_status', async ctx => {
    const link = await requireLink(ctx);
    if (link) await handleFindStatus(ctx, link);
  });

  bot.command('find', async ctx => {
    const link = await requireLink(ctx);
    if (link) await startFind(ctx, link, ctx.match?.trim());
  });

  bot.command('inbox', async ctx => {
    const link = await requireLink(ctx);
    if (link) await handleInbox(ctx, link);
  });

  bot.on('callback_query:data', async ctx => {
    const link = await getLink(ctx.from.id);
    if (!link) {
      await ctx.answerCallbackQuery({ text: 'Чат не привязан', show_alert: true });
      return;
    }

    const [scope, action, arg] = ctx.callbackQuery.data.split(':');

    if (scope === 'c') {
      await handleCampaignAction(ctx, link, action, Number(arg));
      return;
    }

    if (scope === 'w') {
      await handleWizardCallback(ctx, link, action, arg);
      return;
    }

    if (scope === 'f') {
      await handleFindCallback(ctx, link, action, arg);
      return;
    }

    if (scope === 'i' && action === 'open') {
      await openConversation(ctx, link, Number(arg));
      return;
    }

    await ctx.answerCallbackQuery();
  });

  bot.on('message:text', async ctx => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const link = await getLink(ctx.from.id);

    // An unlinked chat can do exactly one thing: redeem a code.
    if (!link) {
      if (/^\d{6}$/.test(text)) {
        await handleCode(ctx, text);
      } else {
        await requireLink(ctx);
      }
      return;
    }

    const session = getSession(ctx.chat.id);
    if (!session) {
      await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
      return;
    }

    if (session.flow === 'campaign') {
      await handleCampaignText(ctx, link, session, text);
      return;
    }
    if (session.flow === 'find' && session.step === 'query') {
      await runFindPlan(ctx, link, text);
      return;
    }
    if (session.flow === 'reply' && session.step === 'text') {
      await queueReply(ctx, link, session, text);
    }
  });

  bot.catch(err => {
    console.error('[TelegramBot] handler error:', err.error?.message || err.message);
  });
}

async function handleWizardCallback(ctx, link, action, arg) {
  const session = getSession(ctx.chat.id);
  if (!session || session.flow !== 'campaign') {
    await ctx.answerCallbackQuery({ text: 'Диалог устарел — начните заново: /newcampaign', show_alert: true });
    return;
  }

  if (action === 'cancel') {
    clearSession(ctx.chat.id);
    await ctx.answerCallbackQuery();
    await ctx.reply('✖️ Создание кампании отменено.');
    return;
  }

  if (action === 'ai') {
    await ctx.answerCallbackQuery();
    if (arg === 'yes') {
      setSession(ctx.chat.id, { ...session, step: 'prompt' });
      await ctx.reply(`<b>Шаг 4 из 6</b>\n\n${CAMPAIGN_STEPS.prompt}`, { parse_mode: 'HTML' });
    } else {
      setSession(ctx.chat.id, { ...session, step: 'audience' });
      await askAudience(ctx, link);
    }
    return;
  }

  if (action === 'aud') {
    session.data.audience = arg;
    setSession(ctx.chat.id, { ...session, step: 'limit' });
    await ctx.answerCallbackQuery();
    await ctx.reply(`<b>Шаг 6 из 6</b>\n\n${CAMPAIGN_STEPS.limit}`, { parse_mode: 'HTML' });
    return;
  }

  if (action === 'save') {
    const db = await workspaceDb(link);
    await ctx.answerCallbackQuery();
    let created;
    try {
      created = createCampaignFromWizard(db, session.data);
    } catch (e) {
      await ctx.reply(`❌ Не удалось создать кампанию: ${esc(e.message)}`, { parse_mode: 'HTML' });
      return;
    }

    clearSession(ctx.chat.id);

    if (arg === 'run') {
      if (!created.leadCount) {
        await ctx.reply(
          `✅ Кампания <code>#${created.campaignId}</code> создана, но запускать её не с кем — ` +
          'аудитория пуста. Добавьте контакты в панели и запустите через /campaigns.',
          { parse_mode: 'HTML' }
        );
        return;
      }
      const ext = extensionState(db);
      activateCampaign(db, created.campaignId);
      await ctx.reply(
        `🚀 Кампания <code>#${created.campaignId}</code> создана и запущена — ${created.leadCount} получателей.` +
        (ext.connected ? '' : '\n\n⚠️ Расширение офлайн — отправка начнётся после подключения.'),
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(
        `✅ Кампания <code>#${created.campaignId}</code> создана как черновик — ${created.leadCount} получателей.\n` +
        'Запустить: /campaigns',
        { parse_mode: 'HTML' }
      );
    }
  }
}

async function handleFindCallback(ctx, link, action, arg) {
  const db = await workspaceDb(link);

  if (action === 'run') {
    const session = getSession(ctx.chat.id);
    if (!session || session.flow !== 'find') {
      await ctx.answerCallbackQuery({ text: 'План устарел — соберите заново: /find', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await launchFind(ctx, link, session);
    return;
  }

  if (action === 'cancel' && !arg) {
    clearSession(ctx.chat.id);
    await ctx.answerCallbackQuery();
    await ctx.reply('✖️ Поиск отменён.');
    return;
  }

  const jobId = Number(arg);
  const job = db.prepare('SELECT * FROM lead_search_jobs WHERE id = ?').get(jobId);
  if (!job) {
    await ctx.answerCallbackQuery({ text: 'Задача не найдена', show_alert: true });
    return;
  }

  if (action === 'xlsx') {
    await ctx.answerCallbackQuery();
    try {
      await sendSearchXlsx(ctx.chat.id, link.workspace, jobId, `📊 Лиды по запросу «${esc(trim(job.query_text, 80))}»`);
    } catch (e) {
      await ctx.reply(`❌ Не удалось собрать файл: ${esc(e.message)}`, { parse_mode: 'HTML' });
    }
    return;
  }

  const nextStatus = { pause: 'paused', resume: 'running', cancel: 'cancelled' }[action];
  if (!nextStatus) {
    await ctx.answerCallbackQuery();
    return;
  }

  db.prepare('UPDATE lead_search_jobs SET status = ?, updated_at = ? WHERE id = ?')
    .run(nextStatus, getMoscowISO(), jobId);
  await ctx.answerCallbackQuery({ text: `Задача: ${nextStatus}` });
  await ctx.reply(`${statusIcon(nextStatus)} Поиск <code>#${jobId}</code> — ${nextStatus}.`, { parse_mode: 'HTML' });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startTelegramBot() {
  if (!TOKEN) {
    console.log('[TelegramBot] TELEGRAM_BOT_TOKEN не задан — бот не запущен');
    return null;
  }
  if (started) return bot;

  const agent = await buildProxyAgent();
  bot = new Bot(TOKEN, {
    client: {
      apiRoot: API_ROOT,
      ...(agent ? { baseFetchConfig: { agent, compress: true } } : {}),
    },
  });
  registerHandlers();

  try {
    botInfo = await bot.api.getMe();
  } catch (e) {
    console.error(
      '[TelegramBot] Не удалось подключиться к Telegram:', e.message,
      PROXY_URL
        ? '— прокси не отвечает, проверьте TELEGRAM_PROXY'
        : '— если api.telegram.org заблокирован, задайте TELEGRAM_PROXY в backend/.env'
    );
    bot = null;
    return null;
  }

  await bot.api.setMyCommands([
    { command: 'status', description: 'Состояние аккаунта и расширения' },
    { command: 'campaigns', description: 'Кампании: запуск, пауза, статистика' },
    { command: 'newcampaign', description: 'Создать кампанию' },
    { command: 'find', description: 'AI-поиск лидов' },
    { command: 'find_status', description: 'Прогресс поиска' },
    { command: 'inbox', description: 'Диалоги, ждущие ответа' },
    { command: 'cancel', description: 'Прервать текущий диалог' },
    { command: 'unlink', description: 'Отвязать чат' },
  ]).catch(e => console.warn('[TelegramBot] setMyCommands:', e.message));

  setNotifySender((chatId, text) =>
    bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
  );
  setNotifyFileSender((chatId, buffer, meta) =>
    bot.api.sendDocument(chatId, new InputFile(buffer, meta.filename), {
      caption: meta.caption,
      parse_mode: 'HTML',
    })
  );

  started = true;

  // Long polling: no webhook, no public URL, works behind any NAT.
  // start() resolves only when the bot stops, so it is deliberately not awaited.
  bot.start({
    drop_pending_updates: true,
    onStart: info => console.log(`[TelegramBot] Запущен как @${info.username}`),
  }).catch(e => {
    console.error('[TelegramBot] Polling остановлен:', e.message);
    started = false;
  });

  return bot;
}

export async function stopTelegramBot() {
  if (bot && started) {
    await bot.stop();
    started = false;
  }
}

// Used by the notifier for plain text alerts.
export async function sendToChat(chatId, text) {
  if (!bot) return false;
  await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
  return true;
}
