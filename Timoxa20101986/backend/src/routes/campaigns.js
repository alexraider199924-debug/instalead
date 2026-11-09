import { Router } from 'express';
import { activateCampaign, pauseCampaign, logCampaignEvent, getCampaignScheduleInfo, getMoscowISO } from '../services/schedulerService.js';
import { missingRequiredFields } from '../services/offerContext.js';
import { generatePersonalizedMessage, getAgentVersion, getSummaryVersion } from '../services/personalizationEngine.js';
import { ENRICH_VERSION, summaryContentHash } from '../services/contactEnrichService.js';
import { prepareOutboundMessage, expandSpintax } from '../services/messageText.js';
import { parseFirstName } from '../services/nameParser.js';

const router = Router();

router.get('/', (req, res) => {
  const db = req.db;
  const { archived } = req.query;
  const archivedFilter = archived === '1' ? 'AND c.archived = 1' : 'AND (c.archived = 0 OR c.archived IS NULL)';
  const campaigns = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id) as total_leads,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status IN ('sent','sending')) as sent_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'pending') as pending_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status IN ('failed','skipped')) as failed_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'skipped') as skipped_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'followed') as followed_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND replied = 1) as replied_count
    FROM campaigns c WHERE 1=1 ${archivedFilter} ORDER BY c.created_at DESC
  `).all();

  const enriched = campaigns.map(c => {
    const nextLead = db.prepare(`
      SELECT l.username FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
      WHERE cl.campaign_id = ? AND cl.status = 'pending' ORDER BY cl.id ASC LIMIT 1
    `).get(c.id);

    const rawStats = db.prepare(`
      SELECT date(sent_at) as date,
        COUNT(CASE WHEN status IN ('sent','sending') THEN 1 END) as sent,
        COUNT(CASE WHEN replied = 1 THEN 1 END) as replied,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as skipped
      FROM campaign_leads WHERE campaign_id = ? AND sent_at IS NOT NULL
      GROUP BY date(sent_at) ORDER BY date ASC
    `).all(c.id);

    const statsMap = {};
    for (const r of rawStats) statsMap[r.date] = r;

    const startDate = (c.started_at || c.created_at || '').slice(0, 10);
    const todayStr = getMoscowISO().slice(0, 10);

    const dailyStats = [];
    if (startDate && startDate <= todayStr) {
      let cursor = startDate;
      while (cursor <= todayStr) {
        dailyStats.push(statsMap[cursor] || { date: cursor, sent: 0, replied: 0, skipped: 0 });
        const [y, m, dd] = cursor.split('-').map(Number);
        const next = new Date(Date.UTC(y, m - 1, dd + 1));
        cursor = next.toISOString().slice(0, 10);
      }
    } else {
      dailyStats.push(...rawStats);
    }

    const scheduleInfo = getCampaignScheduleInfo(db, c.id);

    return {
      ...c,
      next_username: nextLead?.username || null,
      daily_stats: dailyStats,
      campaign_value: Math.round((c.value_per_lead || 0) * c.sent_count),
      schedule_info: scheduleInfo,
    };
  });

  res.json(enriched);
});

router.get('/prompts/saved', (req, res) => {
  const db = req.db;
  const templates = db.prepare('SELECT * FROM ai_prompt_templates ORDER BY created_at DESC').all();
  const fromCampaigns = db.prepare(`
    SELECT DISTINCT ai_prompt FROM campaigns
    WHERE ai_prompt IS NOT NULL AND ai_prompt != ''
    ORDER BY created_at DESC LIMIT 20
  `).all();
  res.json({ templates, from_campaigns: fromCampaigns.map(r => r.ai_prompt) });
});

router.post('/prompts/saved', (req, res) => {
  const db = req.db;
  const { name, prompt } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name and prompt required' });
  const result = db.prepare('INSERT INTO ai_prompt_templates (name, prompt) VALUES (?, ?)').run(name, prompt);
  const template = db.prepare('SELECT * FROM ai_prompt_templates WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(template);
});

router.delete('/prompts/saved/:promptId', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM ai_prompt_templates WHERE id = ?').run(req.params.promptId);
  res.json({ success: true });
});

router.post('/:id/archive', (req, res) => {
  const db = req.db;
  db.prepare('UPDATE campaigns SET archived = 1, updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
  logCampaignEvent(db, req.params.id, 'archived', 'Кампания перемещена в архив');
  res.json({ success: true });
});

router.post('/:id/unarchive', (req, res) => {
  const db = req.db;
  db.prepare('UPDATE campaigns SET archived = 0, updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
  logCampaignEvent(db, req.params.id, 'unarchived', 'Кампания восстановлена из архива');
  res.json({ success: true });
});

router.post('/:id/restart', (req, res) => {
  const db = req.db;
  db.prepare('UPDATE campaign_leads SET status = \'pending\', sent_at = NULL, message_sent = NULL, error_message = NULL, replied = 0, reply_text = NULL, replied_at = NULL WHERE campaign_id = ? AND status = \'failed\'').run(req.params.id);
  db.prepare('UPDATE campaigns SET status = \'draft\', updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
  logCampaignEvent(db, req.params.id, 'restarted', 'Кампания перезапущена');
  res.json({ success: true });
});

router.get('/:id', (req, res) => {
  const db = req.db;
  const campaign = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id) as total_leads,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status IN ('sent','sending')) as sent_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'pending') as pending_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status IN ('failed','skipped')) as failed_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'skipped') as skipped_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND status = 'followed') as followed_count,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND replied = 1) as replied_count
    FROM campaigns c WHERE c.id = ?
  `).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });

  // Calculate per-offer analytics using offer_num
  const offersStats = {};
  if (campaign.offers) {
    try {
      const offersArray = JSON.parse(campaign.offers);
      offersArray.forEach((offerText, idx) => {
        const offerNum = idx + 1;
        const stats = db.prepare(`
          SELECT
            COUNT(CASE WHEN status IN ('sent','sending') THEN 1 END) as sent,
            COUNT(CASE WHEN replied = 1 THEN 1 END) as replied
          FROM campaign_leads
          WHERE campaign_id = ? AND offer_num = ?
        `).get(req.params.id, offerNum);

        offersStats[offerNum] = {
          text: offerText.substring(0, 100),
          sent: stats?.sent || 0,
          replied: stats?.replied || 0,
          rate: (stats?.sent || 0) > 0 ? Math.round(((stats?.replied || 0) / (stats?.sent || 0)) * 100) : 0
        };
      });
    } catch (e) {}
  }

  res.json({ ...campaign, offers_stats: offersStats });
});

