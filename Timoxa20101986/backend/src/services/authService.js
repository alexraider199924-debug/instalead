import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'crypto';
import { getAuthDB } from '../db/authDb.js';
import { listWorkspaces } from '../db/workspaceManager.js';

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 30;
const COOKIE = 'instalead_sid';
let registrationLock = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function newToken() {
  return randomBytes(32).toString('hex');
}

export function hashOpaqueToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

export async function createExtensionDevice(userId, workspace, username = null) {
  const db = await getAuthDB();
  const token = newToken();
  const now = nowIso();
  db.prepare('INSERT INTO extension_devices (token_hash, user_id, workspace, instagram_username, created_at, last_seen_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(hashOpaqueToken(token), userId, workspace, username, now, now);
  return { token, workspace };
}

export async function getExtensionDevice(token) {
  if (!token) return null;
  const db = await getAuthDB();
  return db.prepare(`
    SELECT d.*, u.email, u.role, u.banned, u.approved
    FROM extension_devices d
    JOIN users u ON u.id = d.user_id
    WHERE d.token_hash = ? AND d.revoked = 0 AND u.banned = 0 AND u.approved = 1
  `).get(hashOpaqueToken(token)) || null;
}

export async function touchExtensionDevice(token, username) {
  const db = await getAuthDB();
  db.prepare(`UPDATE extension_devices SET last_seen_at = ?, instagram_username = COALESCE(?, instagram_username) WHERE token_hash = ?`)
    .run(nowIso(), username || null, hashOpaqueToken(token));
}

// Signing out of the extension must invalidate the token server-side. Clearing
// chrome.storage alone only hides it locally: anyone who kept a copy of the
// token would keep full access until the device row is revoked.
export async function revokeExtensionDevice(token) {
  if (!token) return 0;
  const db = await getAuthDB();
  const res = db.prepare('UPDATE extension_devices SET revoked = 1 WHERE token_hash = ?')
    .run(hashOpaqueToken(token));
  return res.changes || 0;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    banned: !!row.banned,
    approved: row.approved === undefined ? true : !!row.approved,
    workspace: row.workspace,
    created_at: row.created_at
  };
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  }
  return out;
}

export function readToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers['x-auth-token']) return String(req.headers['x-auth-token']).trim();
  return parseCookies(req)[COOKIE] || '';
}

export function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function userCount() {
  const db = await getAuthDB();
  return db.prepare('SELECT COUNT(*) AS c FROM users').get()?.c || 0;
}

export async function createSession(userId) {
  const db = await getAuthDB();
  const token = newToken();
  const created = nowIso();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, created, expires);
  return token;
}

export async function getUserByToken(token) {
  if (!token) return null;
  const db = await getAuthDB();
  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, nowIso());
  return row || null;
}

export async function deleteSession(token) {
  if (!token) return;
  const db = await getAuthDB();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export async function deleteUserSessions(userId) {
  const db = await getAuthDB();
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export async function grantWorkspace(userId, workspace) {
  const db = await getAuthDB();
  db.prepare('INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(userId, workspace);
}

export async function workspaceOwner(workspace) {
  const db = await getAuthDB();
  return db.prepare('SELECT user_id FROM user_workspaces WHERE workspace = ?').get(workspace) || null;
}

export async function userOwnsWorkspace(userId, workspace) {
  const db = await getAuthDB();
  return !!db.prepare('SELECT 1 FROM user_workspaces WHERE user_id = ? AND workspace = ?').get(userId, workspace);
}

export async function claimWorkspace(userId, workspace) {
  if (!workspace) return false;
  const owner = await workspaceOwner(workspace);
  if (owner && owner.user_id !== userId) return false;
  await grantWorkspace(userId, workspace);
  return true;
}

export async function registerUser(email, password) {
  const previous = registrationLock;
  let release;
  registrationLock = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await registerUserLocked(email, password);
  } finally {
    release();
  }
}

async function registerUserLocked(email, password) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    const err = new Error('Enter a valid email');
    err.status = 400;
    throw err;
  }
  if (!password || String(password).length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.status = 400;
    throw err;
  }

  const db = await getAuthDB();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(clean);
  if (existing) {
    const err = new Error('This email is already registered');
    err.status = 409;
    throw err;
  }

  // Registration never grants admin privileges. Admin access is provisioned
  // explicitly (for example with scripts/create-admin.mjs), not based on signup order.
  const role = 'user';
  const created = nowIso();

  db.prepare(`
    INSERT INTO users (email, password_hash, role, banned, approved, workspace, created_at)
    VALUES (?, ?, ?, 0, 0, 'pending', ?)
  `).run(clean, hashPassword(password), role, created);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(clean);

  let workspace;
  if (role === 'admin') {
    workspace = 'default';
    const names = await listWorkspaces();
    for (const name of names) await grantWorkspace(user.id, name);
    await grantWorkspace(user.id, 'default');
  } else {
    workspace = `u_${user.id}`;
    await grantWorkspace(user.id, workspace);
  }

  db.prepare('UPDATE users SET workspace = ? WHERE id = ?').run(workspace, user.id);
  user.workspace = workspace;
  return { user: publicUser(user), token: null };
}

