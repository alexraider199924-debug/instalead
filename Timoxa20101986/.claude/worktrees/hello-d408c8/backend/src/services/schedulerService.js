import cron from 'node-cron';
import db from '../db/schema.js';

const activeTasks = new Map();

export function startScheduler() {
  cron.schedule('* * * * *', () => {
    checkScheduledCampaigns();
  });
  console.log('[Scheduler] Started');
}

function checkScheduledCampaigns() {
  const now = new Date().toISOString();
  const campaigns = db.prepare(`
    SELECT * FROM campaigns
    WHERE status = 'scheduled' AND scheduled_at <= ?
  `).all(now);

  for (const campaign of campaigns) {
    activateCampaign(campaign.id);
  }
}

export function activateCampaign(campaignId) {
  db.prepare(`UPDATE campaigns SET status = 'running', updated_at = datetime('now') WHERE id = ?`)
    .run(campaignId);
  console.log(`[Scheduler] Campaign ${campaignId} is now running`);
}

export function pauseCampaign(campaignId) {
  db.prepare(`UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?`)
    .run(campaignId);
}

export function completeCampaign(campaignId) {
  const pending = db.prepare(`
    SELECT COUNT(*) as cnt FROM campaign_leads WHERE campaign_id = ? AND status = 'pending'
  `).get(campaignId);
  if (pending.cnt === 0) {
    db.prepare(`UPDATE campaigns SET status = 'completed', updated_at = datetime('now') WHERE id = ?`)
      .run(campaignId);
  }
}
