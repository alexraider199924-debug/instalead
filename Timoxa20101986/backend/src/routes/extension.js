import { Router } from 'express';
import { completeCampaign, pauseCampaign, logCampaignEvent, isCampaignInWorkingHours, getMoscowISO } from '../services/schedulerService.js';
import { generatePersonalizedMessage, getAgentVersion, getSummaryVersion } from '../services/personalizationEngine.js';
import { summaryContentHash } from '../services/contactEnrichService.js';
import { missingRequiredFields } from '../services/offerContext.js';
import { ENRICH_VERSION } from '../services/contactEnrichService.js';
import { getWarmupStatus } from './accounts.js';
import { parseFirstName } from '../services/nameParser.js';
import { prepareOutboundMessage, collapseInlineWhitespace, expandSpintax } from '../services/messageText.js';
import { notify, escHtml } from '../services/notifier.js';
import { createExtensionPairCode, claimExtensionPairCode, getExtensionDevice, touchExtensionDevice, revokeExtensionDevice, loginUser, createExtensionDevice, hashOpaqueToken } from '../services/authService.js';
import { getAuthDB } from '../db/authDb.js';

const router = Router();



// Enrichment is DOM-only. The extension must never have to infer this from a
// mutable UI setting, and an old workspace value of `api` must not route a job
// back through Instagram's private API.
router.get('/enrichment-method', (req, res) => {
  res.json({ enrichment_method: 'dom' });
});

let lastHeartbeat = null;

router.post('/login', async (req, res) => {
  try {
    const { email, password, username } = req.body || {};
    const auth = await loginUser(email, password);
    const device = await createExtensionDevice(auth.user.id, auth.user.workspace, username || null);
    res.json({ success: true, user: auth.user, token: device.token, workspace: device.workspace });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message || 'Login failed' });
  }
});

router.post('/logout', async (req, res) => {
  const deviceToken = req.get('x-extension-token');
  if (!deviceToken) return res.status(401).json({ error: 'Sign in required' });
  await revokeExtensionDevice(deviceToken);
  res.json({ success: true });
});

// The popup needs to show which platform account the token belongs to. Without
// this the extension can only show the Instagram handle it detected, which is a
// different identity — the token itself is the authority on who is signed in.
router.get('/me', (req, res) => {
  res.json({
    email: req.user?.email || null,
    role: req.user?.role || null,
    workspace: req.user?.workspace || 'default'
  });
});

router.post('/pair/code', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  const result = await createExtensionPairCode(req.user.id, req.user.workspace);
  res.json(result);
});

router.post('/pair/claim', async (req, res) => {
  const result = await claimExtensionPairCode(req.body?.code, req.body?.username);
  if (!result) return res.status(400).json({ error: 'Invalid, expired, or already used pairing code' });
  res.json({ success: true, ...result });
});

