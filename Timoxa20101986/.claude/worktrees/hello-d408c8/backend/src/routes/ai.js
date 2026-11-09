import { Router } from 'express';
import { generateMessage } from '../services/aiService.js';
import db from '../db/schema.js';

const router = Router();

router.post('/generate', async (req, res) => {
  try {
    const { provider, prompt, lead_id, template } = req.body;
    if (!template) return res.status(400).json({ error: 'template обязателен' });

    let lead = { username: '', full_name: '', niche: '' };
    if (lead_id) {
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead_id) || lead;
    }

    const message = await generateMessage({ provider, prompt, lead, template });
    res.json({ message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/generate-bulk', async (req, res) => {
  try {
    const { provider, template, campaign_id } = req.body;
    if (!template || !campaign_id) return res.status(400).json({ error: 'template и campaign_id обязательны' });

    const pendingLeads = db.prepare(`
      SELECT l.*, cl.id as cl_id FROM campaign_leads cl
      JOIN leads l ON l.id = cl.lead_id
      WHERE cl.campaign_id = ? AND cl.status = 'pending' AND cl.message_sent IS NULL
    `).all(campaign_id);

    const results = [];
    for (const lead of pendingLeads) {
      try {
        const message = await generateMessage({ provider, lead, template });
        db.prepare(`UPDATE campaign_leads SET message_sent = ? WHERE id = ?`).run(message, lead.cl_id);
        results.push({ lead_id: lead.id, username: lead.username, message, success: true });
      } catch (e) {
        results.push({ lead_id: lead.id, username: lead.username, error: e.message, success: false });
      }
    }
    res.json({ results, total: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
