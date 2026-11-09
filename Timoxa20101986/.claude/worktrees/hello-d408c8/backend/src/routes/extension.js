import { Router } from 'express';
import db from '../db/schema.js';
import { completeCampaign } from '../services/schedulerService.js';

const router = Router();

// Extension polls this to get next lead to message
router.get('/queue', (req, res) => {
  const running = db.prepare(`
    SELECT c.*, cl.id as cl_id, cl.lead_id,
      l.username, l.full_name, l.niche,
      COALESCE(cl.message_sent, c.message_template) as final_message,
      c.delay_seconds
    FROM campaigns c
    JOIN campaign_leads cl ON cl.campaign_id = c.id
    JOIN leads l ON l.id = cl.lead_id
    WHERE c.status = 'running' AND cl.status = 'pending'
    ORDER BY c.id ASC, cl.id ASC
    LIMIT 1
  `).get();

  if (!running) {
    return res.json({ item: null, message: 'Нет активных задач' });
  }

  res.json({
    item: {
      cl_id: running.cl_id,
      campaign_id: running.id,
      campaign_name: running.name,
      lead_id: running.lead_id,
      username: running.username,
      full_name: running.full_name,
      message: running.final_message,
      delay_seconds: running.delay_seconds
    }
  });
});

// Extension reports message sent successfully
router.post('/confirm/:cl_id', (req, res) => {
  const { message } = req.body;
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(req.params.cl_id);
  if (!cl) return res.status(404).json({ error: 'Не найдено' });

  db.prepare(`
    UPDATE campaign_leads
    SET status = 'sent', sent_at = datetime('now'), message_sent = COALESCE(?, message_sent)
    WHERE id = ?
  `).run(message || null, req.params.cl_id);

  completeCampaign(cl.campaign_id);
  res.json({ success: true });
});

// Extension reports failure
router.post('/fail/:cl_id', (req, res) => {
  const { error_message } = req.body;
  const cl = db.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(req.params.cl_id);
  if (!cl) return res.status(404).json({ error: 'Не найдено' });

  db.prepare(`
    UPDATE campaign_leads SET status = 'failed', error_message = ? WHERE id = ?
  `).run(error_message || 'Неизвестная ошибка', req.params.cl_id);

  res.json({ success: true });
});

// Store / retrieve connected Instagram account
router.post('/account', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ig_connected_account', ?)`).run(username);
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ig_connected_at', ?)`).run(new Date().toISOString());
  res.json({ success: true, username });
});

router.get('/account', (req, res) => {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ig_connected_account'`).get();
  const atRow = db.prepare(`SELECT value FROM settings WHERE key = 'ig_connected_at'`).get();
  res.json({ username: row?.value || null, connected_at: atRow?.value || null });
});

// Extension gets its config / status
router.get('/status', (req, res) => {
  const runningCampaigns = db.prepare(`
    SELECT c.id, c.name, c.status,
      COUNT(CASE WHEN cl.status = 'pending' THEN 1 END) as pending,
      COUNT(CASE WHEN cl.status = 'sent' THEN 1 END) as sent
    FROM campaigns c
    JOIN campaign_leads cl ON cl.campaign_id = c.id
    WHERE c.status = 'running'
    GROUP BY c.id
  `).all();

  res.json({
    running_campaigns: runningCampaigns,
    total_pending: runningCampaigns.reduce((s, c) => s + c.pending, 0)
  });
});

export default router;