router.get('/queue', (req, res) => {
  const db = req.db;

  // Reclaim leads stuck in 'sending' (extension crashed / tab closed mid-action).
  // A lead that already passed the follow phase (followed_at set) belongs back
  // in the DM queue as 'followed', not at the start as 'pending' — resetting it
  // to 'pending' would re-trigger the follow step and, since it clicks the same
  // button, actually UNFOLLOW the lead.
  db.prepare(`
    UPDATE campaign_leads
    SET status = CASE WHEN followed_at IS NOT NULL THEN 'followed' ELSE 'pending' END,
        sent_at = NULL
    WHERE status = 'sending'
      AND sent_at < datetime(?, '-10 minutes')
  `).run(getMoscowISO());

  // Anti-duplicate check: skip pending leads that were already messaged in
  // another campaign. Only runs for campaigns with skip_contacted = 1 (the
  // default). Users can toggle it off per-campaign via /restore-skipped or
  // the campaign settings — useful when leads from long-archived campaigns
  // are eligible for a fresh outreach.
  const skipAlreadyContacted = db.prepare(`
    UPDATE campaign_leads SET status = 'skipped', error_message = 'Сообщение уже отправлено в другой кампании'
    WHERE status = 'pending' AND campaign_id IN (
      SELECT id FROM campaigns WHERE status = 'running' AND COALESCE(skip_contacted, 1) = 1
    )
      AND EXISTS (
        SELECT 1 FROM campaign_leads cl2
        WHERE cl2.lead_id = campaign_leads.lead_id
          AND cl2.campaign_id != campaign_leads.campaign_id
          AND cl2.status = 'sent'
      )
  `).run();

  if (skipAlreadyContacted.changes > 0) {
    const skippedRows = db.prepare(`
      SELECT cl.campaign_id, l.username FROM campaign_leads cl
      JOIN leads l ON l.id = cl.lead_id
      WHERE cl.status = 'skipped' AND cl.error_message = 'Сообщение уже отправлено в другой кампании'
      ORDER BY cl.id DESC LIMIT ?
    `).all(skipAlreadyContacted.changes);
    for (const row of skippedRows) {
      logCampaignEvent(db, row.campaign_id, 'lead_skipped', `@${row.username} пропущен — уже получал сообщение`);
    }
    const campaignIds = [...new Set(skippedRows.map(r => r.campaign_id))];
    for (const cid of campaignIds) {
      completeCampaign(db, cid);
    }
  }

  const nowIso = getMoscowISO();

  // Pick the earliest actionable lead across all running campaigns. Two kinds
  // are actionable:
  //   • status='pending'  — never touched (needs a follow or a DM)
  //   • status='followed' — already followed under prewarm and the delay has
  //                         elapsed, so it's due for its DM
  // DM-ready ('followed') leads are prioritised over fresh follows so we finish
  // warmed conversations before opening new ones.
  const running = db.prepare(`
    SELECT c.*, cl.id as cl_id, cl.lead_id, cl.status as cl_status, cl.followed_at,
      l.username, l.full_name, l.niche, l.bio,
      cl.message_sent as saved_personalized,
      cl.personalization_agent_version, cl.personalization_summary_version, cl.personalization_summary_hash, cl.personalization_status,
      l.profile_summary, l.profile_summary_meta,
      COALESCE(cl.message_sent, c.message_template) as final_message,
      c.min_delay, c.max_delay, c.ai_prompt, c.personalization_mode, c.personalization_style, c.personalization_custom_prompt
    FROM campaigns c
    JOIN campaign_leads cl ON cl.campaign_id = c.id
    JOIN leads l ON l.id = cl.lead_id
    WHERE c.status = 'running' AND (
      cl.status = 'pending'
      OR (cl.status = 'followed'
          AND datetime(cl.followed_at, '+' || COALESCE(c.prewarm_delay_hours, 24) || ' hours') <= ?)
    )
    ORDER BY
      CASE WHEN cl.status = 'followed' THEN 0 ELSE 1 END,
      c.id ASC, cl.id ASC
    LIMIT 1
  `).get(nowIso);

  if (!running) {
    return res.json({ item: null, message: 'Нет активных задач' });
  }

  const currentAgentVersion = getAgentVersion(db.prepare('SELECT field, value FROM ai_business_context').all());
  const currentSummaryVersion = getSummaryVersion({ profile_summary: running.profile_summary, profile_summary_meta: running.profile_summary_meta });
  const currentSummaryHash = (() => { try { const meta = JSON.parse(running.profile_summary_meta || '{}'); return String(meta.content_hash || summaryContentHash(running.profile_summary || '', meta.hooks || [])); } catch { return summaryContentHash(running.profile_summary || ''); } })();
  const personalizationStale = Boolean(running.saved_personalized) && (
    Number(running.personalization_agent_version || 0) !== currentAgentVersion ||
    Number(running.personalization_summary_version || 0) !== currentSummaryVersion ||
    String(running.personalization_summary_hash || '') !== currentSummaryHash
  );
  if (personalizationStale) {
    db.prepare("UPDATE campaign_leads SET personalization_status = 'stale' WHERE id = ?").run(running.cl_id);
  }

  if (!isCampaignInWorkingHours(db, running.id)) {
    return res.json({ item: null, message: 'Вне рабочих часов (МСК). Ожидание.' });
  }

  const moscowToday = nowIso.slice(0, 10);
  const dailyLimit = running.daily_limit || 50;

  // Prewarm only applies when the campaign both opts into it and actually
  // follows (there's nothing to warm with if following is off).
  const isPrewarm = !!running.prewarm_follow && !!(running.follow_profile ?? 1);
  // A 'followed' lead is always in its DM phase. A fresh 'pending' lead is a
  // follow phase under prewarm, otherwise the classic combined follow+DM.
  const phase = running.cl_status === 'followed' ? 'dm' : (isPrewarm ? 'follow' : 'dm');

  const warmup = getWarmupStatus(db);

  if (phase === 'dm') {
    const sentTodayForCampaign = db.prepare(`
      SELECT COUNT(*) as cnt FROM campaign_leads
      WHERE campaign_id = ? AND (status = 'sent' OR status = 'sending') AND date(sent_at) = ?
    `).get(running.id, moscowToday).cnt;
    if (sentTodayForCampaign >= dailyLimit) {
      return res.json({ item: null, message: `Дневной лимит ${dailyLimit} сообщений достигнут. Продолжение завтра.` });
    }

    if (warmup.enabled) {
      const sentTodayTotal = db.prepare(`
        SELECT COUNT(*) as cnt FROM campaign_leads
        WHERE status IN ('sent','sending') AND date(sent_at) = ?
      `).get(moscowToday).cnt;
      if (sentTodayTotal >= warmup.max_messages) {
        return res.json({ item: null, message: `Лимит прогрева: ${warmup.max_messages} DM/день достигнут. Ожидание завтра.` });
      }
    }
  } else {
    // Follow phase: cap follows per day with the same daily_limit so prewarm
    // can't blast every pending lead with a follow on day one — the whole
    // point is to spread activity out.
    const followedTodayForCampaign = db.prepare(`
      SELECT COUNT(*) as cnt FROM campaign_leads
      WHERE campaign_id = ? AND date(followed_at) = ?
    `).get(running.id, moscowToday).cnt;
    if (followedTodayForCampaign >= dailyLimit) {
      return res.json({ item: null, message: `Дневной лимит ${dailyLimit} подписок достигнут. Рассылка продолжится после прогрева.` });
    }

    if (warmup.enabled) {
      const followedTodayTotal = db.prepare(`
        SELECT COUNT(*) as cnt FROM campaign_leads WHERE date(followed_at) = ?
      `).get(moscowToday).cnt;
      if (followedTodayTotal >= warmup.max_follows) {
        return res.json({ item: null, message: `Лимит прогрева: ${warmup.max_follows} подписок/день достигнут. Ожидание завтра.` });
      }
    }
  }

  const minDelay = running.min_delay || 7;
  const maxDelay = running.max_delay || 17;
  const randomDelayMin = minDelay + Math.random() * (maxDelay - minDelay);
  const delaySec = Math.round(randomDelayMin * 60);

  db.prepare(`UPDATE campaign_leads SET status = 'sending', sent_at = ? WHERE id = ?`)
    .run(nowIso, running.cl_id);

  if (phase === 'follow') {
    // Follow-only touch: like + follow, no DM. The extension reports back via
    // /followed, which parks the lead in 'followed' until the DM delay passes.
    return res.json({
      item: {
        cl_id: running.cl_id,
        campaign_id: running.id,
        campaign_name: running.name,
        lead_id: running.lead_id,
        username: (running.username || '').trim(),
        full_name: running.full_name,
        niche: running.niche,
        bio: running.bio,
        message: null,
        follow_only: true,
        delay_seconds: delaySec,
        follow_profile: 1,
        like_last_post: running.like_last_post ?? 0,
        needs_personalization: false
      }
    });
  }

  // Campaigns have one offer. Keep the selected value as a compatibility fallback
  // for campaigns created before the single-offer rule.
  const selectedOffer = personalizationStale ? running.message_template : running.final_message;
  const firstName = parseFirstName(running.full_name, '');
  const message = prepareOutboundMessage(selectedOffer, firstName);

  // A lead reaching the DM phase after prewarm is already followed and liked —
  // re-clicking Follow would UNfollow it, so both soft-touch actions are off.
  const alreadyWarmed = running.cl_status === 'followed';
  let followAllowed = alreadyWarmed ? 0 : (running.follow_profile ?? 1);
  let likeAllowed = alreadyWarmed ? 0 : (running.like_last_post ?? 0);

  if (!alreadyWarmed && warmup.enabled && followAllowed) {
    const followsToday = db.prepare(`
      SELECT COUNT(*) as cnt FROM campaign_leads
      WHERE status IN ('sent','sending') AND date(sent_at) = ?
    `).get(moscowToday).cnt;
    if (followsToday >= warmup.max_follows) {
      followAllowed = 0;
    }
  }

  res.json({
    item: {
      cl_id: running.cl_id,
      campaign_id: running.id,
      campaign_name: running.name,
      lead_id: running.lead_id,
      username: (running.username || '').trim(),
      full_name: running.full_name,
      niche: running.niche,
      bio: running.bio,
      message,
      message_template: running.message_template,
      ai_prompt: running.ai_prompt || null,
      delay_seconds: delaySec,
      follow_only: false,
      follow_profile: followAllowed,
      like_last_post: likeAllowed,
      // Personalization is a campaign-level switch. When it is ON, every DM
      // must pass through the AI Agent + lead summary pipeline before it can
      // be sent. There is no prompt/offer shortcut. A saved message is reused
      // until the summary or AI Agent version changes.
      needs_personalization: running.personalization_mode === 'personalized' && (!running.saved_personalized || personalizationStale)
    }
  });
});

