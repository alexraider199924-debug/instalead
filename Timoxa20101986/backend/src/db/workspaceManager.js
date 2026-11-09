import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readdirSync, existsSync, copyFileSync, mkdirSync, readFileSync, unlinkSync, statSync } from 'fs';
import { createDB } from './compat.js';
import { getAuthDB } from './authDb.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Share the same durable data directory as users.db. Configure this to a
// persistent volume path in production; local installs retain backend/data.
const DATA_DIR = process.env.INSTALEAD_DATA_DIR
  ? resolve(process.env.INSTALEAD_DATA_DIR)
  : join(__dirname, '../../data');
const BACKUP_DIR = join(DATA_DIR, 'backups');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(BACKUP_DIR, { recursive: true });

const OLD_DB_PATH = join(DATA_DIR, 'instaworm.db');
const DEFAULT_DB_PATH = join(DATA_DIR, 'instaworm_default.db');
if (existsSync(OLD_DB_PATH) && !existsSync(DEFAULT_DB_PATH)) {
  copyFileSync(OLD_DB_PATH, DEFAULT_DB_PATH);
  console.log('[Workspace] Migrated instaworm.db → instaworm_default.db');
}

await migrateOldFormatWorkspaces();

// Renaming a database file is only half of a rename: users.db still refers to
// the workspace by name, and a name that no longer matches any file opens a
// brand-new empty database instead. The account keeps its login and silently
// loses every contact, campaign and lead. References have to follow the files.
async function rewriteAuthWorkspaceRefs(renamed) {
  if (!renamed.length) return;
  try {
    const auth = await getAuthDB();
    for (const [from, to] of renamed) {
      auth.prepare('UPDATE users SET workspace = ? WHERE workspace = ?').run(to, from);
      auth.prepare('UPDATE user_workspaces SET workspace = ? WHERE workspace = ?').run(to, from);
    }
    console.log(`[Workspace] ✓ Updated workspace references in users.db: ${renamed.map(([f, t]) => `${f} → ${t}`).join(', ')}`);
  } catch (e) {
    console.error('[Workspace] Could not update workspace references in users.db:', e.message);
  }
}

async function migrateOldFormatWorkspaces() {
  // Collected across the whole loop and applied even if a file fails midway:
  // the old file is unlinked in every branch, so a reference left behind by an
  // early exit points at nothing.
  const renamed = [];
  try {
    const files = readdirSync(DATA_DIR).filter(f => f.startsWith('instaworm_') && f.endsWith('.db'));

    for (const f of files) {
      const name = f.replace(/^instaworm_/, '').replace(/\.db$/, '');
      if (name === 'default' || name.startsWith('ig_')) continue;

      const oldPath = join(DATA_DIR, f);
      const newName = `ig_${name}`;
      const newPath = join(DATA_DIR, `instaworm_${newName}.db`);
      renamed.push([name, newName]);

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safetyBackup = join(BACKUP_DIR, `pre-migration_${name}_${ts}.db`);
      try { copyFileSync(oldPath, safetyBackup); } catch {}

      if (existsSync(newPath)) {
        const oldScore = await countRecords(oldPath);
        const newScore = await countRecords(newPath);
        const oldSummary = `campaigns=${oldScore.campaigns} contacts=${oldScore.contacts} leads=${oldScore.leads}`;
        const newSummary = `campaigns=${newScore.campaigns} contacts=${newScore.contacts} leads=${newScore.leads}`;

        if (oldScore.total > newScore.total) {
          const displaced = join(BACKUP_DIR, `displaced_ig_${name}_${ts}.db`);
          try { copyFileSync(newPath, displaced); } catch {}
          copyFileSync(oldPath, newPath);
          console.log(`[Workspace] ✓ RECOVERED "${newName}": old file "${f}" (${oldSummary}) restored over emptier new file (${newSummary}). Displaced backup: ${displaced}`);
        } else {
          console.log(`[Workspace] "${f}" (${oldSummary}) not richer than "instaworm_${newName}.db" (${newSummary}) — leaving current file. Safety backup: ${safetyBackup}`);
        }
      } else {
        copyFileSync(oldPath, newPath);
        const score = await countRecords(newPath);
        console.log(`[Workspace] ✓ Migrated "${f}" → "instaworm_${newName}.db" (campaigns=${score.campaigns} contacts=${score.contacts} leads=${score.leads}). Safety backup: ${safetyBackup}`);
      }

      try {
        const legacyBackup = join(BACKUP_DIR, `legacy_${f}`);
        if (!existsSync(legacyBackup)) copyFileSync(oldPath, legacyBackup);
        unlinkSync(oldPath);
      } catch (e) {
        console.error(`[Workspace] Could not remove legacy file "${f}":`, e.message);
      }
    }
  } catch (e) {
    console.error('[Workspace] migrateOldFormatWorkspaces error:', e.message);
  } finally {
    await rewriteAuthWorkspaceRefs(renamed);
  }
}

