import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createDB } from './compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR must point to persistent storage in production deployments. Keep the
// historical backend/data default for local development and existing installs.
const DATA_DIR = process.env.INSTALEAD_DATA_DIR
  ? resolve(process.env.INSTALEAD_DATA_DIR)
  : join(__dirname, '../../data');
const AUTH_DB_PATH = join(DATA_DIR, 'users.db');

let authDb = null;

export async function getAuthDB() {
  if (authDb) return authDb;
  authDb = await createDB(AUTH_DB_PATH);
  authDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      banned INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 1,
      workspace TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS user_workspaces (
      user_id INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      PRIMARY KEY (user_id, workspace),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_uw_workspace ON user_workspaces(workspace);
    CREATE TABLE IF NOT EXISTS extension_pair_codes (
      code TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS extension_devices (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      instagram_username TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_extension_devices_user ON extension_devices(user_id);

    -- Telegram control. One bot serves every tenant, so a chat is worthless
    -- until it is bound to a workspace: the link code is minted in the web UI
    -- by an already-authenticated user, which is what carries the identity.
    CREATE TABLE IF NOT EXISTS telegram_link_codes (
      code TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS telegram_links (
      telegram_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      username TEXT,
      linked_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tg_links_workspace ON telegram_links(workspace);
    CREATE INDEX IF NOT EXISTS idx_tg_links_user ON telegram_links(user_id);
  `);
  try { authDb.exec('ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1'); } catch (e) {
    if (!/duplicate column name/i.test(e.message || '')) throw e;
  }
  return authDb;
}