// Follow phase completion (prewarm). The extension calls this after it has
// followed (and optionally liked) a lead but before any DM. The lead parks in
// 'followed' with a timestamp; /queue serves its DM once prewarm_delay_hours
// have elapsed. Mirrors /confirm's idempotency: the extension retries on
// network hiccups, so a lead already past the follow phase is a no-op.
router.post('/followed/:cl_id', (req, res) => {
  const db = req.db;
  const cl = db.prepare(`
    SELECT cl.*, l.username FROM campaign_leads cl
    JOIN leads l ON l.id = cl.lead_id WHERE cl.id = ?
  `).get(req.params.cl_id);
  if (!cl) return res.status(404).json({ error: 'Не найдено' });

  const campaignNow = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(cl.campaign_id);
  const shouldContinue = !!(campaignNow && campaignNow.status === 'running');

  // Never regress a lead that already got its DM.
  if (cl.status === 'sent') {
    return res.json({ success: true, already_sent: true, should_continue: shouldContinue });
  }
  if (cl.status === 'followed') {
    return res.json({ success: true, already_followed: true, should_continue: shouldContinue });
  }

  db.prepare(`
    UPDATE campaign_leads SET status = 'followed', followed_at = ?, error_message = NULL WHERE id = ?
  `).run(getMoscowISO(), req.params.cl_id);

  logCampaignEvent(db, cl.campaign_id, 'lead_followed', `Подписка на @${cl.username} — DM отправим после прогрева`);
  res.json({ success: true, should_continue: shouldContinue });
});