async function countRecords(dbPath) {
  const out = { campaigns: 0, contacts: 0, leads: 0, total: 0 };
  try {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const db = new SQL.Database(readFileSync(dbPath));
    for (const t of ['campaigns', 'contacts', 'campaign_leads', 'leads', 'inbox_conversations', 'inbox_messages', 'pipeline_contacts']) {
      try {
        const r = db.exec(`SELECT COUNT(*) FROM ${t}`);
        const c = r[0]?.values[0][0] || 0;
        if (t === 'campaigns') out.campaigns = c;
        if (t === 'contacts') out.contacts = c;
        if (t === 'campaign_leads' || t === 'leads') out.leads += c;
        out.total += c;
      } catch {}
    }
    db.close();
  } catch {}
  return out;
}

function safeSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

const dbCache = new Map();

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'default';
}

async function initSchema(db) {
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT,
      email TEXT,
      bio TEXT,
      niche TEXT,
      notes TEXT,
      status TEXT DEFAULT 'new',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      message_template TEXT NOT NULL,
      ai_provider TEXT DEFAULT 'claude',
      ai_generated INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      scheduled_at TEXT,
      delay_seconds INTEGER DEFAULT 30,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS campaign_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      message_sent TEXT,
      sent_at TEXT,
      error_message TEXT,
      offer_num INTEGER DEFAULT 1,
      UNIQUE(campaign_id, lead_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT OR IGNORE INTO settings (key, value) VALUES ('anthropic_api_key', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('openai_api_key', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('default_ai_provider', 'claude');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('app_name', 'Instalead');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'RUB');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('openrouter_api_key', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('openrouter_model', 'openai/gpt-4o-mini');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('inbox_agent_enabled', '0');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('warmup_enabled', '0');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('warmup_started_at', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('warmup_completed', '0');
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT,
      details TEXT,
      notes TEXT,
      lead_quality TEXT DEFAULT 'unknown',
      deal_won INTEGER DEFAULT 0,
      deal_value REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pipelines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6b7280',
      position INTEGER DEFAULT 0,
      FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS pipeline_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER NOT NULL,
      stage_id INTEGER NOT NULL,
      contact_id INTEGER NOT NULL,
      UNIQUE(pipeline_id, contact_id),
      FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
      FOREIGN KEY (stage_id) REFERENCES pipeline_stages(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS inbox_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_username TEXT NOT NULL,
      contact_name TEXT,
      last_message TEXT,
      label TEXT DEFAULT 'needs_reply',
      unread INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ai_business_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field TEXT NOT NULL UNIQUE,
      value TEXT DEFAULT ''
    );
    INSERT OR IGNORE INTO pipelines (id, name) VALUES (1, 'Default Pipeline');
    INSERT OR IGNORE INTO pipeline_stages (id, pipeline_id, name, color, position) VALUES (1, 1, 'New Lead', '#3b82f6', 0);
    INSERT OR IGNORE INTO pipeline_stages (id, pipeline_id, name, color, position) VALUES (2, 1, 'Contacted', '#f59e0b', 1);
    INSERT OR IGNORE INTO pipeline_stages (id, pipeline_id, name, color, position) VALUES (3, 1, 'Interested', '#8b5cf6', 2);
    INSERT OR IGNORE INTO pipeline_stages (id, pipeline_id, name, color, position) VALUES (4, 1, 'Deal Won', '#22c55e', 3);
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('business_offer', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('voice_tone', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('boundaries', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('links', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('conversation_goal', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('qualification', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('questions_pricing', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('followups', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('agent_version', '1');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('company_description', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('product_name', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('target_audience', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('problem_solved', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('result_created', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('unique_value', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('sender_name', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('tone', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('language', 'ru');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('sample_message', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('link_website', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('link_instagram', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('link_telegram', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('link_other', '');
    -- Offer structure. The engine reads all of these; a DM that mixes an offer
    -- into a personalized opener needs the offer itself split into parts, not
    -- one blob pasted from a landing page. Defaults are inserted on every boot,
    -- so existing workspaces pick the new fields up without a migration.
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('offer_delivery', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('offer_price', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('offer_cta', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('offer_hook', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('how_it_works', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('proof', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('guarantee', '');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('message_structure', '1. Personalization\n2. Relevant problem / opportunity\n3. Offer\n4. Proof\n5. CTA');
    -- Personalization policy: how the opener is assembled, not what it says.
    -- voice_tone is seeded at the top of this block (free-form description of
    -- the sender's voice; "tone" stays a closed enum for the UI picker).
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('personalization_opening', 'profile_first');
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('personalization_greeting', 'auto');
    -- Enrichment output budget: the per-contact profile note the send step
    -- reads instead of re-reading the profile.
    INSERT OR IGNORE INTO ai_business_context (field, value) VALUES ('summary_language', 'ru');
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender TEXT NOT NULL DEFAULT 'me',
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES inbox_conversations(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ai_prompt_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_username TEXT NOT NULL,
      target_user_id TEXT,
      target_follower_total INTEGER,
      requested_count INTEGER NOT NULL,
      enrich_limit INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      phase TEXT DEFAULT 'resolve',
      scraped_count INTEGER DEFAULT 0,
      enriched_count INTEGER DEFAULT 0,
      next_cursor TEXT,
      consecutive_errors INTEGER DEFAULT 0,
      error_message TEXT,
      last_progress_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS scrape_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      full_name TEXT,
      ig_user_id TEXT,
      is_private INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      profile_pic_url TEXT,
      bio TEXT,
      follower_count INTEGER,
      following_count INTEGER,
      post_count INTEGER,
      external_url TEXT,
      enriched INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(job_id, username),
      FOREIGN KEY (job_id) REFERENCES scrape_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scrape_results_job ON scrape_results(job_id);
    CREATE INDEX IF NOT EXISTS idx_scrape_results_enrich ON scrape_results(job_id, enriched);
    CREATE TABLE IF NOT EXISTS ig_request_budget (
      day TEXT PRIMARY KEY,
      scrape_requests INTEGER DEFAULT 0
    );

    -- AI lead search. Unlike scrape_jobs, which pages one known account's
    -- follower list, a search job fans out over several Instagram search
    -- surfaces (keyword / hashtag / place) derived from a natural-language
    -- query. Each surface is a row in lead_search_sources with its own cursor
    -- so one dead source can't stall the others.
    CREATE TABLE IF NOT EXISTS lead_search_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_text TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      phase TEXT DEFAULT 'discover',
      target_count INTEGER NOT NULL,
      enrich_limit INTEGER DEFAULT 0,
      discovered_count INTEGER DEFAULT 0,
      enriched_count INTEGER DEFAULT 0,
      scored_count INTEGER DEFAULT 0,
      matched_count INTEGER DEFAULT 0,
      consecutive_errors INTEGER DEFAULT 0,
      error_message TEXT,
      last_progress_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS lead_search_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      ig_id TEXT,
      cursor TEXT,
      page INTEGER DEFAULT 0,
      found_count INTEGER DEFAULT 0,
      exhausted INTEGER DEFAULT 0,
      error_message TEXT,
      UNIQUE(job_id, kind, value),
      FOREIGN KEY (job_id) REFERENCES lead_search_jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS lead_search_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      full_name TEXT,
      ig_user_id TEXT,
      source_kind TEXT,
      source_value TEXT,
      post_caption TEXT,
      post_location TEXT,
      bio TEXT,
      follower_count INTEGER,
      following_count INTEGER,
      post_count INTEGER,
      external_url TEXT,
      is_private INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      prefiltered INTEGER DEFAULT 0,
      prefilter_reason TEXT,
      enriched INTEGER DEFAULT 0,
      scored INTEGER DEFAULT 0,
      ai_score INTEGER,
      ai_geo TEXT,
      ai_geo_confidence TEXT,
      ai_reason TEXT,
      matched INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(job_id, username),
      FOREIGN KEY (job_id) REFERENCES lead_search_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_lsr_job ON lead_search_results(job_id);
    CREATE INDEX IF NOT EXISTS idx_lsr_enrich ON lead_search_results(job_id, prefiltered, enriched);
    CREATE INDEX IF NOT EXISTS idx_lsr_score ON lead_search_results(job_id, scored);
    CREATE INDEX IF NOT EXISTS idx_lss_job ON lead_search_sources(job_id, exhausted);

    -- Contact enrichment: the batch job behind "ИИ-обогатить" in Contacts.
    -- Same skeleton as lead_search_jobs on purpose — the extension already
    -- speaks that protocol, so a new job type costs a loop, not a new engine.
    --
    -- The rows here are a WORK QUEUE, not the result. What survives the job is
    -- written into leads.profile_summary / profile_summary_meta, which is where
    -- the send path already joins. Keeping the two apart means re-running a job
    -- overwrites cleanly instead of having to reconcile two copies.
    CREATE TABLE IF NOT EXISTS contact_enrich_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'pending',
      phase TEXT DEFAULT 'scrape',
      total_count INTEGER DEFAULT 0,
      scraped_count INTEGER DEFAULT 0,
      summarized_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      -- Wall-clock minutes of activity allowed before the job pauses itself.
      -- Resumable, so "run it for an hour, then again later" is the default
      -- shape rather than something the user has to babysit.
      run_minutes INTEGER DEFAULT 60,
      consecutive_errors INTEGER DEFAULT 0,
      error_message TEXT,
      last_progress_at TEXT,
      -- When Instagram's own rate limit made the extension step away, and until
      -- when. Not a failure: the job resumes by itself the moment the cooldown
      -- ends. Kept out of error_message because a 429 is an expected wait shown
      -- in amber, while a broken key or model is a red error — and during a
      -- cooldown the UI otherwise blames the extension for being offline, which
      -- is the one thing that is actually working.
      ig_backoff_until TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS contact_enrich_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      scraped INTEGER DEFAULT 0,
      summarized INTEGER DEFAULT 0,
      -- Raw material kept for debugging a bad конспект without re-hitting
      -- Instagram, which is the expensive and rate-limited part.
      bio TEXT,
      full_name TEXT,
      follower_count INTEGER,
      post_count INTEGER,
      external_url TEXT,
      is_private INTEGER DEFAULT 0,
      -- Post captions as JSON. Storing them means the AI pass can be re-run or
      -- debugged without touching Instagram again, which is the rate-limited
      -- and account-risk part of the pipeline.
      posts_json TEXT,
      summary TEXT,
      hooks TEXT,
      meta TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(job_id, username),
      FOREIGN KEY (job_id) REFERENCES contact_enrich_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cer_job ON contact_enrich_results(job_id, summarized);
    CREATE INDEX IF NOT EXISTS idx_cer_pending ON contact_enrich_results(job_id, scraped, summarized);
  `);

  const migrations = [
    'ALTER TABLE campaigns ADD COLUMN daily_limit INTEGER DEFAULT 50',
    'ALTER TABLE campaigns ADD COLUMN send_time TEXT',
    'ALTER TABLE campaigns ADD COLUMN min_delay INTEGER DEFAULT 7',
    'ALTER TABLE campaigns ADD COLUMN max_delay INTEGER DEFAULT 17',
    'ALTER TABLE contacts ADD COLUMN email TEXT',
    'ALTER TABLE contacts ADD COLUMN phone TEXT',
    'ALTER TABLE contacts ADD COLUMN company TEXT',
    'ALTER TABLE campaign_leads ADD COLUMN replied INTEGER DEFAULT 0',
    'ALTER TABLE campaign_leads ADD COLUMN reply_text TEXT',
    'ALTER TABLE campaigns ADD COLUMN follow_profile INTEGER DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN wait_for_reply INTEGER DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN value_per_lead REAL DEFAULT 0',
    'ALTER TABLE campaigns ADD COLUMN schedule_days TEXT',
    'ALTER TABLE campaigns ADD COLUMN schedule_start TEXT DEFAULT "09:00"',
    'ALTER TABLE campaigns ADD COLUMN schedule_end TEXT DEFAULT "18:00"',
    'ALTER TABLE campaigns ADD COLUMN skip_contacted INTEGER DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN stop_on_reply INTEGER DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN pause_unsafe INTEGER DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN safe_delays INTEGER DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN warmup INTEGER DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN ai_prompt TEXT',
    "ALTER TABLE campaigns ADD COLUMN personalization_mode TEXT DEFAULT 'template'",
    "ALTER TABLE campaigns ADD COLUMN personalization_style TEXT DEFAULT 'neutral'",
    'ALTER TABLE campaigns ADD COLUMN personalization_custom_prompt TEXT',
    'ALTER TABLE campaigns ADD COLUMN like_last_post INTEGER DEFAULT 0',
    'ALTER TABLE campaign_leads ADD COLUMN replied_at TEXT',
    'ALTER TABLE campaigns ADD COLUMN archived INTEGER DEFAULT 0',
    'ALTER TABLE campaigns ADD COLUMN started_at TEXT',
    // Follow→DM prewarm ("прогрев лида"): when on, a lead is followed (+liked)
    // on the first touch and messaged only after prewarm_delay_hours have
    // passed — splitting the bot-obvious follow+DM burst across two days.
    // Defaults OFF so existing campaigns keep their single-session behaviour.
    'ALTER TABLE campaigns ADD COLUMN prewarm_follow INTEGER DEFAULT 0',
    'ALTER TABLE campaigns ADD COLUMN prewarm_delay_hours INTEGER DEFAULT 24',
    // Timestamp of the follow phase; drives the DM-eligibility delay and lets
    // the sending-lock reclaim below know a lead belongs in the DM queue
    // ('followed') rather than back at the start ('pending').
    'ALTER TABLE campaign_leads ADD COLUMN followed_at TEXT',
    "ALTER TABLE inbox_conversations ADD COLUMN created_at TEXT DEFAULT (datetime('now'))",
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_contact_username ON inbox_conversations(contact_username)',
    'ALTER TABLE inbox_conversations ADD COLUMN avatar_url TEXT',
    'ALTER TABLE inbox_conversations ADD COLUMN thread_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_inbox_thread_id ON inbox_conversations(thread_id)',
    'ALTER TABLE inbox_messages ADD COLUMN pending_send INTEGER DEFAULT 0',
    'ALTER TABLE inbox_messages ADD COLUMN sent_at TEXT',
    'ALTER TABLE inbox_messages ADD COLUMN error_message TEXT',
    'ALTER TABLE inbox_messages ADD COLUMN item_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_inbox_messages_pending ON inbox_messages(pending_send)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_messages_item ON inbox_messages(conversation_id, item_id) WHERE item_id IS NOT NULL',
    'ALTER TABLE inbox_messages ADD COLUMN ig_timestamp INTEGER',
    'ALTER TABLE inbox_conversations ADD COLUMN last_activity_at INTEGER',
    'CREATE INDEX IF NOT EXISTS idx_inbox_conv_activity ON inbox_conversations(last_activity_at)',
    'CREATE INDEX IF NOT EXISTS idx_inbox_messages_ts ON inbox_messages(conversation_id, ig_timestamp)',
    'ALTER TABLE campaigns ADD COLUMN offers TEXT',
    `UPDATE campaign_leads SET sent_at = datetime('now', '+3 hours') WHERE status = 'failed' AND sent_at IS NULL`,
    'ALTER TABLE campaign_leads ADD COLUMN offer_num INTEGER DEFAULT 1',
    'ALTER TABLE campaigns ADD COLUMN use_smart_personalization INTEGER DEFAULT 0',
    // Profile insight, produced once during contact enrichment and reused by
    // every later send. `leads` is the row the send path joins to
    // (campaign_leads -> leads), so this is the only place it has to live to be
    // reachable at personalization time.
    'ALTER TABLE leads ADD COLUMN profile_summary TEXT',
    // Prompt version + model + word count for the summary above. The send path
    // re-enriches instead of writing a stale summary into a DM when the
    // generator version no longer matches.
    'ALTER TABLE leads ADD COLUMN profile_summary_meta TEXT',
    'ALTER TABLE leads ADD COLUMN profile_enriched_at TEXT',
    // none | queued | working | done | failed — drives the Contacts column and
    // makes a failed enrichment distinguishable from an empty profile.
    'ALTER TABLE leads ADD COLUMN enrich_status TEXT DEFAULT \'none\'',
    'ALTER TABLE leads ADD COLUMN enrich_error TEXT',
    'CREATE INDEX IF NOT EXISTS idx_leads_enrich ON leads(enrich_status)',
    // The seeded default for personalization_length was 320 when this field was
    // first introduced. It has never been settable by a user before that, so a
    // stored 320 can only be our own seed — bump it to the 420 default instead
    // of leaving every existing workspace on a shorter message than intended.
    `UPDATE ai_business_context SET value = '420' WHERE field = 'personalization_length' AND value = '320'`,
    "UPDATE leads SET enrich_status = 'none' WHERE enrich_status IS NULL OR enrich_status = ''",
    // Instagram's cooldown on a running enrichment job, kept out of error_message
    // so the UI can show it as the wait it is rather than as a broken job.
    'ALTER TABLE contact_enrich_jobs ADD COLUMN last_instagram_call INTEGER',
    "ALTER TABLE campaign_leads ADD COLUMN personalization_status TEXT DEFAULT 'not_ready'",
    'ALTER TABLE campaign_leads ADD COLUMN personalization_summary_version INTEGER',
    'ALTER TABLE campaign_leads ADD COLUMN personalization_summary_hash TEXT',
    'ALTER TABLE campaign_leads ADD COLUMN personalization_agent_version INTEGER',
    'ALTER TABLE campaign_leads ADD COLUMN personalization_hook TEXT',
    'ALTER TABLE campaign_leads ADD COLUMN personalization_problem TEXT',
    'ALTER TABLE campaign_leads ADD COLUMN personalization_offer_angle TEXT',
    'ALTER TABLE campaign_leads ADD COLUMN personalization_cta TEXT',
    'ALTER TABLE campaign_leads ADD COLUMN personalization_generated_at TEXT',
    'CREATE TABLE IF NOT EXISTS ai_personalization_history (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, company_id TEXT, campaign_id INTEGER, summary_version INTEGER, ai_agent_version INTEGER, personalization_hook TEXT, relevant_problem TEXT, offer_angle TEXT, cta TEXT, final_message TEXT, generated_at TEXT, FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE, FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL)',
    'CREATE INDEX IF NOT EXISTS idx_ai_personalization_history_lead ON ai_personalization_history(lead_id, generated_at)',
    'ALTER TABLE contact_enrich_jobs ADD COLUMN ig_backoff_until TEXT',
  ];

  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch (e) {
      // ALTER TABLE is intentionally idempotent for already-migrated databases.
      // Other migration failures must remain visible instead of leaving a partial schema.
      if (!/duplicate column name|already exists/i.test(e.message || '')) {
        console.error('[Workspace] Migration failed:', sql, e.message);
        throw e;
      }
    }
  }
}

export async function getDB(workspace) {
  let name = sanitizeName(workspace || 'default');
  if (dbCache.has(name)) return dbCache.get(name);

  let filePath = join(DATA_DIR, `instaworm_${name}.db`);

  // A workspace can still be referred to by a name that no longer matches any
  // file on disk — the migration above renames instaworm_<n>.db to
  // instaworm_ig_<n>.db, and any reference that missed the rename would open a
  // fresh empty database, which reads to the user as "the deploy wiped my
  // account". Prefer the existing prefixed file over an empty new one.
  if (!existsSync(filePath) && name !== 'default' && !name.startsWith('ig_')) {
    const prefixed = join(DATA_DIR, `instaworm_ig_${name}.db`);
    if (existsSync(prefixed)) {
      console.warn(`[Workspace] ⚠️  No database named "${name}", but "ig_${name}" exists — using it. The stored workspace name is stale.`);
      name = `ig_${name}`;
      filePath = prefixed;
    }
  }
  if (dbCache.has(name)) return dbCache.get(name);

  const isNew = !existsSync(filePath);
  if (isNew && name !== 'default') {
    console.warn(`[Workspace] ⚠️  Creating NEW empty database for workspace "${name}" at ${filePath}. If you expected existing data here, check data/ for legacy files and data/backups/ for prior snapshots.`);
  }

  try {
    const db = await createDB(filePath);
    await initSchema(db);
    // Services that only receive a db handle (scheduler, notifier hooks) need
    // to know which tenant it belongs to.
    db.workspaceName = name;
    dbCache.set(name, db);
    return db;
  } catch (e) {
    // "file is not a database" or similar SQLite parse error: the on-disk
    // file is corrupt (truncated copy, WAL not merged, wrong format).
    // Quarantine the bad file so it doesn't crash every startup, warn the
    // operator, and continue with an empty DB. The corrupt file is kept
    // for manual recovery.
    if (!isNew && /not a database|malformed|corrupt|file is encrypted/i.test(e.message || '')) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const quarantined = join(BACKUP_DIR, `corrupt_${name}_${ts}.db`);
      mkdirSync(BACKUP_DIR, { recursive: true });
      try {
        copyFileSync(filePath, quarantined);
        unlinkSync(filePath);
        console.error(`[Workspace] ❌ CORRUPT DB for "${name}": ${e.message}. Moved to ${quarantined}. Starting with empty DB — restore manually via /api/settings/diagnostics/restore-legacy if needed.`);
      } catch (mvErr) {
        console.error(`[Workspace] ❌ CORRUPT DB for "${name}" AND could not quarantine: ${mvErr.message}. Skipping this workspace.`);
        throw e;
      }
      const db = await createDB(filePath);
      await initSchema(db);
      db.workspaceName = name;
      dbCache.set(name, db);
      return db;
    }
    throw e;
  }
}

export function getAllWorkspaceDBs() {
  return dbCache;
}

export async function listWorkspaces() {
  try {
    const files = readdirSync(DATA_DIR).filter(f => f.startsWith('instaworm_') && f.endsWith('.db'));
    return files.map(f => f.replace('instaworm_', '').replace('.db', ''));
  } catch {
    return ['default'];
  }
}

export async function loadAllWorkspaces() {
  const names = await listWorkspaces();
  const failures = [];
  for (const name of names) {
    try {
      await getDB(name);
    } catch (e) {
      // Never let one bad workspace take down the whole server. Log
      // loudly so the operator sees it; other workspaces keep working.
      console.error(`[Workspace] Skipping workspace "${name}" due to load error: ${e.message}`);
      failures.push({ name, error: e.message });
    }
  }
  if (failures.length > 0) {
    console.warn(`[Workspace] ⚠️  ${failures.length} workspace(s) failed to load:`,
      failures.map(f => `${f.name} (${f.error})`).join('; '));
  }
  backupAll();
  setInterval(backupAll, 60 * 60 * 1000);
}

function backupAll() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  try {
    const files = readdirSync(DATA_DIR).filter(f => f.startsWith('instaworm_') && f.endsWith('.db'));
    for (const f of files) {
      const src = join(DATA_DIR, f);
      const name = f.replace('.db', '');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dst = join(BACKUP_DIR, `${name}_${ts}.db`);
      try {
        copyFileSync(src, dst);
      } catch (e) {
        console.error(`[Backup] Failed to backup ${f}:`, e.message);
      }
    }
    cleanOldBackups();
    console.log('[Backup] Auto-backup completed for', files.length, 'workspace(s)');
  } catch (e) {
    console.error('[Backup] Auto-backup failed:', e.message);
  }
}

function cleanOldBackups() {
  try {
    const files = readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort();
    const byWorkspace = {};
    for (const f of files) {
      const ws = f.replace(/_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/, '');
      if (!byWorkspace[ws]) byWorkspace[ws] = [];
      byWorkspace[ws].push(f);
    }
    for (const [, wFiles] of Object.entries(byWorkspace)) {
      while (wFiles.length > 10) {
        const old = wFiles.shift();
        try { unlinkSync(join(BACKUP_DIR, old)); } catch {}
      }
    }
  } catch {}
}

export function getWorkspaceDbPath(workspace) {
  const name = sanitizeName(workspace || 'default');
  return join(DATA_DIR, `instaworm_${name}.db`);
}

export function getBackupDir() {
  return BACKUP_DIR;
}

export function listBackups(workspace) {
  const name = sanitizeName(workspace || 'default');
  const prefix = `instaworm_${name}_`;
  mkdirSync(BACKUP_DIR, { recursive: true });
  try {
    return readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.db'))
      .sort()
      .reverse()
      .map(f => {
        const ts = f.replace(prefix, '').replace('.db', '').replace(/-/g, (m, i) => i < 13 ? m : i === 13 ? 'T' : ':').replace('T', 'T');
        return { filename: f, created_at: ts };
      });
  } catch {
    return [];
  }
}

export async function restoreFromBackup(workspace, backupFilename) {
  const name = sanitizeName(workspace || 'default');
  const backupPath = join(BACKUP_DIR, backupFilename);
  if (!existsSync(backupPath)) throw new Error('Backup file not found');
  if (!backupFilename.startsWith(`instaworm_${name}_`)) throw new Error('Backup does not match workspace');

  const dbPath = join(DATA_DIR, `instaworm_${name}.db`);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (existsSync(dbPath)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    copyFileSync(dbPath, join(BACKUP_DIR, `instaworm_${name}_pre-restore_${ts}.db`));
  }

  copyFileSync(backupPath, dbPath);
  dbCache.delete(name);
  await getDB(name);
  return true;
}

export function listAllDbFiles(workspace) {
  const name = sanitizeName(workspace || 'default');
  const dataPrefix = `instaworm_${name}.db`;
  const backupPrefix = `instaworm_${name}_`;
  const dataFiles = safeReaddir(DATA_DIR)
    .filter(f => f === dataPrefix)
    .map(f => ({ name: f, size: safeSize(join(DATA_DIR, f)), location: 'data' }));
  const backupFiles = safeReaddir(BACKUP_DIR)
    .filter(f => f.startsWith(backupPrefix) && f.endsWith('.db'))
    .map(f => ({ name: f, size: safeSize(join(BACKUP_DIR, f)), location: 'backups' }));
  return { data_dir: dataFiles, backups: backupFiles };
}

export async function restoreLegacyFile(workspace, filename) {
  const name = sanitizeName(workspace || 'default');
  if (!/^[a-zA-Z0-9_.-]+\.db$/.test(filename)) throw new Error('Invalid filename');
  const allowedBackup = filename.startsWith(`instaworm_${name}_`);
  const allowedData = filename === `instaworm_${name}.db`;
  if (!allowedBackup && !allowedData) throw new Error('File does not belong to workspace');

  let src = join(BACKUP_DIR, filename);
  if (!existsSync(src)) {
    src = join(DATA_DIR, filename);
    if (!existsSync(src)) throw new Error('File not found');
  }

  const dbPath = join(DATA_DIR, `instaworm_${name}.db`);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (existsSync(dbPath)) {
    const bkp = join(BACKUP_DIR, `instaworm_${name}_pre-legacy-restore_${ts}.db`);
    copyFileSync(dbPath, bkp);
  }
  copyFileSync(src, dbPath);
  dbCache.delete(name);
  await getDB(name);
  return { restored_from: src, size: safeSize(dbPath) };
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

export function exportDb(workspace) {
  const name = sanitizeName(workspace || 'default');
  const dbPath = join(DATA_DIR, `instaworm_${name}.db`);
  if (!existsSync(dbPath)) throw new Error('Workspace database not found');
  return readFileSync(dbPath);
}

export async function importDb(workspace, buffer) {
  const name = sanitizeName(workspace || 'default');
  const dbPath = join(DATA_DIR, `instaworm_${name}.db`);
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.length > 10 * 1024 * 1024) {
    throw new Error('Invalid database file');
  }

  const tempPath = join(DATA_DIR, `.instaworm_${name}.${process.pid}.${Date.now()}.tmp`);
  const { writeFileSync, renameSync, unlinkSync: removeFile } = await import('fs');
  writeFileSync(tempPath, buffer, { flag: 'wx' });
  try {
    const candidate = await createDB(tempPath);
    await initSchema(candidate);
    candidate._persist();
    if (existsSync(dbPath)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      copyFileSync(dbPath, join(BACKUP_DIR, `instaworm_${name}_pre-import_${ts}.db`));
    }
    renameSync(tempPath, dbPath);
    dbCache.delete(name);
    await getDB(name);
    return true;
  } catch (e) {
    try { removeFile(tempPath); } catch {}
    throw new Error(`Database import rejected: ${e.message}`);
  }
}