export async function loginUser(email, password) {
  const clean = String(email || '').trim().toLowerCase();
  const db = await getAuthDB();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(clean);
  if (!user || !verifyPassword(password, user.password_hash)) {
    const err = new Error('Wrong email or password');
    err.status = 401;
    throw err;
  }
  if (user.banned) {
    const err = new Error('This account is banned');
    err.status = 403;
    throw err;
  }
  if (!user.approved) {
    const err = new Error('Your registration is waiting for administrator approval');
    err.status = 403;
    throw err;
  }
  const token = await createSession(user.id);
  return { user: publicUser(user), token };
}

export async function resetUserPassword(userId) {
  const db = await getAuthDB();
  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId);
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  const temporaryPassword = `${randomBytes(6).toString('base64url')}A1!`;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(temporaryPassword), userId);
  await deleteUserSessions(userId);
  return { user, temporaryPassword };
}

export async function listUsers() {
  const db = await getAuthDB();
  return db.prepare('SELECT id, email, role, banned, approved, workspace, created_at FROM users ORDER BY id').all()
    .map(r => ({ ...r, banned: !!r.banned, approved: !!r.approved }));
}

export async function setApproved(userId, approved) {
  const db = await getAuthDB();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  db.prepare('UPDATE users SET approved = ? WHERE id = ?').run(approved ? 1 : 0, userId);
  if (!approved) await deleteUserSessions(userId);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

export async function setBanned(userId, banned) {
  const db = await getAuthDB();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  if (user.role === 'admin' && banned) {
    const err = new Error('Cannot ban the admin account');
    err.status = 400;
    throw err;
  }
  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, userId);
  if (banned) await deleteUserSessions(userId);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

export async function createExtensionPairCode(userId, workspace) {
  const db = await getAuthDB();
  const code = randomBytes(4).toString('hex').toUpperCase();
  const created = nowIso();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('UPDATE extension_pair_codes SET used = 1 WHERE user_id = ? AND used = 0').run(userId);
  db.prepare('INSERT INTO extension_pair_codes (code, user_id, workspace, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)')
    .run(code, userId, workspace, created, expires);
  return { code, expires_at: expires };
}

export async function claimExtensionPairCode(code, username) {
  const db = await getAuthDB();
  const cleanCode = String(code || '').trim().toUpperCase();
  const cleanUsername = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9]{8}$/.test(cleanCode) || !/^[a-z0-9_.]{1,30}$/.test(cleanUsername)) return null;
  const row = db.prepare('SELECT * FROM extension_pair_codes WHERE code = ? AND used = 0 AND expires_at > ?').get(cleanCode, nowIso());
  if (!row) return null;
  const token = newToken();
  const workspace = 'ig_' + cleanUsername;
  const now = nowIso();
  db.prepare('UPDATE extension_pair_codes SET used = 1 WHERE code = ? AND used = 0').run(cleanCode);
  db.prepare('INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, ?)').run(row.user_id, workspace);
  db.prepare('INSERT OR REPLACE INTO extension_devices (token_hash, user_id, workspace, instagram_username, created_at, last_seen_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(hashOpaqueToken(token), row.user_id, workspace, cleanUsername, now, now);
  return { token, workspace, username: cleanUsername };
}

export async function resolveSessionUser(req) {
  const token = readToken(req);
  const user = await getUserByToken(token);
  if (!user) return null;
  if (user.banned) return { banned: true, user };
  return { banned: false, user, token };
}