router.post('/preview-message', async (req, res) => {
  const db = req.db;
  // Keep the request field name separate from the internal variable. Older
  // preview builds accidentally referenced `messageTemplate` out of scope,
  // which surfaced as a ReferenceError when clicking Random lead.
  try {
    const {
      contact_id,
      message_template: messageTemplateInput = '',
      personalization_mode = 'personalized',
      personalization_style = 'neutral',
      personalization_custom_prompt = ''
    } = req.body || {};

    if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });

    const contact = db.prepare(`
      SELECT c.*, l.id AS lead_id, l.username AS lead_username, l.full_name AS lead_full_name,
        l.bio AS lead_bio, l.niche, l.profile_summary, l.profile_summary_meta
      FROM contacts c
      LEFT JOIN leads l ON LOWER(TRIM(l.username)) = LOWER(TRIM(c.username))
      WHERE c.id = ?
      LIMIT 1
    `).get(contact_id);
    if (!contact) return res.status(404).json({ error: 'Контакт не найден' });

    const username = String(contact.username || contact.lead_username || '').trim();
    const contactName = String(contact.full_name || '').trim();
    const contactFirstName = parseFirstName(contactName, '');
    if (!username) return res.status(400).json({ error: 'У контакта отсутствует username' });

    if (personalization_mode !== 'personalized') {
      const text = prepareOutboundMessage(messageTemplateInput, contactFirstName);
      return res.json({
        message: text,
        exact_send_preview: true,
        lead: { contact_id: Number(contact_id), username, full_name: contactName }
      });
    }

    const agentContext = db.prepare('SELECT field, value FROM ai_business_context').all();
    const missing = missingRequiredFields(agentContext);
    const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'openrouter_api_key'").get();
    if (!String(apiKey?.value || '').trim() || missing.length) {
      return res.status(400).json({ error: 'Нельзя создать превью. Сначала завершите настройку AI Agent.', missing_fields: missing });
    }

    if (!String(contact.profile_summary || '').trim()) {
      return res.status(400).json({ error: 'Сначала необходимо создать конспект лида.' });
    }
    const summaryVersion = getSummaryVersion({ profile_summary: contact.profile_summary, profile_summary_meta: contact.profile_summary_meta });
    if (summaryVersion !== ENRICH_VERSION) {
      return res.status(409).json({ error: 'Конспект лида устарел. Сначала пересоздайте конспект.' });
    }

    let profileSummaryMeta = {};
    try { profileSummaryMeta = JSON.parse(contact.profile_summary_meta || '{}') || {}; } catch {}
    const hooks = Array.isArray(profileSummaryMeta.hooks) ? profileSummaryMeta.hooks : [];
    const currentSummaryHash = String(profileSummaryMeta.content_hash || summaryContentHash(contact.profile_summary || '', hooks));
    const agentVersion = getAgentVersion(agentContext);

    const generation = await generatePersonalizedMessage(db, {
      messageTemplate: messageTemplateInput,
      lead: {
        username,
        contact_name: contactName,
        full_name: contactName,
        bio: contact.lead_bio || contact.details || '',
        niche: contact.niche,
        profile_summary: contact.profile_summary,
        profile_summary_meta: contact.profile_summary_meta
      },
      profileData: {
        bio: contact.lead_bio || contact.details || '',
        posts: []
      },
      agentContext,
      style: personalization_style === 'custom' ? 'custom' : (personalization_style || 'neutral'),
      customPrompt: personalization_custom_prompt || '',
      extraInstruction: 'This is a campaign review preview. Generate the exact DM payload that would be eligible for sending; do not describe the preview.'
    });

    let message = collapsePreviewWhitespace(generation.final_message);
    const sampleVariation = String(agentContext.find(r => r.field === 'sample_message_variation')?.value || '').trim();
    if (sampleVariation === 'spintax') message = expandSpintax(message);
    message = prepareOutboundMessage(message, contactFirstName);

    const personalization = {
      summary_version: summaryVersion,
      ai_agent_version: agentVersion,
      summary_hash: currentSummaryHash,
      personalization_hook: String(generation.personalization_hook || '').trim(),
      relevant_problem: String(generation.relevant_problem || '').trim(),
      offer_angle: String(generation.offer_angle || '').trim(),
      cta: String(generation.cta || '').trim()
    };

    res.json({
      message,
      exact_send_preview: true,
      lead: { contact_id: Number(contact_id), lead_id: contact.lead_id || null, username, full_name: contactName },
      personalization
    });
  } catch (e) {
    console.error('[CampaignPreview] Error:', e.message);
    res.status(500).json({ error: e.message || 'Не удалось создать превью' });
  }
});

