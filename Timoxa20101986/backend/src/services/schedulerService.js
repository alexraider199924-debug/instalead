import cron from 'node-cron';
import { getAllWorkspaceDBs } from '../db/workspaceManager.js';
import { notify, escHtml } from './notifier.js';

const activeTasks = new Map();

export function startScheduler() {
  runForAllWorkspaces();

  cron.schedule('* * * * *', () => {
    runForAllWorkspaces();
  });

  console.log(`[Scheduler] Started. Moscow time: ${getMoscowTimeStr()}, day: ${getMoscowDayKey()}`);
}

function runForAllWorkspaces() {
  const dbs = getAllWorkspaceDBs();
  for (const [name, db] of dbs) {
    try {
      checkScheduledCampaigns(db);
      manageWorkingHours(db);
    } catch (e) {
      console.error(`[Scheduler] Error in workspace "${name}":`, e.message);
    }
  }
}

function getMoscowTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
}

function getMoscowDayKey() {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return days[getMoscowTime().getDay()];
}

function getMoscowTimeStr() {
  const mt = getMoscowTime();
  const h = mt.getHours().toString().padStart(2, '0');
  const m = mt.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

export function getMoscowISO() {
  const mt = getMoscowTime();
  const y = mt.getFullYear();
  const mo = (mt.getMonth() + 1).toString().padStart(2, '0');
  const d = mt.getDate().toString().padStart(2, '0');
  const h = mt.getHours().toString().padStart(2, '0');
  const m = mt.getMinutes().toString().padStart(2, '0');
  const s = mt.getSeconds().toString().padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${m}:${s}`;
}

function isWithinWorkingHours(campaign) {
  const currentDay = getMoscowDayKey();
  const currentTime = getMoscowTimeStr();

  const scheduleDays = (campaign.schedule_days || 'mon,tue,wed,thu,fri').split(',');
  if (!scheduleDays.includes(currentDay)) return false;

  const start = campaign.schedule_start || '09:00';
  const end = campaign.schedule_end || '18:00';
  return currentTime >= start && currentTime <= end;
}

function getNextWorkingWindow(campaign) {
  const scheduleDays = (campaign.schedule_days || 'mon,tue,wed,thu,fri').split(',');
  const start = campaign.schedule_start || '09:00';
  const dayOrder = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  const now = getMoscowTime();
  const currentDay = getMoscowDayKey();
  const currentTime = getMoscowTimeStr();
  const todayIdx = dayOrder.indexOf(currentDay);

  if (scheduleDays.includes(currentDay) && currentTime < start) {
    const [sh, sm] = start.split(':').map(Number);
    const target = new Date(now);
    target.setHours(sh, sm, 0, 0);
    return target;
  }

  for (let offset = 1; offset <= 7; offset++) {
    const idx = (todayIdx + offset) % 7;
    const dayKey = dayOrder[idx];
    if (scheduleDays.includes(dayKey)) {
      const target = new Date(now);
      target.setDate(target.getDate() + offset);
      const [sh, sm] = start.split(':').map(Number);
      target.setHours(sh, sm, 0, 0);
      return target;
    }
  }
  return null;
}

function checkScheduledCampaigns(db) {
  const now = new Date().toISOString();
  const campaigns = db.prepare(`
    SELECT * FROM campaigns
    WHERE status = 'scheduled' AND scheduled_at <= ?
  `).all(now);

  for (const campaign of campaigns) {
    if (isWithinWorkingHours(campaign)) {
      console.log(`[Scheduler] Activating scheduled campaign ${campaign.id} "${campaign.name}"`);
      activateCampaign(db, campaign.id);
    }
  }
}

function manageWorkingHours(db) {
  const time = getMoscowTimeStr();
  const day = getMoscowDayKey();

  const runningCampaigns = db.prepare(`
    SELECT * FROM campaigns WHERE status = 'running'
  `).all();

  for (const campaign of runningCampaigns) {
    if (!isWithinWorkingHours(campaign)) {
      const updatedAt = campaign.updated_at || '';
      const updatedMs = new Date(updatedAt).getTime();
      const nowMs = Date.now();
      if (nowMs - updatedMs < 120000) {
        continue;
      }

      const nextWindow = getNextWorkingWindow(campaign);
      const nextStr = nextWindow ? nextWindow.toLocaleString('ru', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

      console.log(`[Scheduler] Campaign ${campaign.id} "${campaign.name}" outside working hours (${day} ${time}), auto-pausing. Next: ${nextStr}`);
      db.prepare(`UPDATE campaigns SET status = 'paused_by_schedule', updated_at = ? WHERE id = ?`).run(getMoscowISO(), campaign.id);
      logCampaignEvent(db, campaign.id, 'auto_paused', `Автопауза: вне рабочих часов (${day} ${time} МСК). Следующее окно: ${nextStr}`);
    }
  }

  const pausedCampaigns = db.prepare(`
    SELECT * FROM campaigns WHERE status = 'paused_by_schedule'
  `).all();

  for (const campaign of pausedCampaigns) {
    if (isWithinWorkingHours(campaign)) {
      // 'followed' leads are mid-prewarm — followed but awaiting their DM — so
      // they keep the campaign alive just like 'pending'/'sending' ones.
      const pending = db.prepare(`
        SELECT COUNT(*) as cnt FROM campaign_leads WHERE campaign_id = ? AND status IN ('pending','sending','followed')
      `).get(campaign.id);

      if (pending.cnt === 0) {
        db.prepare(`UPDATE campaigns SET status = 'completed', updated_at = ? WHERE id = ?`).run(getMoscowISO(), campaign.id);
        logCampaignEvent(db, campaign.id, 'completed', 'Кампания завершена — все лиды обработаны');
        console.log(`[Scheduler] Campaign ${campaign.id} completed (no pending leads)`);
        continue;
      }

      console.log(`[Scheduler] Resuming campaign ${campaign.id} "${campaign.name}" — working hours started (${day} ${time}), ${pending.cnt} leads pending`);
      db.prepare(`UPDATE campaigns SET status = 'running', updated_at = ? WHERE id = ?`).run(getMoscowISO(), campaign.id);
      logCampaignEvent(db, campaign.id, 'auto_resumed', `Автовозобновление: рабочие часы начались (${day} ${time} МСК). Осталось ${pending.cnt} лидов.`);
    }
  }
}

export function activateCampaign(db, campaignId) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!c) return;

  if (!c.started_at) {
    db.prepare(`UPDATE campaigns SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`).run(getMoscowISO(), getMoscowISO(), campaignId);
  } else {
    db.prepare(`UPDATE campaigns SET status = 'running', updated_at = ? WHERE id = ?`).run(getMoscowISO(), campaignId);
  }
  logCampaignEvent(db, campaignId, 'started', 'Кампания запущена');
  console.log(`[Scheduler] Campaign ${campaignId} "${c.name}" is now running`);
}

export function pauseCampaign(db, campaignId) {
  const c = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId);
  if (!c || c.status === 'completed') return;
  const prevStatus = c.status;
  db.prepare(`UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ?`)
    .run(getMoscowISO(), campaignId);
  logCampaignEvent(db, campaignId, 'paused', `Кампания приостановлена вручную (было: ${prevStatus})`);
}

export function completeCampaign(db, campaignId) {
  // 'followed' = prewarm leads that are followed but still owe a DM, so they
  // must block completion; otherwise the campaign would finish the moment its
  // last lead is followed and never send those DMs.
  const pending = db.prepare(`
    SELECT COUNT(*) as cnt FROM campaign_leads WHERE campaign_id = ? AND status IN ('pending','sending','followed')
  `).get(campaignId);
  if (pending.cnt === 0) {
    const campaign = db.prepare('SELECT name FROM campaigns WHERE id = ?').get(campaignId);
    const sent = db.prepare("SELECT COUNT(*) as c FROM campaign_leads WHERE campaign_id = ? AND status = 'sent'").get(campaignId)?.c || 0;
    const replied = db.prepare("SELECT COUNT(*) as c FROM campaign_leads WHERE campaign_id = ? AND replied = 1").get(campaignId)?.c || 0;
    db.prepare(`UPDATE campaigns SET status = 'completed', updated_at = ? WHERE id = ?`)
      .run(getMoscowISO(), campaignId);
    logCampaignEvent(db, campaignId, 'completed', 'Кампания завершена — все лиды обработаны');

    notify(
      db.workspaceName,
      `✅ <b>Кампания завершена</b>

<b>${escHtml(campaign?.name || '#' + campaignId)}</b>
` +
      `Отправлено: <b>${sent}</b>
Ответили: <b>${replied}</b>` +
      (sent ? ` (${Math.round(replied / sent * 100)}%)` : ''),
      { key: `campaign-done:${campaignId}` }
    ).catch(() => {});
  }
}

export function logCampaignEvent(db, campaignId, event, details) {
  try {
    db.prepare('INSERT INTO campaign_logs (campaign_id, event, details, created_at) VALUES (?, ?, ?, ?)')
      .run(campaignId, event, details || null, getMoscowISO());
  } catch (e) {
    console.error('[Scheduler] Log error:', e.message);
  }
}

export function isCampaignInWorkingHours(db, campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return false;
  return isWithinWorkingHours(campaign);
}

export function getCampaignScheduleInfo(db, campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return null;

  const inHours = isWithinWorkingHours(campaign);
  const nextWindow = inHours ? null : getNextWorkingWindow(campaign);

  return {
    in_working_hours: inHours,
    current_time_msk: getMoscowTimeStr(),
    current_day: getMoscowDayKey(),
    next_window: nextWindow ? nextWindow.toISOString() : null,
    schedule_start: campaign.schedule_start || '09:00',
    schedule_end: campaign.schedule_end || '18:00',
    schedule_days: campaign.schedule_days || 'mon,tue,wed,thu,fri',
  };
}