router.post('/personalize/:cl_id', async (req, res) => {
  const db = req.db;
  try {
    const { profileData } = req.body;
    const cl = db.prepare(`
      SELECT cl.*, c.message_template, c.ai_prompt, c.use_smart_personalization, c.personalization_mode, c.personalization_style, c.personalization_custom_prompt,
        l.username, l.full_name, l.niche, l.bio, l.profile_summary, l.profile_summary_meta,
        ct.full_name AS contact_full_name
      FROM campaign_leads cl
      JOIN campaigns c ON c.id = cl.campaign_id
      JOIN leads l ON l.id = cl.lead_id
      LEFT JOIN contacts ct ON LOWER(TRIM(ct.username)) = LOWER(TRIM(l.username))
      WHERE cl.id = ?
    `).get(req.params.cl_id);

    if (!cl) return res.status(404).json({ error: 'Not found' });

    // A saved DM is reusable only when it was generated against the current
    // AI Agent AND the current exact summary content. Queue may have marked it
    // stale, but this endpoint is the final authority and must never resurrect
    // an obsolete message on a retry.

    if (profileData?.bio && !cl.bio) {
      db.prepare('UPDATE leads SET bio = ? WHERE id = ?').run(profileData.bio, cl.lead_id);
    }
    // Contact name is the source of truth for greetings. Profile scraping must
    // never replace it with a display name/username discovered on Instagram.
    const contactName = String(cl.contact_full_name || cl.full_name || '').trim();
    if (cl.contact_full_name && cl.contact_full_name !== cl.full_name) {
      db.prepare('UPDATE leads SET full_name = ? WHERE id = ?').run(cl.contact_full_name, cl.lead_id);
    }

    let personalizedMessage;

    // The business context is the difference between a message written by
    // someone who knows the offer and one written by someone guessing at it.
    // It used to be read here only to decide whether AI Agent was configured,
    // and then dropped — the model never saw it.
    const agentContext = db.prepare('SELECT field, value FROM ai_business_context').all();

    // Every AI personalization path now uses the same AI Agent readiness gate.
    // A custom campaign prompt cannot bypass the company's offer/CTA/voice rules.
    const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'openrouter_api_key'").get();
    if (!String(apiKey?.value || '').trim() || missingRequiredFields(agentContext).length) {
      return res.status(400).json({ error: 'Нельзя создать персонализированное сообщение. Сначала завершите настройку AI Agent.', missing_fields: missingRequiredFields(agentContext) });
    }
    const currentSummaryVersion = getSummaryVersion({ profile_summary: cl.profile_summary, profile_summary_meta: cl.profile_summary_meta });
    if (!String(cl.profile_summary || '').trim()) {
      db.prepare("UPDATE campaign_leads SET personalization_status = 'not_ready' WHERE id = ?").run(cl.id);
      return res.status(400).json({ error: 'Сначала необходимо создать конспект лида.' });
    }
    if (currentSummaryVersion !== ENRICH_VERSION) {
      db.prepare("UPDATE campaign_leads SET personalization_status = 'stale' WHERE id = ?").run(cl.id);
      return res.status(409).json({ error: 'Конспект лида устарел. Сначала пересоздайте конспект.' });
    }

    let summaryHooks = [];
    try { summaryHooks = JSON.parse(cl.profile_summary_meta || '{}')?.hooks || []; } catch {}
    const currentSummaryHash = (() => { try { const meta = JSON.parse(cl.profile_summary_meta || '{}'); return String(meta.content_hash || summaryContentHash(cl.profile_summary || '', summaryHooks)); } catch { return summaryContentHash(cl.profile_summary || ''); } })();
    const agentVersion = getAgentVersion(agentContext);
    const reusable = Boolean(cl.message_sent && cl.message_sent.trim())
      && Number(cl.personalization_agent_version || 0) === agentVersion
      && Number(cl.personalization_summary_version || 0) === currentSummaryVersion
      && String(cl.personalization_summary_hash || '') === currentSummaryHash;
    if (reusable) {
      return res.json({ message: cl.message_sent, reused: true, personalization: { summary_version: currentSummaryVersion, ai_agent_version: agentVersion, summary_hash: currentSummaryHash } });
    }
    if (cl.message_sent) {
      db.prepare(`UPDATE campaign_leads SET message_sent = NULL, personalization_status = 'stale' WHERE id = ?`).run(cl.id);
    }

    const generation = await generatePersonalizedMessage(db, {
      messageTemplate: cl.message_template,
      lead: {
        username: cl.username,
        // IMPORTANT: contact_full_name is manually assigned in Contacts and is
        // authoritative. Do not substitute profileData.fullName here.
        contact_name: contactName,
        full_name: contactName,
        bio: profileData?.bio || cl.bio,
        niche: cl.niche,
        profile_summary: cl.profile_summary,
        profile_summary_meta: cl.profile_summary_meta
      },
      profileData,
      agentContext,
      style: cl.personalization_style === 'custom' ? 'custom' : (cl.personalization_style || 'neutral'),
      customPrompt: cl.personalization_custom_prompt || '',
      extraInstruction: `Campaign message stage: ${cl.offer_num || 1}.`
    });
    personalizedMessage = collapseInlineWhitespace(generation.final_message);

    const sampleVariation = String(agentContext.find(r => r.field === 'sample_message_variation')?.value || '').trim();
    if (sampleVariation === 'spintax') {
      personalizedMessage = expandSpintax(personalizedMessage);
    }

    personalizedMessage = prepareOutboundMessage(
      personalizedMessage,
      parseFirstName(contactName, '')
    );

    const summaryVersion = getSummaryVersion({ profile_summary: cl.profile_summary, profile_summary_meta: cl.profile_summary_meta });
    const hook = String(generation.personalization_hook || '').trim();
    const problem = String(generation.relevant_problem || '').trim();
    const offerAngle = String(generation.offer_angle || '').trim();
    const cta = String(generation.cta || '').trim() || String(agentContext.find(r => r.field === 'offer_cta')?.value || '').trim();
    db.transaction(() => {
      db.prepare(`UPDATE campaign_leads SET message_sent = ?, personalization_status = 'ready', personalization_summary_version = ?, personalization_agent_version = ?, personalization_summary_hash = ?, personalization_hook = ?, personalization_problem = ?, personalization_offer_angle = ?, personalization_cta = ?, personalization_generated_at = ? WHERE id = ?`)
        .run(personalizedMessage, summaryVersion, agentVersion, currentSummaryHash, hook, problem, offerAngle, cta, getMoscowISO(), cl.id);
      db.prepare(`INSERT INTO ai_personalization_history (lead_id, company_id, campaign_id, summary_version, ai_agent_version, personalization_hook, relevant_problem, offer_angle, cta, final_message, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cl.lead_id, req.user?.workspace || null, cl.campaign_id, summaryVersion, agentVersion, hook, problem, offerAngle, cta, personalizedMessage, getMoscowISO());
    })();

    res.json({ message: personalizedMessage, personalization: { summary_version: summaryVersion, ai_agent_version: agentVersion, personalization_hook: hook, relevant_problem: problem, offer_angle: offerAngle, cta, final_message: personalizedMessage } });
  } catch (e) {
    console.error('[Personalize] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/confirm/:cl_id', (req, res) => {
  const db = req.db;
  const { message } = req.body;
  const cl = db.prepare(`
    SELECT cl.*, l.username, l.full_name
    FROM campaign_leads cl
    JOIN leads l ON l.id = cl.lead_id
    WHERE cl.id = ?
  `).get(req.params.cl_id);
  if (!cl) return res.status(404).json({ error: 'Не найдено' });

  // Idempotency: if this lead was already confirmed, do NOT re-run any
  // side effects (inbox row, log event). The extension retries confirm
  // locally on network failure — without this guard a single successful
  // DM would produce duplicate inbox rows and log spam, and a
  // recovered-from-'sending' lead sent twice would leave both marked sent.
  if (cl.status === 'sent') {
    const campaignNow = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(cl.campaign_id);
    const shouldContinue = campaignNow && campaignNow.status === 'running';
    return res.json({ success: true, already_confirmed: true, should_continue: shouldContinue });
  }

  db.prepare(`
    UPDATE campaign_leads
    SET status = 'sent', sent_at = ?, message_sent = COALESCE(?, message_sent)
    WHERE id = ?
  `).run(getMoscowISO(), message || null, req.params.cl_id);

  let conv = db.prepare('SELECT * FROM inbox_conversations WHERE contact_username = ?').get(cl.username);
  if (!conv) {
    const result = db.prepare(`
      INSERT INTO inbox_conversations (contact_username, contact_name, last_message, label, unread)
      VALUES (?, ?, ?, 'waiting', 0)
    `).run(cl.username, cl.full_name || null, message || cl.message_sent || 'Message sent');
    conv = db.prepare('SELECT * FROM inbox_conversations WHERE id = ?').get(result.lastInsertRowid);
  } else {
    db.prepare(`
      UPDATE inbox_conversations SET last_message = ?, updated_at = ? WHERE id = ?
    `).run(message || cl.message_sent || 'Message sent', getMoscowISO(), conv.id);
  }

  if (conv) {
    db.prepare('INSERT INTO inbox_messages (conversation_id, sender, text) VALUES (?, ?, ?)').run(
      conv.id, 'me', message || cl.message_sent || ''
    );
  }

  logCampaignEvent(db, cl.campaign_id, 'message_sent', `Сообщение отправлено @${cl.username}`);
  completeCampaign(db, cl.campaign_id);

  const campaignNow = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(cl.campaign_id);
  const shouldContinue = campaignNow && campaignNow.status === 'running';
  res.json({ success: true, should_continue: shouldContinue });
});

router.post('/fail/:cl_id', (req, res) => {
  const db = req.db;
  const { error_message } = req.body;
  const cl = db.prepare(`
    SELECT cl.*, l.username FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.id = ?
  `).get(req.params.cl_id);
  if (!cl) return res.status(404).json({ error: 'Не найдено' });

  // Never flip a confirmed send back to failed — extension may retry /fail
  // after a network hiccup for a lead that actually went through.
  if (cl.status === 'sent') {
    return res.json({ success: true, already_sent: true });
  }

  db.prepare(`
    UPDATE campaign_leads SET status = 'failed', error_message = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ?
  `).run(error_message || 'Unknown error', getMoscowISO(), req.params.cl_id);

  logCampaignEvent(db, cl.campaign_id, 'send_failed', `Ошибка отправки @${cl.username}: ${error_message || 'Unknown'}`);
  res.json({ success: true });
});

router.post('/heartbeat', async (req, res) => {
  const db = req.db;
  // Heartbeat is also the reconnect handshake. After a user disconnects from
  // the web UI, the next heartbeat restores the current Instagram identity on
  // the authenticated extension device without requiring a new login.
  const heartbeatUsername = String(req.body?.ig_username || '').trim().replace(/^@/, '');
  if (heartbeatUsername && req.user?.id) {
    const authDb = await getAuthDB();
    const deviceToken = req.get('x-extension-token');
    if (deviceToken) {
      authDb.prepare('UPDATE extension_devices SET instagram_username = ?, last_seen_at = ?, revoked = 0 WHERE token_hash = ? AND user_id = ?')
        .run(heartbeatUsername, getMoscowISO(), hashOpaqueToken(deviceToken), req.user.id);
    } else {
      authDb.prepare('UPDATE extension_devices SET instagram_username = ?, last_seen_at = ?, revoked = 0 WHERE user_id = ? AND revoked = 0')
        .run(heartbeatUsername, getMoscowISO(), req.user.id);
    }
  }
  lastHeartbeat = {
    ...req.body,
    _workspace: req.workspace,
    timestamp: Date.now()
  };
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('extension_heartbeat', ?)`).run(JSON.stringify(lastHeartbeat));
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('last_heartbeat', ?)`).run(JSON.stringify(lastHeartbeat));

  const runningCount = db.prepare(`SELECT COUNT(*) as cnt FROM campaigns WHERE status = 'running'`).get().cnt;
  const extRunning = req.body.running;

  // Signals telling the extension when it may touch Instagram.
  // Nothing here polls Instagram on its own — the extension only acts when
  // the user asked for a sync or there is an outgoing message waiting.
  let syncRequested = false;
  let outboxPending = 0;
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'inbox_sync_requested'`).get();
    syncRequested = row?.value === '1';
    outboxPending = db.prepare(
      `SELECT COUNT(*) as cnt FROM inbox_messages WHERE pending_send = 1 AND sender = 'me'`
    ).get().cnt;
  } catch (e) {}

  res.json({
    success: true,
    should_run: runningCount > 0 && !extRunning,
    should_stop: runningCount === 0 && extRunning,
    sync_requested: syncRequested,
    outbox_pending: outboxPending
  });
});

// Called by the web UI's refresh button. Queues one Instagram sync that the
// extension picks up on its next heartbeat.
router.post('/request-sync', (req, res) => {
  const db = req.db;
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('inbox_sync_requested', '1')`).run();
  res.json({ success: true });
});

// Atomically take the pending sync request. The flag is cleared here, before
// any Instagram work starts, so a failure mid-scrape can never make the
// extension retry on the next heartbeat.
router.post('/claim-sync', (req, res) => {
  const db = req.db;
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'inbox_sync_requested'`).get();
  const claimed = row?.value === '1';
  if (claimed) {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('inbox_sync_requested', '0')`).run();
  }
  res.json({ claimed });
});

router.get('/sync-state', (req, res) => {
  const db = req.db;
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'inbox_sync_requested'`).get();
  const doneRow = db.prepare(`SELECT value FROM settings WHERE key = 'inbox_last_sync' `).get();
  const errRow = db.prepare(`SELECT value FROM settings WHERE key = 'inbox_last_sync_error'`).get();
  const cntRow = db.prepare(`SELECT value FROM settings WHERE key = 'inbox_last_sync_count'`).get();
  res.json({
    pending: row?.value === '1',
    last_sync: doneRow?.value || null,
    // Outcome of the most recent sync so the UI can explain an empty result
    // instead of silently claiming success. Empty string = no error.
    last_error: errRow?.value || null,
    last_count: cntRow ? Number(cntRow.value) : null
  });
});

