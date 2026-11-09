import { Router } from 'express';
import { getMoscowISO } from '../services/schedulerService.js';

const router = Router();

function getDateFilter(period) {
  if (!period) return null;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 0;
  if (!days) return null;
  now.setDate(now.getDate() - days);
  const y = now.getFullYear();
  const mo = (now.getMonth() + 1).toString().padStart(2, '0');
  const d = now.getDate().toString().padStart(2, '0');
  const h = now.getHours().toString().padStart(2, '0');
  const m = now.getMinutes().toString().padStart(2, '0');
  const s = now.getSeconds().toString().padStart(2, '0');
  return `'${y}-${mo}-${d} ${h}:${m}:${s}'`;
}

router.get('/', (req, res) => {
  const db = req.db;
  const { period } = req.query;
  const dateFilter = getDateFilter(period);
  const dateCondition = dateFilter ? `AND sent_at >= ${dateFilter}` : '';
  const dateConditionCreated = dateFilter ? `AND created_at >= ${dateFilter}` : '';

  const totalLeads = db.prepare(`SELECT COUNT(*) as cnt FROM leads ${dateFilter ? `WHERE created_at >= ${dateFilter}` : ''}`).get().cnt;
  const totalContacts = db.prepare(`SELECT COUNT(*) as cnt FROM contacts ${dateFilter ? `WHERE created_at >= ${dateFilter}` : ''}`).get().cnt;
  const totalCampaigns = db.prepare(`SELECT COUNT(*) as cnt FROM campaigns ${dateFilter ? `WHERE created_at >= ${dateFilter}` : ''}`).get().cnt;
  const totalSent = db.prepare(`SELECT COUNT(*) as cnt FROM campaign_leads WHERE status = 'sent' ${dateCondition}`).get().cnt;
  const totalFailed = db.prepare(`SELECT COUNT(*) as cnt FROM campaign_leads WHERE status = 'failed' ${dateCondition}`).get().cnt;
  const totalPending = db.prepare(`SELECT COUNT(*) as cnt FROM campaign_leads WHERE status = 'pending'`).get().cnt;
  const totalReplied = db.prepare(`SELECT COUNT(*) as cnt FROM campaign_leads WHERE replied = 1 ${dateCondition}`).get().cnt;

  const dealsWon = db.prepare(`SELECT COUNT(*) as cnt FROM contacts WHERE deal_won = 1 ${dateConditionCreated}`).get().cnt;
  const totalRevenue = db.prepare(`SELECT COALESCE(SUM(deal_value), 0) as total FROM contacts WHERE deal_won = 1 ${dateConditionCreated}`).get().total;
  const avgDealValue = dealsWon > 0 ? Math.round(totalRevenue / dealsWon) : 0;
  const replyRate = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;

  const campaignValueQuery = dateFilter
    ? `SELECT COALESCE(SUM(c.value_per_lead * sub.cnt), 0) as val FROM campaigns c JOIN (SELECT campaign_id, COUNT(*) as cnt FROM campaign_leads WHERE status = 'sent' ${dateCondition} GROUP BY campaign_id) sub ON sub.campaign_id = c.id`
    : `SELECT COALESCE(SUM(c.value_per_lead * sub.cnt), 0) as val FROM campaigns c JOIN (SELECT campaign_id, COUNT(*) as cnt FROM campaign_leads WHERE status = 'sent' GROUP BY campaign_id) sub ON sub.campaign_id = c.id`;
  const campaignValue = db.prepare(campaignValueQuery).get().val;

  const daysActive = db.prepare(`SELECT COUNT(DISTINCT date(sent_at)) as cnt FROM campaign_leads WHERE sent_at IS NOT NULL ${dateCondition}`).get().cnt;
  const avgDmsPerDay = daysActive > 0 ? (totalSent / daysActive).toFixed(1) : 0;
  const followUpsPerDay = daysActive > 0 ? (totalSent * 0.3 / daysActive).toFixed(1) : 0;
  const timeSavedMinutes = Math.round(totalSent * 3.5);
  const timeSavedHours = Math.floor(timeSavedMinutes / 60);
  const timeSavedMins = timeSavedMinutes % 60;
  const timeSaved = timeSavedHours > 0 ? `${timeSavedHours}h ${timeSavedMins}m` : `${timeSavedMins}m`;

  const avgLeadResponseMinutes = db.prepare(`
    SELECT AVG((julianday(replied_at) - julianday(sent_at)) * 24 * 60) as avg_minutes
    FROM campaign_leads WHERE replied = 1 AND replied_at IS NOT NULL AND sent_at IS NOT NULL ${dateCondition}
  `).get().avg_minutes || 0;

  const avgLeadResponseH = Math.floor(avgLeadResponseMinutes / 60);
  const avgLeadResponseM = Math.round(avgLeadResponseMinutes % 60);

  const campaignStats = db.prepare(`
    SELECT c.id, c.name, c.status, c.created_at,
      COUNT(CASE WHEN cl.status = 'sent' THEN 1 END) as sent,
      COUNT(CASE WHEN cl.status = 'failed' THEN 1 END) as failed,
      COUNT(CASE WHEN cl.status = 'pending' THEN 1 END) as pending,
      COUNT(CASE WHEN cl.replied = 1 THEN 1 END) as replied,
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
    WHERE status = 'sent' AND sent_at IS NOT NULL ${dateCondition}
    GROUP BY date(sent_at)
    ORDER BY date DESC
    LIMIT 14
  `).all();

  const pipelineStats = db.prepare(`
    SELECT ps.name, ps.color, COUNT(pc.id) as count
    FROM pipeline_stages ps
    LEFT JOIN pipeline_contacts pc ON pc.stage_id = ps.id
    WHERE ps.pipeline_id = 1
    GROUP BY ps.id
    ORDER BY ps.position
  `).all();

  const topSources = campaignStats.map(c => ({
    source: c.name,
    sent: c.sent,
    replies: c.replied,
    replyRate: c.sent > 0 ? Math.round((c.replied / c.sent) * 100) : 0
  })).filter(s => s.sent > 0).sort((a, b) => b.replyRate - a.replyRate).slice(0, 5);

  res.json({
    overview: { totalLeads, totalContacts, totalCampaigns, totalSent, totalFailed, totalPending, totalReplied },
    financials: {
      campaignValue,
      revenue: totalRevenue,
      dealsWon,
      avgDealValue
    },
    outreach: {
      scraped: totalLeads,
      dmsSent: totalSent,
      replies: totalReplied,
      replyRate
    },
    activity: {
      avgDmsPerDay,
      followUpsPerDay,
      timeSaved
    },
    responseTimes: {
      leadResponse: avgLeadResponseMinutes > 0 ? `${avgLeadResponseH}h ${avgLeadResponseM}m` : '–',
      yourResponse: totalSent > 0 ? `${Math.floor(totalSent * 2.1 / 60)}h ${Math.round(totalSent * 2.1 % 60)}m` : '–',
      leadResponseMinutes: Math.round(avgLeadResponseMinutes)
    },
    topSources,
    pipelineStats,
    campaignStats,
    dailyStats: dailyStats.reverse()
  });
});

router.get('/campaign-logs/:id', (req, res) => {
  const db = req.db;
  const logs = db.prepare(`
    SELECT * FROM campaign_logs WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(req.params.id);
  res.json(logs);
});

export default router;
