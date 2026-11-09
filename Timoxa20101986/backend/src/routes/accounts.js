import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  const db = req.db;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ig_connected_account'").get();
  const accounts = [];
  if (row && row.value) {
    try {
      const account = JSON.parse(row.value);
      accounts.push(account);
    } catch {
      accounts.push({ username: row.value });
    }
  }
  res.json({ accounts });
});

router.post('/refresh', (req, res) => {
  const db = req.db;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ig_connected_account'").get();
  let account = null;
  if (row && row.value) {
    try {
      account = JSON.parse(row.value);
    } catch {
      account = { username: row.value };
    }
  }
  res.json({ account, refreshed: true });
});

function getWarmupStatus(db) {
  const enabled = db.prepare("SELECT value FROM settings WHERE key = 'warmup_enabled'").get()?.value === '1';
  const startedAt = db.prepare("SELECT value FROM settings WHERE key = 'warmup_started_at'").get()?.value || '';
  const completed = db.prepare("SELECT value FROM settings WHERE key = 'warmup_completed'").get()?.value === '1';

  if (!enabled && completed) {
    return { enabled: false, warmed_up: true, day_number: 21, max_messages: 50, max_follows: 50 };
  }

  if (!enabled || !startedAt) {
    return { enabled: false, warmed_up: false, day_number: 0, max_messages: 50, max_follows: 50 };
  }

  const start = new Date(startedAt);
  const now = new Date();
  const dayNumber = Math.floor((now - start) / (1000 * 60 * 60 * 24)) + 1;

  if (dayNumber > 21) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('warmup_enabled', '0')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('warmup_completed', '1')").run();
    return { enabled: false, warmed_up: true, day_number: 21, max_messages: 50, max_follows: 50 };
  }

  return {
    enabled: true,
    warmed_up: false,
    day_number: dayNumber,
    max_messages: 15,
    max_follows: 15,
    started_at: startedAt,
    days_remaining: 21 - dayNumber
  };
}

router.get('/warmup', (req, res) => {
  const db = req.db;
  res.json(getWarmupStatus(db));
});

router.post('/warmup/toggle', (req, res) => {
  const db = req.db;
  const { enabled } = req.body;

  if (enabled) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('warmup_enabled', '1')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('warmup_started_at', ?)").run(new Date().toISOString());
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('warmup_completed', '0')").run();
  } else {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('warmup_enabled', '0')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('warmup_started_at', '')").run();
  }

  res.json(getWarmupStatus(db));
});

export { getWarmupStatus };
export default router;