router.get('/heartbeat', (req, res) => {
  const ws = req.workspace;
  if (!ws || ws === 'default') {
    return res.json({ connected: false, age_seconds: null });
  }

  const db = req.db;
  if (lastHeartbeat && lastHeartbeat._workspace === ws) {
    const age = Date.now() - lastHeartbeat.timestamp;
    res.json({
      ...lastHeartbeat,
      connected: age < 60000,
      age_seconds: Math.round(age / 1000)
    });
    return;
  }

  const row = db.prepare(`SELECT value FROM settings WHERE key = 'extension_heartbeat'`).get();
  if (row?.value) {
    try {
      const data = JSON.parse(row.value);
      const age = Date.now() - data.timestamp;
      res.json({ ...data, connected: age < 60000, age_seconds: Math.round(age / 1000) });
      return;
    } catch (e) {}
  }

  res.json({ connected: false, age_seconds: null });
});

router.post('/action-blocked', (req, res) => {
  const db = req.db;
  const { reason, cl_id, campaign_id } = req.body;

  const isSoftBlock = typeof reason === 'string' && reason.startsWith('soft-block');
  const isCircuitBreaker = typeof reason === 'string' && reason.startsWith('circuit-breaker');
  const humanReason = isCircuitBreaker
    ? `Автостоп: 3+ неудачи подряд. Instagram вероятно помечает аккаунт (spam-флаг, soft-block или DOM изменился). Не запускай кампании ближайшие 3-7 дней. Используй аккаунт руками. Потом снижай daily_limit до 10-15 и min_delay до 30 минут.`
    : isSoftBlock
      ? `Instagram soft-block: страницы не грузятся, аккаунт помечен. Отправка остановлена, чтобы не получить полный бан. Дай аккаунту отдохнуть 24-48 часов, поюзай IG вручную, потом снижай daily_limit в 2 раза.`
      : `Instagram заблокировал действия: "${reason}". Все кампании приостановлены.`;

  const runningCampaigns = db.prepare(`SELECT id, name FROM campaigns WHERE status = 'running'`).all();
  const logEvent = isCircuitBreaker ? 'circuit_breaker' : isSoftBlock ? 'soft_blocked' : 'action_blocked';
  for (const c of runningCampaigns) {
    db.prepare(`UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ?`).run(getMoscowISO(), c.id);
    logCampaignEvent(db, c.id, logEvent, humanReason);
  }

  if (cl_id) {
    const prefix = isCircuitBreaker ? 'Circuit-breaker' : isSoftBlock ? 'Soft-block' : 'Action blocked';
    db.prepare(`UPDATE campaign_leads SET status = 'pending', error_message = ? WHERE id = ? AND status = 'sending'`).run(
      `${prefix}: ${reason}`, cl_id
    );
  }

  const kind = isCircuitBreaker ? 'circuit_breaker' : isSoftBlock ? 'soft' : 'hard';
  // Persist the block state so the UI can surface a big warning banner
  // even after the extension disconnects.
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ig_block_state', ?)`).run(JSON.stringify({
    kind,
    reason,
    at: getMoscowISO(),
    paused_campaigns: runningCampaigns.map(c => c.id)
  }));

  console.log(`[Extension] ${logEvent.toUpperCase()}: ${reason}. Paused ${runningCampaigns.length} campaigns.`);

  // This is the one alert worth waking the user for: the account is at risk
  // and every campaign just stopped. Fire-and-forget — a Telegram failure must
  // not turn a handled block into a 500.
  notify(
    req.workspace,
    `🚨 <b>Instagram ограничил действия</b>\n\n${escHtml(humanReason)}\n\n` +
    `Кампаний остановлено: <b>${runningCampaigns.length}</b>`,
    { key: `block:${kind}` }
  ).catch(() => {});

  res.json({ success: true, paused_campaigns: runningCampaigns.length, kind });
});

