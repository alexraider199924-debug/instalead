import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

router.get('/', (req, res) => {
  const totalLeads = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
  const totalCampaigns = db.prepare('SELECT COUNT(*) as cnt FROM campaigns').get().cnt;
  const totalSent = db.prepare("SELECT COUNT(*) as cnt FROM campaign_leads WHERE status = 'sent'").get().cnt;
  const totalFailed = db.prepare("SELECT COUNT(*) as cnt FROM campaign_leads WHERE status = 'failed'").get().cnt;
  const totalPending = db.prepare("SELECT COUNT(*) as cnt FROM campaign_leads WHERE status = 'pending'").get().cnt;

  const campaignStats = db.prepare(`
    SELECT c.id, c.name, c.status, c.created_at,
      COUNT(CASE WHEN cl.status = 'sent' THEN 1 END) as sent,
      COUNT(CASE WHEN cl.status = 'failed' THEN 1 END) as failed,
      COUNT(CASE WHEN cl.status = 'pending' THEN 1 END) as pending,
      COUNT(*) as total
    FROM campaigns c
    LEFT JOIN campaign_leads cl ON cl.campaign_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
    LIMIT 10
  `).all();

  const dailyStats = db.prepare(`
    SELECT date(sent_at) as date, COUNT(*) as sent
    FROM campaign_leads
    WHERE status = 'sent' AND sent_at IS NOT NULL
    GROUP BY date(sent_at)
    ORDER BY date DESC
    LIMIT 14
  `).all();

  res.json({
    overview: { totalLeads, totalCampaigns, totalSent, totalFailed, totalPending },
    campaignStats,
    dailyStats: dailyStats.reverse()
  });
});

export default router;
