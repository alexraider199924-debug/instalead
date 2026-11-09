import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createDB } from './compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '../../data/instaworm.db');

// Top-level await — routes wait for this before handling requests
const db = await createDB(DB_PATH);

db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    full_name TEXT,
    email TEXT,
    bio TEXT,
    niche TEXT,
    notes TEXT,
    status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    message_template TEXT NOT NULL,
    ai_provider TEXT DEFAULT 'claude',
    ai_generated INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    scheduled_at TEXT,
    delay_seconds INTEGER DEFAULT 30,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaign_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    message_sent TEXT,
    sent_at TEXT,
    error_message TEXT,
    UNIQUE(campaign_id, lead_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES ('anthropic_api_key', '');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('openai_api_key', '');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('default_ai_provider', 'claude');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('app_name', 'InstaWorm');
`);

export default db;
