import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  // Mask API keys
  if (settings.anthropic_api_key) settings.anthropic_api_key = settings.anthropic_api_key ? '***masked***' : '';
  if (settings.openai_api_key) settings.openai_api_key = settings.openai_api_key ? '***masked***' : '';
  res.json(settings);
});

router.put('/', (req, res) => {
  const allowed = ['anthropic_api_key', 'openai_api_key', 'default_ai_provider', 'app_name'];
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  db.transaction(() => {
    for (const key of allowed) {
      if (req.body[key] !== undefined && req.body[key] !== '***masked***') {
        update.run(key, req.body[key]);
      }
    }
  })();

  res.json({ success: true });
});

router.get('/check-keys', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)').all('anthropic_api_key', 'openai_api_key');
  const result = Object.fromEntries(rows.map(r => [r.key, !!r.value]));
  res.json(result);
});

export default router;
