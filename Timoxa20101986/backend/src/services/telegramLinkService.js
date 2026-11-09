import { randomInt } from 'crypto';
import { getAuthDB } from '../db/authDb.js';

// ---------------------------------------------------------------------------
// Telegram ↔ workspace binding.
//
// One bot serves every tenant, so a chat id on its own proves nothing: anyone
// can message the bot. The identity comes from the link code, which is minted
// in the web UI by a user who is already signed in and already owns the
// workspace. The bot only ever learns which workspace a chat may touch by
// looking it up here.
//
// Lives in the auth DB, not a workspace DB, because the mapping is what
// selects the workspace in the first place.
// ---------------------------------------------------------------------------

const CODE_TTL_MINUTES = 15;

function nowIso() {
  return new Date().toISOString();
}

// randomInt is the CSPRNG, not Math.random. A guessable six-digit code inside
// a 15-minute window is a way into someone else's account.
function newCode() {
  return String(randomInt(100000, 1000000));
}

export async function createLinkCode(userId, workspace) {
  if (!workspace) throw new Error('Workspace не определён');
  const db = await getAuthDB();

  // Only one live code per user+workspace — a new one invalidates the old,
  // so a code read aloud or pasted somewhere stops working the moment the
  // user generates another.
  db.prepare('DELETE FROM telegram_link_codes WHERE user_id = ? AND workspace = ?')
    .run(userId, workspace);

  const code = newCode();
  const expires = new Date(Date.now() + CODE_TTL_MINUTES * 60000).toISOString();
  db.prepare(`
    INSERT INTO telegram_link_codes (code, user_id, workspace, created_at, expires_at, used)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(code, userId, workspace, nowIso(), expires);

  return { code, expires_at: expires, ttl_minutes: CODE_TTL_MINUTES };
}

export async function redeemLinkCode(code, telegramId, username) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return { ok: false, error: 'Код состоит из 6 цифр' };

  const db = await getAuthDB();
  const row = db.prepare('SELECT * FROM telegram_link_codes WHERE code = ?').get(clean);
  if (!row) return { ok: false, error: 'Неверный код' };
  if (row.used) return { ok: false, error: 'Этот код уже использован' };
  if (row.expires_at <= nowIso()) {
    return { ok: false, error: `Код просрочен — он живёт ${CODE_TTL_MINUTES} минут. Сгенерируйте новый в настройках.` };
  }

  db.prepare('UPDATE telegram_link_codes SET used = 1 WHERE code = ?').run(clean);
  db.prepare(`
    INSERT OR REPLACE INTO telegram_links (telegram_id, user_id, workspace, username, linked_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(telegramId), row.user_id, row.workspace, username || null, nowIso());

  return { ok: true, workspace: row.workspace, user_id: row.user_id };
}

// The single authorization check every bot handler runs before touching data.
export async function getLink(telegramId) {
  const db = await getAuthDB();
  return db.prepare('SELECT * FROM telegram_links WHERE telegram_id = ?').get(String(telegramId)) || null;
}

export async function unlinkTelegram(telegramId) {
  const db = await getAuthDB();
  const out = db.prepare('DELETE FROM telegram_links WHERE telegram_id = ?').run(String(telegramId));
  return out.changes > 0;
}

export async function listLinks(workspace) {
  const db = await getAuthDB();
  return db.prepare(
    'SELECT telegram_id, username, linked_at FROM telegram_links WHERE workspace = ? ORDER BY linked_at DESC'
  ).all(workspace);
}

// Used by the notifier: every chat that should hear about this workspace.
export async function chatIdsForWorkspace(workspace) {
  const db = await getAuthDB();
  return db.prepare('SELECT telegram_id FROM telegram_links WHERE workspace = ?')
    .all(workspace)
    .map(r => r.telegram_id);
}