router.post('/inbox-message-sent', (req, res) => {
  const db = req.db;
  const { conv_id, username } = req.body;
  try {
    if (conv_id) {
      db.prepare(`UPDATE inbox_conversations SET updated_at = ? WHERE id = ?`)
        .run(getMoscowISO(), conv_id);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[inbox-message-sent] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/inbox-outbox', (req, res) => {
  const db = req.db;
  try {
    // thread_id may be missing (e.g. conversation created by a campaign send).
    // The extension resolves the thread from contact_username in that case.
    const messages = db.prepare(`
      SELECT im.id, im.conversation_id, im.text, im.created_at,
             ic.contact_username, ic.thread_id
      FROM inbox_messages im
      JOIN inbox_conversations ic ON ic.id = im.conversation_id
      WHERE im.pending_send = 1
        AND im.sender = 'me'
      ORDER BY im.id ASC
      LIMIT 5
    `).all();
    res.json({ messages });
  } catch (e) {
    console.error('[inbox-outbox] Error:', e.message);
    res.status(500).json({ error: e.message, messages: [] });
  }
});

router.post('/inbox-outbox/:msg_id/sent', (req, res) => {
  const db = req.db;
  try {
    const { thread_id } = req.body || {};
    db.prepare(`UPDATE inbox_messages SET pending_send = 0, sent_at = ?, error_message = NULL WHERE id = ?`)
      .run(getMoscowISO(), req.params.msg_id);
    const msg = db.prepare('SELECT conversation_id FROM inbox_messages WHERE id = ?').get(req.params.msg_id);
    if (msg?.conversation_id) {
      db.prepare('UPDATE inbox_conversations SET updated_at = ? WHERE id = ?').run(getMoscowISO(), msg.conversation_id);
      // Learn the thread id the first time we successfully message this contact.
      if (thread_id) {
        db.prepare('UPDATE inbox_conversations SET thread_id = ? WHERE id = ? AND (thread_id IS NULL OR thread_id = "")')
          .run(String(thread_id), msg.conversation_id);
      }
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[inbox-outbox/sent] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/inbox-outbox/:msg_id/failed', (req, res) => {
  const db = req.db;
  try {
    const { error_message } = req.body;
    db.prepare(`UPDATE inbox_messages SET pending_send = 1, error_message = ? WHERE id = ?`)
      .run(error_message || 'Unknown error', req.params.msg_id);
    res.json({ success: true });
  } catch (e) {
    console.error('[inbox-outbox/failed] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Records the outcome of a sync attempt so /sync-state (and the Inbox UI) can
// tell the user what actually happened — how many threads came back and, if
// none did, why (429, checkpoint, logged-out, network). Without this a failed
// sync looks identical to a successful empty one.
function recordSyncOutcome(db, { count, error }) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('inbox_sync_requested', '0')`).run();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('inbox_last_sync', ?)`).run(new Date().toISOString());
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('inbox_last_sync_error', ?)`).run(error || '');
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('inbox_last_sync_count', ?)`).run(String(count ?? 0));
}

router.post('/inbox-sync', (req, res) => {
  const db = req.db;
  const { conversations, error } = req.body;
  if (!conversations?.length) {
    recordSyncOutcome(db, { count: 0, error });
    return res.json({ success: true, synced: 0, error: error || null });
  }

  let synced = 0;

  function findConversation(conv) {
    if (conv.username) {
      const byUsername = db.prepare('SELECT * FROM inbox_conversations WHERE contact_username = ?').get(conv.username);
      if (byUsername) return byUsername;
    }
    if (conv.display_name) {
      const byName = db.prepare('SELECT * FROM inbox_conversations WHERE contact_name = ?').get(conv.display_name);
      if (byName) return byName;
    }
    if (conv.display_name) {
      const allConvs = db.prepare(`
        SELECT ic.*, l.full_name FROM inbox_conversations ic
        LEFT JOIN leads l ON l.username = ic.contact_username
        WHERE l.full_name = ? AND ic.label IN ('waiting', 'needs_reply', 'follow-up')
      `).all(conv.display_name);
      if (allConvs.length === 1) return allConvs[0];
    }
    return null;
  }

  // Instagram timestamps are microseconds since epoch.
  function igTsToIso(ts) {
    const n = Number(ts);
    if (!n || !isFinite(n)) return null;
    const ms = n > 1e14 ? Math.round(n / 1000) : n;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // A lead counts as replied as soon as the thread contains any incoming
  // message — not only while the thread is still unread. Answering from the
  // Inbox used to clear the unread flag before this ever ran.
  // sent_at is stored as Moscow wall-clock with no zone suffix, while reply
  // timestamps come from Instagram as UTC ISO strings. Comparing the two as
  // plain strings would be off by three hours, so both are normalised to epoch
  // milliseconds first.
  function moscowStampToMs(value) {
    if (!value) return NaN;
    const s = String(value).trim();
    if (!s) return NaN;
    if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) return Date.parse(s);
    return Date.parse(s.replace(' ', 'T') + '+03:00');
  }

  function markReplied(contactUsername, replyText, replyIso) {
    if (!contactUsername) return 0;
    const sentLeads = db.prepare(`
      SELECT cl.id, cl.campaign_id, cl.sent_at FROM campaign_leads cl
      JOIN leads l ON l.id = cl.lead_id
      WHERE l.username = ? AND cl.status = 'sent' AND cl.replied = 0
    `).all(contactUsername);

    const replyMs = moscowStampToMs(replyIso);

    let marked = 0;
    for (const sl of sentLeads) {
      // A message only counts as a reply to this campaign if it arrived after
      // our DM went out. Without this check any pre-existing conversation
      // history marks the lead as replied on the very first inbox sync, which
      // silently inflates the campaign's reply rate.
      const sentMs = moscowStampToMs(sl.sent_at);
      if (Number.isFinite(replyMs) && Number.isFinite(sentMs) && replyMs <= sentMs) {
        continue;
      }

      db.prepare(`UPDATE campaign_leads SET replied = 1, reply_text = ?, replied_at = ? WHERE id = ?`)
        .run(replyText || '', replyIso || getMoscowISO(), sl.id);
      logCampaignEvent(db, sl.campaign_id, 'reply_received', `Получен ответ от @${contactUsername}`);
      marked++;
    }

    if (marked) {
      // Throttled per contact, not globally: two different people replying is
      // two pieces of news, the same person's follow-ups are not.
      notify(
        req.workspace,
        `💬 <b>Ответ от @${escHtml(contactUsername)}</b>\n\n<i>${escHtml(String(replyText || '').slice(0, 300))}</i>\n\n` +
        'Ответить: /inbox',
        { key: `reply:${contactUsername}` }
      ).catch(() => {});
    }
    return marked;
  }

  // Insert full message history from API, dedup by item_id.
  // Reconciles locally-sent 'me' messages (no item_id) with their API copies.
  function syncMessages(conversationId, messages) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    let inserted = 0;

    for (const m of messages) {
      if (!m.item_id || !m.text) continue;

      const dup = db.prepare('SELECT id FROM inbox_messages WHERE conversation_id = ? AND item_id = ?')
        .get(conversationId, m.item_id);
      if (dup) continue;

      const iso = igTsToIso(m.timestamp) || getMoscowISO();
      const rawTs = Number(m.timestamp) || null;

      if (m.sender === 'me') {
        const localCopy = db.prepare(`
          SELECT id FROM inbox_messages
          WHERE conversation_id = ? AND sender = 'me' AND text = ? AND item_id IS NULL
          ORDER BY id DESC LIMIT 1
        `).get(conversationId, m.text);
        if (localCopy) {
          db.prepare('UPDATE inbox_messages SET item_id = ?, pending_send = 0, created_at = ?, ig_timestamp = ? WHERE id = ?')
            .run(m.item_id, iso, rawTs, localCopy.id);
          continue;
        }
      }

      db.prepare('INSERT INTO inbox_messages (conversation_id, sender, text, item_id, created_at, ig_timestamp) VALUES (?, ?, ?, ?, ?, ?)')
        .run(conversationId, m.sender === 'me' ? 'me' : 'them', m.text, m.item_id, iso, rawTs);
      inserted++;
    }
    return inserted;
  }

  for (const conv of conversations) {
    if (!conv.username && !conv.display_name) continue;

    let existing = null;
    if (conv.thread_id) {
      existing = db.prepare('SELECT * FROM inbox_conversations WHERE thread_id = ?').get(conv.thread_id);
    }
    if (!existing) existing = findConversation(conv);

    const lastFromThem = conv.last_message && !conv.last_message.startsWith('You:');
    const displayLast = conv.last_message || '';
    const activityRaw = Number(conv.last_activity_at) || null;
    const activityIso = igTsToIso(conv.last_activity_at);
    const igUnread = conv.is_unread && lastFromThem ? 1 : 0;

    let convId;

    if (existing) {
      convId = existing.id;

      const updates = [];
      const updateParams = [];
      if (conv.display_name && conv.display_name !== existing.contact_name) { updates.push('contact_name = ?'); updateParams.push(conv.display_name); }
      if (conv.avatar_url && conv.avatar_url !== existing.avatar_url) { updates.push('avatar_url = ?'); updateParams.push(conv.avatar_url); }
      if (conv.thread_id && !existing.thread_id) { updates.push('thread_id = ?'); updateParams.push(conv.thread_id); }
      if (displayLast && displayLast !== existing.last_message) { updates.push('last_message = ?'); updateParams.push(displayLast); }
      if (activityRaw && activityRaw !== existing.last_activity_at) { updates.push('last_activity_at = ?'); updateParams.push(activityRaw); }

      // Unread mirrors Instagram exactly. CRM labels belong to the user and a
      // sync never rewrites them.
      if (igUnread !== existing.unread) { updates.push('unread = ?'); updateParams.push(igUnread); }

      if (updates.length > 0) {
        updates.push('updated_at = ?'); updateParams.push(activityIso || getMoscowISO());
        db.prepare(`UPDATE inbox_conversations SET ${updates.join(', ')} WHERE id = ?`).run(...updateParams, existing.id);
        synced++;
      }
    } else {
      const uname = conv.username || conv.display_name.toLowerCase().replace(/[^a-z0-9_.]/g, '');
      const existingDup = db.prepare('SELECT * FROM inbox_conversations WHERE contact_username = ?').get(uname);
      if (existingDup) {
        convId = existingDup.id;
        db.prepare(`
          UPDATE inbox_conversations
          SET thread_id = COALESCE(NULLIF(thread_id, ''), ?),
              last_activity_at = COALESCE(?, last_activity_at),
              updated_at = ?
          WHERE id = ?
        `).run(conv.thread_id || null, activityRaw, activityIso || getMoscowISO(), existingDup.id);
      } else {
        const result = db.prepare(`
          INSERT INTO inbox_conversations
            (contact_username, contact_name, last_message, label, unread, avatar_url, thread_id, last_activity_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uname,
          conv.display_name || null,
          displayLast || null,
          igUnread ? 'needs_reply' : 'no_action',
          igUnread,
          conv.avatar_url || null,
          conv.thread_id || null,
          activityRaw,
          activityIso || getMoscowISO()
        );
        convId = result.lastInsertRowid;
        synced++;
      }
    }

    if (convId && conv.messages) {
      const newCount = syncMessages(convId, conv.messages);
      if (newCount > 0) synced += newCount;
    }

    // Reply detection reads the message history, so it still fires on threads
    // we have already answered (which clears Instagram's unread flag).
    if (convId) {
      const incoming = Array.isArray(conv.messages)
        ? conv.messages.filter(m => m.sender === 'them' && m.text)
        : [];
      const c = db.prepare('SELECT contact_username FROM inbox_conversations WHERE id = ?').get(convId);
      if (c && incoming.length > 0) {
        const latest = incoming[incoming.length - 1];
        markReplied(c.contact_username, latest.text, igTsToIso(latest.timestamp));
      } else if (c && conv.is_unread && lastFromThem) {
        markReplied(c.contact_username, displayLast, activityIso);
      }
    }
  }

  recordSyncOutcome(db, { count: conversations.length, error });

  res.json({ success: true, synced });
});

router.post('/account', async (req, res) => {
  const db = req.db;
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  if (!username) return res.status(400).json({ error: 'username required' });
  if (!req.user?.id) return res.status(401).json({ error: 'Sign in required' });

  const connectedAt = getMoscowISO();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ig_connected_account', ?)`).run(username);
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ig_connected_at', ?)`).run(connectedAt);

  // Update the exact device that made this request. This is important after
  // disconnect/reconnect: the browser may have several historical devices,
  // while the current extension token is the authoritative connection.
  const deviceToken = req.get('x-extension-token');
  const authDb = await getAuthDB();
  if (deviceToken) {
    authDb.prepare('UPDATE extension_devices SET instagram_username = ?, last_seen_at = ?, revoked = 0 WHERE token_hash = ? AND user_id = ?')
      .run(username, connectedAt, hashOpaqueToken(deviceToken), req.user.id);
  } else {
    authDb.prepare('UPDATE extension_devices SET instagram_username = ?, last_seen_at = ?, revoked = 0 WHERE user_id = ? AND revoked = 0')
      .run(username, connectedAt, req.user.id);
  }

  res.json({ success: true, username, connected_at: connectedAt });
});

router.get('/account', async (req, res) => {
  // The extension-device record is the single source of truth. It is tied to
  // the signed-in platform user and survives all workspace/URL changes.
  if (!req.user?.id) return res.status(401).json({ error: 'Sign in required' });
  const authDb = await getAuthDB();
  const device = authDb.prepare("SELECT instagram_username, created_at, last_seen_at FROM extension_devices WHERE user_id = ? AND revoked = 0 AND instagram_username IS NOT NULL AND instagram_username != '' ORDER BY last_seen_at DESC LIMIT 1").get(req.user.id);
  if (device?.instagram_username) {
    return res.json({ username: device.instagram_username, connected_at: device.created_at, last_seen_at: device.last_seen_at, source: 'extension_device' });
  }
  const db = req.db;
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ig_connected_account'`).get();
  const atRow = db.prepare(`SELECT value FROM settings WHERE key = 'ig_connected_at'`).get();
  res.json({ username: row?.value || null, connected_at: atRow?.value || null, source: 'legacy' });
});

router.post('/account/disconnect', async (req, res) => {
  const db = req.db;
  db.prepare(`DELETE FROM settings WHERE key = 'ig_connected_account'`).run();
  db.prepare(`DELETE FROM settings WHERE key = 'ig_connected_at'`).run();
  // Disconnect only the current user's devices. Keep the device row so the
  // same extension can reconnect and update its Instagram account later.
  if (req.user?.id) {
    const authDb = await getAuthDB();
    authDb.prepare('UPDATE extension_devices SET instagram_username = NULL, last_seen_at = ? WHERE user_id = ? AND revoked = 0').run(getMoscowISO(), req.user.id);
  }
  res.json({ success: true, workspace: req.user?.workspace || 'default' });
});

router.get('/status', (req, res) => {
  const db = req.db;
  const runningCampaigns = db.prepare(`
    SELECT c.id, c.name, c.status, c.min_delay, c.max_delay,
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