function collapsePreviewWhitespace(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    .map(line => line.replace(/[ \t\u00a0]{2,}/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

router.post('/', (req, res) => {
  const db = req.db;
  const { name, message_template, offers, ai_generated, ai_prompt, personalization_mode, personalization_style, personalization_custom_prompt, scheduled_at, delay_seconds, lead_ids, contact_ids, daily_limit, send_time, min_delay, max_delay, follow_profile, wait_for_reply, value_per_lead, schedule_days, schedule_start, schedule_end, skip_contacted, stop_on_reply, pause_unsafe, safe_delays, warmup, like_last_post, prewarm_follow, prewarm_delay_hours, use_smart_personalization, preview_contact_id, preview_message, preview_personalization } = req.body;

  const personalizationEnabled = personalization_mode === 'personalized';
  let offersArray = [];
  if (offers && Array.isArray(offers) && offers.length > 0) {
    // Campaigns support one offer only; ignore any legacy extra entries.
    offersArray = offers.filter(o => o && typeof o === 'string' && o.trim()).slice(0, 1);
  } else if (message_template) {
    offersArray = [message_template];
  }

  if (!name) return res.status(400).json({ error: 'Название обязательно' });

  if (personalizationEnabled) {
    // The AI Agent is the single source of truth for the offer when
    // personalization is enabled. A campaign must not ask the user to
    // duplicate the same offer here.
    const agentContext = db.prepare('SELECT field, value FROM ai_business_context').all();
    const missing = missingRequiredFields(agentContext);
    const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'openrouter_api_key'").get();
    if (!String(apiKey?.value || '').trim() || missing.length) {
      return res.status(400).json({
        error: 'Нельзя включить персонализацию. Сначала завершите настройку AI Agent.',
        missing_fields: missing
      });
    }
    offersArray = [];
  } else if (!offersArray.length) {
    return res.status(400).json({ error: 'Добавьте оффер для сообщения' });
  }

  const result = db.prepare(`
    INSERT INTO campaigns (name, message_template, offers, ai_generated, ai_prompt, personalization_mode, personalization_style, personalization_custom_prompt, scheduled_at, delay_seconds, status, daily_limit, send_time, min_delay, max_delay, follow_profile, wait_for_reply, value_per_lead, schedule_days, schedule_start, schedule_end, skip_contacted, stop_on_reply, pause_unsafe, safe_delays, warmup, like_last_post, prewarm_follow, prewarm_delay_hours, use_smart_personalization)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, personalizationEnabled ? '' : offersArray[0], JSON.stringify(offersArray), personalizationEnabled ? 1 : (ai_generated ? 1 : 0), ai_prompt || null,
    personalization_mode || 'template', personalization_style || 'neutral', personalization_custom_prompt || null,
    scheduled_at || null, delay_seconds || 30, scheduled_at ? 'scheduled' : 'draft',
    daily_limit || 15, send_time || null, min_delay || 7, max_delay || 17,
    follow_profile ?? 1, wait_for_reply ?? 1, value_per_lead || 0,
    schedule_days || 'mon,tue,wed,thu,fri', schedule_start || '09:00', schedule_end || '18:00',
    skip_contacted ? 1 : 0, stop_on_reply ? 1 : 0, pause_unsafe ? 1 : 0, safe_delays ? 1 : 0, warmup ? 1 : 0,
    like_last_post ? 1 : 0,
    prewarm_follow ? 1 : 0, prewarm_delay_hours || 24, use_smart_personalization ? 1 : 0
  );

  const campaignId = result.lastInsertRowid;

  let resolvedLeadIds = lead_ids || [];
  if (contact_ids?.length) {
    resolvedLeadIds = [];
    for (const cid of contact_ids) {
      const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
      if (!contact) continue;
      const cleanUsername = (contact.username || '').trim();
      if (!cleanUsername) continue;
      let lead = db.prepare('SELECT id FROM leads WHERE username = ?').get(cleanUsername);
      if (!lead) {
        const r = db.prepare('INSERT INTO leads (username, full_name, email, bio, niche, status) VALUES (?, ?, ?, ?, ?, ?)').run(
          cleanUsername, contact.full_name || null, contact.email || null, null, null, 'new'
        );
        lead = { id: r.lastInsertRowid };
      }
      resolvedLeadIds.push(lead.id);
    }
  }

  if (resolvedLeadIds.length) {
    const insertLead = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, offer_num) VALUES (?, ?, ?)');
    db.transaction(() => resolvedLeadIds.forEach(lid => insertLead.run(campaignId, lid, 1)))();
  }

  // If the user previewed a specific lead in Review, persist that exact server-generated
  // payload for this campaign lead so the message shown in Review is the message sent.
  if (personalizationEnabled && preview_contact_id && preview_message && contact_ids?.map(Number).includes(Number(preview_contact_id))) {
    const previewContact = db.prepare('SELECT username FROM contacts WHERE id = ?').get(preview_contact_id);
    if (previewContact) {
      const previewLead = db.prepare('SELECT id, profile_summary, profile_summary_meta FROM leads WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))').get(previewContact.username);
      if (previewLead) {
        const meta = preview_personalization || {};
        const summaryVersion = getSummaryVersion(previewLead);
        let summaryMeta = {};
        try { summaryMeta = JSON.parse(previewLead.profile_summary_meta || '{}') || {}; } catch {}
        const hooks = Array.isArray(summaryMeta.hooks) ? summaryMeta.hooks : [];
        const summaryHash = String(summaryMeta.content_hash || summaryContentHash(previewLead.profile_summary || '', hooks));
        const agentVersion = getAgentVersion(db.prepare('SELECT field, value FROM ai_business_context').all());
        const previewStillCurrent = Number(meta.ai_agent_version || 0) === agentVersion
          && Number(meta.summary_version || 0) === summaryVersion
          && String(meta.summary_hash || '') === summaryHash;
        if (previewStillCurrent) {
          db.prepare(`UPDATE campaign_leads SET message_sent = ?, personalization_status = 'ready', personalization_summary_version = ?, personalization_agent_version = ?, personalization_summary_hash = ?, personalization_hook = ?, personalization_problem = ?, personalization_offer_angle = ?, personalization_cta = ?, personalization_generated_at = ? WHERE campaign_id = ? AND lead_id = ?`)
            .run(String(preview_message), summaryVersion, agentVersion, summaryHash, String(meta.personalization_hook || ''), String(meta.relevant_problem || ''), String(meta.offer_angle || ''), String(meta.cta || ''), getMoscowISO(), campaignId, previewLead.id);
        }
      }
    }
  }

  logCampaignEvent(db, campaignId, 'created', `Кампания "${name}" создана`);

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  res.status(201).json(campaign);
});

router.put('/:id', (req, res) => {
  const db = req.db;
  const { name, message_template, offers, ai_provider, ai_generated, ai_prompt, personalization_mode, personalization_style, personalization_custom_prompt, scheduled_at, delay_seconds, status, daily_limit, send_time, min_delay, max_delay, follow_profile, wait_for_reply, value_per_lead, schedule_days, schedule_start, schedule_end, skip_contacted, stop_on_reply, pause_unsafe, safe_delays, warmup, like_last_post, prewarm_follow, prewarm_delay_hours, use_smart_personalization } = req.body;

  const existing = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Кампания не найдена' });

  const personalizationEnabled = personalization_mode !== undefined
    ? personalization_mode === 'personalized'
    : (existing.personalization_mode === 'personalized');

  if (personalizationEnabled) {
    const agentContext = db.prepare('SELECT field, value FROM ai_business_context').all();
    const missing = missingRequiredFields(agentContext);
    const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'openrouter_api_key'").get();
    if (!String(apiKey?.value || '').trim() || missing.length) {
      return res.status(400).json({ error: 'Нельзя включить персонализацию. Сначала завершите настройку AI Agent.', missing_fields: missing });
    }
  }

  let offersToSave = existing.offers;
  let messageTemplateToSave = existing.message_template;
  if (personalizationEnabled) {
    offersToSave = JSON.stringify([]);
    messageTemplateToSave = '';
  } else if (offers && Array.isArray(offers) && offers.length > 0) {
    const filteredOffers = offers.filter(o => o && typeof o === 'string' && o.trim()).slice(0, 1);
    if (filteredOffers.length > 0) {
      offersToSave = JSON.stringify(filteredOffers);
      messageTemplateToSave = filteredOffers[0];
    }
  } else if (message_template !== undefined) {
    messageTemplateToSave = message_template;
  }

  if (!personalizationEnabled && !String(messageTemplateToSave || '').trim()) {
    return res.status(400).json({ error: 'Добавьте оффер для сообщения' });
  }

  db.prepare(`
    UPDATE campaigns SET
      name=?, message_template=?, offers=?, ai_provider=?, ai_generated=?, ai_prompt=?, personalization_mode=?, personalization_style=?, personalization_custom_prompt=?,
      scheduled_at=?, delay_seconds=?, status=?,
      daily_limit=?, send_time=?, min_delay=?, max_delay=?,
      follow_profile=?, wait_for_reply=?, value_per_lead=?,
      schedule_days=?, schedule_start=?, schedule_end=?,
      skip_contacted=?, stop_on_reply=?, pause_unsafe=?, safe_delays=?, warmup=?,
      like_last_post=?, prewarm_follow=?, prewarm_delay_hours=?, use_smart_personalization=?,
      updated_at=?
    WHERE id=?
  `).run(
    name ?? existing.name,
    messageTemplateToSave,
    offersToSave,
    ai_provider ?? existing.ai_provider,
    ai_generated !== undefined ? (ai_generated ? 1 : 0) : existing.ai_generated,
    ai_prompt !== undefined ? ai_prompt : existing.ai_prompt,
    personalization_mode ?? existing.personalization_mode ?? 'template',
    personalization_style ?? existing.personalization_style ?? 'neutral',
    personalization_custom_prompt !== undefined ? personalization_custom_prompt : existing.personalization_custom_prompt,
    scheduled_at !== undefined ? scheduled_at : existing.scheduled_at,
    delay_seconds ?? existing.delay_seconds,
    status ?? existing.status,
    daily_limit ?? existing.daily_limit,
    send_time !== undefined ? send_time : existing.send_time,
    min_delay ?? existing.min_delay,
    max_delay ?? existing.max_delay,
    follow_profile !== undefined ? (follow_profile ? 1 : 0) : existing.follow_profile,
    wait_for_reply !== undefined ? (wait_for_reply ? 1 : 0) : existing.wait_for_reply,
    value_per_lead ?? existing.value_per_lead,
    schedule_days !== undefined ? schedule_days : existing.schedule_days,
    schedule_start ?? existing.schedule_start,
    schedule_end ?? existing.schedule_end,
    skip_contacted !== undefined ? (skip_contacted ? 1 : 0) : existing.skip_contacted,
    stop_on_reply !== undefined ? (stop_on_reply ? 1 : 0) : existing.stop_on_reply,
    pause_unsafe !== undefined ? (pause_unsafe ? 1 : 0) : existing.pause_unsafe,
    safe_delays !== undefined ? (safe_delays ? 1 : 0) : existing.safe_delays,
    warmup !== undefined ? (warmup ? 1 : 0) : existing.warmup,
    like_last_post !== undefined ? (like_last_post ? 1 : 0) : (existing.like_last_post || 0),
    prewarm_follow !== undefined ? (prewarm_follow ? 1 : 0) : (existing.prewarm_follow || 0),
    prewarm_delay_hours ?? (existing.prewarm_delay_hours || 24),
    use_smart_personalization !== undefined ? (use_smart_personalization ? 1 : 0) : (existing.use_smart_personalization || 0),
    getMoscowISO(),
    req.params.id
  );

  logCampaignEvent(db, req.params.id, 'updated', 'Настройки кампании обновлены');

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  res.json(campaign);
});

router.delete('/:id', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM campaign_logs WHERE campaign_id = ?').run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/start', (req, res) => {
  const db = req.db;
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });

  // Respect the campaign's skip_contacted flag. When it's off, the user has
  // explicitly opted in to re-messaging leads already contacted elsewhere
  // (e.g. after wiping/reimporting archived campaigns). Default: 1 (skip).
  const skipContacted = campaign.skip_contacted ?? 1;
  let skippedLeads = [];
  if (skipContacted) {
    skippedLeads = db.prepare(`
      SELECT cl.id, l.username FROM campaign_leads cl
      JOIN leads l ON l.id = cl.lead_id
      WHERE cl.campaign_id = ? AND cl.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM campaign_leads cl2
          WHERE cl2.lead_id = cl.lead_id
            AND cl2.campaign_id != cl.campaign_id
            AND cl2.status = 'sent'
        )
    `).all(req.params.id);

    if (skippedLeads.length > 0) {
      const skipStmt = db.prepare(`
        UPDATE campaign_leads SET status = 'skipped', error_message = 'Сообщение уже отправлено в другой кампании' WHERE id = ?
      `);
      for (const sl of skippedLeads) {
        skipStmt.run(sl.id);
        logCampaignEvent(db, campaign.id, 'lead_skipped', `@${sl.username} пропущен — уже получал сообщение`);
      }
    }
  }

  activateCampaign(db, campaign.id);
  res.json({ success: true, status: 'running', skipped: skippedLeads.length });
});

// Bring non-successful leads back into the queue. Restores any lead that
// isn't 'sent'/'sending'/'pending' (which covers 'skipped', 'failed',
// and any legacy statuses) back to 'pending', clears the error and sent_at,
// so the campaign will attempt them again on the next /queue tick.
// Flips skip_contacted off by default too — otherwise leads whose original
// skip reason was "already contacted in another campaign" would get
// re-skipped immediately.
router.post('/:id/restore-skipped', (req, res) => {
  const db = req.db;
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });

  const { disable_skip_contacted = true, only_reason, include_failed = true } = req.body || {};

  const statuses = include_failed ? `('skipped','failed')` : `('skipped')`;
  const where = only_reason
    ? `campaign_id = ? AND status IN ${statuses} AND error_message = ?`
    : `campaign_id = ? AND status IN ${statuses}`;
  const params = only_reason ? [req.params.id, only_reason] : [req.params.id];

  const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM campaign_leads WHERE ${where}`).get(...params);
  const affected = countRow.cnt;

  const breakdown = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM campaign_leads WHERE ${where} GROUP BY status
  `).all(...params);

  db.prepare(`
    UPDATE campaign_leads
    SET status = 'pending', error_message = NULL, sent_at = NULL
    WHERE ${where}
  `).run(...params);

  if (disable_skip_contacted) {
    db.prepare(`UPDATE campaigns SET skip_contacted = 0, updated_at = ? WHERE id = ?`)
      .run(getMoscowISO(), req.params.id);
  }

  const parts = breakdown.map(b => `${b.cnt} ${b.status}`).join(', ');
  logCampaignEvent(db, req.params.id, 'restore_skipped',
    `Восстановлено ${affected} лидов${parts ? ` (${parts})` : ''}` +
    (disable_skip_contacted ? '. Anti-duplicate отключён для этой кампании.' : '')
  );

  res.json({
    success: true,
    restored: affected,
    breakdown: Object.fromEntries(breakdown.map(b => [b.status, b.cnt])),
    skip_contacted_disabled: !!disable_skip_contacted
  });
});

router.post('/:id/pause', (req, res) => {
  const db = req.db;
  const campaign = db.prepare('SELECT name FROM campaigns WHERE id = ?').get(req.params.id);
  pauseCampaign(db, req.params.id);
  res.json({ success: true, status: 'paused' });
});

router.post('/:id/schedule', (req, res) => {
  const db = req.db;
  const { scheduled_at } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at обязателен' });
  db.prepare(`UPDATE campaigns SET scheduled_at=?, status='scheduled', updated_at=? WHERE id=?`)
    .run(scheduled_at, getMoscowISO(), req.params.id);
  logCampaignEvent(db, req.params.id, 'scheduled', `Запланирована на ${scheduled_at}`);
  res.json({ success: true, scheduled_at });
});

router.get('/:id/leads', (req, res) => {
  const db = req.db;
  const leads = db.prepare(`
    SELECT l.*, cl.status as campaign_status, cl.sent_at, cl.message_sent, cl.id as cl_id, cl.replied, cl.reply_text, cl.replied_at
    FROM campaign_leads cl
    JOIN leads l ON l.id = cl.lead_id
    WHERE cl.campaign_id = ?
    ORDER BY cl.id ASC
  `).all(req.params.id);
  res.json(leads);
});

router.post('/:id/leads', (req, res) => {
  const db = req.db;
  const { lead_ids, contact_ids } = req.body;

  let resolvedIds = lead_ids || [];
  if (contact_ids?.length) {
    resolvedIds = [];
    for (const cid of contact_ids) {
      const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
      if (!contact) continue;
      const cleanUsername = (contact.username || '').trim();
      if (!cleanUsername) continue;
      let lead = db.prepare('SELECT id FROM leads WHERE username = ?').get(cleanUsername);
      if (!lead) {
        const r = db.prepare('INSERT INTO leads (username, full_name, email, bio, niche, status) VALUES (?, ?, ?, ?, ?, ?)').run(
          cleanUsername, contact.full_name || null, contact.email || null, null, null, 'new'
        );
        lead = { id: r.lastInsertRowid };
      }
      resolvedIds.push(lead.id);
    }
  }

  if (!resolvedIds.length) return res.status(400).json({ error: 'lead_ids or contact_ids required' });
  const insert = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, offer_num) VALUES (?, ?, ?)');
  db.transaction(() => resolvedIds.forEach(lid => insert.run(req.params.id, lid, 1)))();

  // If campaign is completed, reset to draft so it can run again with new leads
  const camp = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(req.params.id);
  if (camp?.status === 'completed') {
    db.prepare('UPDATE campaigns SET status = \'draft\', updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
    logCampaignEvent(db, req.params.id, 'reactivated', `Кампания активирована повторно (добавлены новые лиды)`);
  }

  logCampaignEvent(db, req.params.id, 'leads_added', `Added ${resolvedIds.length} contacts`);
  res.json({ success: true, added: resolvedIds.length });
});

router.delete('/:id/leads/:leadId', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').run(req.params.id, req.params.leadId);
  res.json({ success: true });
});

// Reset single campaign lead to pending (as if new)
router.post('/:id/leads/:clId/reset', (req, res) => {
  const db = req.db;
  db.prepare(`
    UPDATE campaign_leads SET
      status = 'pending',
      sent_at = NULL,
      message_sent = NULL,
      error_message = NULL,
      replied = 0,
      reply_text = NULL,
      replied_at = NULL
    WHERE id = ? AND campaign_id = ?
  `).run(req.params.clId, req.params.id);
  res.json({ success: true });
});

// Reset all leads in campaign to pending
router.post('/:id/reset-all-leads', (req, res) => {
  const db = req.db;
  db.prepare(`
    UPDATE campaign_leads SET
      status = 'pending',
      sent_at = NULL,
      message_sent = NULL,
      error_message = NULL,
      replied = 0,
      reply_text = NULL,
      replied_at = NULL
    WHERE campaign_id = ?
  `).run(req.params.id);
  logCampaignEvent(db, req.params.id, 'leads_reset', 'Все лиды обнулены и готовы к отправке');
  res.json({ success: true });
});

router.get('/:id/logs', (req, res) => {
  const db = req.db;
  const logs = db.prepare(`
    SELECT * FROM campaign_logs WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(req.params.id);
  res.json(logs);
});

export default router;
