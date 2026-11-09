import { Router } from 'express';
import db from '../db/schema.js';
import { activateCampaign, pauseCampaign } from '../services/schedulerService.js';

const router = Router();

router.get('/', (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id) as total_leads,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'sent') as sent_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'pending') as pending_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'failed') as failed_count
    FROM campaigns c ORDER BY c.created_at DESC
  `).all();
  res.json(campaigns);
});

router.get('/:id', (req, res) => {
  const campaign = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id) as total_leads,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'sent') as sent_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'pending') as pending_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'failed') as failed_count
    FROM campaigns c WHERE c.id = ?
  `).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });
  res.json(campaign);
});

router.post('/', (req, res) => {
  const { name, message_template, ai_provider, ai_generated, scheduled_at, delay_seconds, lead_ids } = req.body;
  if (!name || !message_template) return res.status(400).json({ error: 'name и message_template обязательны' });

  const result = db.prepare(`
    INSERT INTO campaigns (name, message_template, ai_provider, ai_generated, scheduled_at, delay_seconds, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, message_template, ai_provider || 'claude', ai_generated ? 1 : 0, scheduled_at || null, delay_seconds || 30, scheduled_at ? 'scheduled' : 'draft');

  const campaignId = result.lastInsertRowid;

  if (lead_ids?.length) {
    const insertLead = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)');
    db.transaction(() => lead_ids.forEach(lid => insertLead.run(campaignId, lid)))();
  }

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  res.status(201).json(campaign);
});

router.put('/:id', (req, res) => {
  const { name, message_template, ai_provider, ai_generated, scheduled_at, delay_seconds, status } = req.body;
  db.prepare(`
    UPDATE campaigns SET name=?, message_template=?, ai_provider=?, ai_generated=?, scheduled_at=?, delay_seconds=?, status=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name, message_template, ai_provider, ai_generated ? 1 : 0, scheduled_at, delay_seconds, status, req.params.id);
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  res.json(campaign);
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/start', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });
  activateCampaign(campaign.id);
  res.json({ success: true, status: 'running' });
});

router.post('/:id/pause', (req, res) => {
  pauseCampaign(req.params.id);
  res.json({ success: true, status: 'paused' });
});

router.post('/:id/schedule', (req, res) => {
  const { scheduled_at } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at обязателен' });
  db.prepare(`UPDATE campaigns SET scheduled_at=?, status='scheduled', updated_at=datetime('now') WHERE id=?`)
    .run(scheduled_at, req.params.id);
  res.json({ success: true, scheduled_at });
});

router.get('/:id/leads', (req, res) => {
  const leads = db.prepare(`
    SELECT l.*, cl.status as campaign_status, cl.sent_at, cl.message_sent, cl.id as cl_id
    FROM campaign_leads cl
    JOIN leads l ON l.id = cl.lead_id
    WHERE cl.campaign_id = ?
    ORDER BY cl.id ASC
  `).all(req.params.id);
  res.json(leads);
});

router.post('/:id/leads', (req, res) => {
  const { lead_ids } = req.body;
  if (!lead_ids?.length) return res.status(400).json({ error: 'lead_ids обязательны' });
  const insert = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)');
  db.transaction(() => lead_ids.forEach(lid => insert.run(req.params.id, lid)))();
  res.json({ success: true, added: lead_ids.length });
});

router.delete('/:id/leads/:leadId', (req, res) => {
  db.prepare('DELETE FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').run(req.params.id, req.params.leadId);
  res.json({ success: true });
});

export default router;
