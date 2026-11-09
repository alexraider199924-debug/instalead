import { Router } from 'express';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { getMoscowISO } from '../services/schedulerService.js';
import { createEnrichJob, jobWithProgress, enrichReadiness } from '../services/contactEnrichJob.js';
import { ENRICH_VERSION } from '../services/contactEnrichService.js';

const router = Router();

// Outreach state per contact, aggregated across every campaign the matching
// lead appears in. Grouped in a derived table rather than correlated
// subqueries so the whole page costs one pass instead of one query per row.
// Joined on username because contacts and leads are separate tables that only
// share that key.
const OUTREACH_JOIN = `
  LEFT JOIN (
    SELECT l.username AS o_username,
      MAX(cl.replied) AS o_replied,
      MAX(CASE WHEN cl.status IN ('sent','sending') THEN 1 ELSE 0 END) AS o_sent,
      MAX(CASE WHEN cl.status = 'failed' THEN 1 ELSE 0 END) AS o_failed,
      MAX(CASE WHEN cl.status = 'skipped' THEN 1 ELSE 0 END) AS o_skipped,
      MAX(cl.sent_at) AS o_sent_at,
      MAX(cl.replied_at) AS o_replied_at
    FROM campaign_leads cl
    JOIN leads l ON l.id = cl.lead_id
    GROUP BY l.username
  ) o ON o.o_username = c.username`;

// Only states that actually happened get a label. A lead sitting in a queue
// has no outreach history yet, so it reports null and the UI shows nothing —
// deliberately no "awaiting"/"pending" wording.
function deriveOutreach(row) {
  if (row.o_replied) return { status: 'replied', at: row.o_replied_at || row.o_sent_at };
  if (row.o_sent) return { status: 'sent', at: row.o_sent_at };
  if (row.o_failed) return { status: 'failed', at: row.o_sent_at };
  if (row.o_skipped) return { status: 'skipped', at: row.o_sent_at };
  return { status: null, at: null };
}

// Joined on username because contacts and leads are separate tables that only
// share that key. The enrichment columns live on `leads` — that is where the
// send path reads them from — so the Contacts page joins across rather than
// keeping a second copy that could drift.
const LEADS_JOIN = `
  LEFT JOIN leads el ON el.username = c.username`;

router.get('/', (req, res) => {
  const db = req.db;
  const { search, deal_won, lead_quality, enrich_status, page = 1, limit = 50 } = req.query;

  // WHERE is built once and shared by the page query and the count query.
  // These used to be derived from each other with a regex over the SELECT
  // clause, which silently breaks the moment the column list is reformatted.
  let where = ' WHERE 1=1';
  const params = [];

  if (search) {
    where += ' AND (c.username LIKE ? OR c.full_name LIKE ? OR c.email LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (deal_won !== undefined) {
    where += ' AND c.deal_won = ?';
    params.push(Number(deal_won));
  }
  if (lead_quality) {
    where += ' AND c.lead_quality = ?';
    params.push(lead_quality);
  }
  if (enrich_status) {
    // The literal 'none' is the fallback, never the requested value: a contact
    // with no lead row has a NULL here, and COALESCE(NULL, <filter>) matched
    // every filter — so "Есть конспект" listed exactly the contacts that had
    // never been enriched.
    where += " AND COALESCE(el.enrich_status, 'none') = ?";
    params.push(enrich_status);
  }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM contacts c${LEADS_JOIN}${where}`).get(...params).cnt;

  const rows = db.prepare(`
    SELECT c.*, pc.stage_id, ps.name as stage_name, ps.color as stage_color, p.name as pipeline_name,
      o.o_replied, o.o_sent, o.o_failed, o.o_skipped, o.o_sent_at, o.o_replied_at,
      COALESCE(el.enrich_status, 'none') as enrich_status,
      el.profile_summary, el.profile_summary_meta, el.profile_enriched_at, el.enrich_error
    FROM contacts c
    LEFT JOIN pipeline_contacts pc ON pc.contact_id = c.id
    LEFT JOIN pipeline_stages ps ON ps.id = pc.stage_id
    LEFT JOIN pipelines p ON p.id = pc.pipeline_id${LEADS_JOIN}${OUTREACH_JOIN}${where}
    ORDER BY c.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, Number(limit), (Number(page) - 1) * Number(limit));

  const contacts = rows.map(r => {
    const { status, at } = deriveOutreach(r);
    const { o_replied, o_sent, o_failed, o_skipped, o_sent_at, o_replied_at, ...rest } = r;
    return {
      ...rest,
      outreach_status: status,
      outreach_at: at,
      // Hoisted out of the meta blob so the table can render hooks without
      // every row re-parsing JSON in React.
      profile_hooks: readHooks(r.profile_summary_meta),
      // A note written under an older contract still reads and is still used by
      // the send path, so it is not hidden or deleted — but it is marked, so
      // the user can tell "a note from the weak prompt" from "a note from the
      // current one" and re-run the ones worth re-running.
      note_version: readMetaVersion(r.profile_summary_meta),
      note_stale: Boolean(r.profile_summary) && readMetaVersion(r.profile_summary_meta) !== ENRICH_VERSION
    };
  });

  res.json({ contacts, total, page: Number(page), limit: Number(limit), enrich_version: ENRICH_VERSION });
});

function readMetaVersion(raw) {
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw);
    return Number.isFinite(Number(meta?.version)) ? Number(meta.version) : null;
  } catch {
    return null;
  }
}

function readHooks(raw) {
  if (!raw) return [];
  try {
    const meta = JSON.parse(raw);
    return Array.isArray(meta?.hooks) ? meta.hooks.filter(h => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Round-trips contacts back out as CSV. The first three columns are named
// exactly what the importer looks for by default (username, full_name, bio),
// so a downloaded file can be re-imported with no column mapping. The
// remaining CRM columns are extra — the importer ignores unknown columns, so
// including them loses nothing on a round trip while keeping the export
// complete for use in a spreadsheet.
//
// Accepts the same filters as the list endpoint, so "export what I'm looking
// at" works rather than always dumping everything.
router.get('/export.csv', (req, res) => {
  const db = req.db;
  const { search, deal_won, lead_quality } = req.query;

  let query = 'SELECT * FROM contacts WHERE 1=1';
  const params = [];
  if (search) {
    query += ' AND (username LIKE ? OR full_name LIKE ? OR email LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (deal_won !== undefined && deal_won !== '') {
    query += ' AND deal_won = ?';
    params.push(Number(deal_won));
  }
  if (lead_quality) {
    query += ' AND lead_quality = ?';
    params.push(lead_quality);
  }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params);

  const headers = [
    'username', 'full_name', 'bio',
    'email', 'phone', 'company', 'notes',
    'lead_quality', 'deal_won', 'deal_value', 'created_at',
  ];

  const lines = [headers.join(',')];
  for (const c of rows) {
    lines.push([
      csvCell(c.username),
      csvCell(c.full_name),
      // `details` is where the importer puts the bio column, so it maps back.
      csvCell((c.details || '').replace(/\r?\n/g, ' ')),
      csvCell(c.email),
      csvCell(c.phone),
      csvCell(c.company),
      csvCell((c.notes || '').replace(/\r?\n/g, ' ')),
      csvCell(c.lead_quality),
      csvCell(c.deal_won ? 'yes' : 'no'),
      csvCell(c.deal_value || 0),
      csvCell(c.created_at),
    ].join(','));
  }

  // UTF-8 BOM so Excel opens Cyrillic names and bios correctly.
  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  const filename = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

router.post('/', (req, res) => {
  const db = req.db;
  const { username, full_name, email, phone, company, details, notes, lead_quality } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });

  try {
    const result = db.prepare(`
      INSERT INTO contacts (username, full_name, email, phone, company, details, notes, lead_quality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(username.replace('@', '').trim(), full_name || null, email || null, phone || null, company || null, details || null, notes || null, lead_quality || 'unknown');
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(contact);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Contact with this username already exists' });
    throw e;
  }
});

router.put('/:id', (req, res) => {
  const db = req.db;
  const { username, full_name, email, phone, company, details, notes, lead_quality, deal_won, deal_value } = req.body;
  db.prepare(`
    UPDATE contacts SET username=?, full_name=?, email=?, phone=?, company=?, details=?, notes=?, lead_quality=?, deal_won=?, deal_value=?, updated_at=?
    WHERE id=?
  `).run(
    username, full_name || null, email || null, phone || null, company || null,
    details || null, notes || null, lead_quality || 'unknown',
    deal_won ? 1 : 0, deal_value || 0, getMoscowISO(), req.params.id
  );
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(contact);
});

router.post('/:id/enrich-now', async (req, res) => {
  const db = req.db;
  const contact = db.prepare('SELECT username FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  // Same gate as the batch endpoint — read from one function so the sparkles
  // icon in a row can never offer something the dialog would refuse.
  const readiness = enrichReadiness(db);
  const noKey = readiness.blockers.find(b => b.code === 'no_ai_key');
  if (noKey) {
    return res.status(400).json({ error: noKey.message, blockers: readiness.blockers, fix: noKey.fix });
  }
  if (readiness.active_job) {
    return res.status(409).json({
      error: `Обогащение уже идёт`,
      job_id: readiness.active_job.id,
      blockers: readiness.blockers
    });
  }

  // Mirrors POST /contact-enrich/jobs, but for one contact without opening a
  // dialog. Both paths land on the same job and answer with the same decorated
  // shape, so a caller cannot get a raw row from one and progress from another.
  const job = jobWithProgress(db, createEnrichJob(db, { usernames: [contact.username] }));
  if (!job) return res.status(400).json({ error: 'Не удалось создать задачу' });
  res.status(201).json({ job, warnings: readiness.warnings.map(w => w.message) });
});

// A note that cannot be corrected is a note you cannot trust: the send path
// reads it verbatim. An empty summary is a valid edit and means "no opinion",
// which is different from "not enriched yet" and has to be stored as such —
// deleting the row would make the contact look un-enriched and eligible for a
// paid re-run.
router.post('/:id/enrich-note', (req, res) => {
  const db = req.db;
  const contact = db.prepare('SELECT username FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const summary = String(req.body?.summary ?? '').trim();
  const meta = {
    version: summary ? ENRICH_VERSION : null,
    hooks: [],
    edited: true,
    cleared: !summary,
    created_at: new Date().toISOString()
  };

  // Upsert, not UPDATE: a contact whose note is written by hand before any
  // enrichment has run has no lead row yet, and a plain UPDATE would report
  // success while storing nothing — the note would silently vanish at the next
  // reload, which is the opposite of what a reviewer expects from "save".
  db.prepare(`
    INSERT INTO leads (username, enrich_status, profile_summary, profile_summary_meta, profile_enriched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      profile_summary = excluded.profile_summary,
      profile_summary_meta = excluded.profile_summary_meta,
      profile_enriched_at = excluded.profile_enriched_at,
      enrich_status = excluded.enrich_status,
      enrich_error = NULL
  `).run(contact.username, summary ? 'done' : 'none', summary || null, JSON.stringify(meta), getMoscowISO());

  res.json({ success: true, summary: summary || null });
});

router.post('/bulk-delete', (req, res) => {
  const db = req.db;
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'ids required' });
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).run(...ids);
  res.json({ success: true, deleted: ids.length });
});

router.delete('/:id', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/deal-won', (req, res) => {
  const db = req.db;
  const { deal_value } = req.body;
  db.prepare(`
    UPDATE contacts SET deal_won = 1, deal_value = ?, updated_at = ? WHERE id = ?
  `).run(deal_value || 0, getMoscowISO(), req.params.id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(contact);
});

router.post('/import/preview', (req, res) => {
  const db = req.db;
  if (!req.files?.file) return res.status(400).json({ error: 'File not uploaded' });

  const file = req.files.file;
  const ext = file.name.split('.').pop().toLowerCase();
  let rows = [];

  try {
    if (ext === 'csv') {
      const text = file.data.toString('utf8');
      // bom: true is required — a UTF-8 BOM (which Excel writes, and which our
      // own exports include so Excel renders Cyrillic) otherwise ends up glued
      // to the first header, making it "﻿username". The username column
      // then never matches and every row is skipped.
      rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } else if (['xlsx', 'xls'].includes(ext)) {
      const wb = XLSX.read(file.data, { type: 'buffer' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } else {
      return res.status(400).json({ error: 'Only CSV, XLSX, XLS files are supported' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'File parsing error: ' + e.message });
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const preview = rows.slice(0, 5);
  res.json({ columns, preview, total_rows: rows.length });
});

router.post('/import', (req, res) => {
  const db = req.db;
  if (!req.files?.file) return res.status(400).json({ error: 'File not uploaded' });

  const file = req.files.file;
  const ext = file.name.split('.').pop().toLowerCase();
  const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};
  let rows = [];

  try {
    if (ext === 'csv') {
      const text = file.data.toString('utf8');
      // bom: true is required — a UTF-8 BOM (which Excel writes, and which our
      // own exports include so Excel renders Cyrillic) otherwise ends up glued
      // to the first header, making it "﻿username". The username column
      // then never matches and every row is skipped.
      rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } else if (['xlsx', 'xls'].includes(ext)) {
      const wb = XLSX.read(file.data, { type: 'buffer' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } else {
      return res.status(400).json({ error: 'Only CSV, XLSX, XLS files are supported' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'File parsing error: ' + e.message });
  }

  const usernameCol = mapping.username || 'username';
  const fullNameCol = mapping.full_name || 'full_name';
  const bioCol = mapping.bio || 'bio';

  const insertContact = db.prepare(`
    INSERT OR IGNORE INTO contacts (username, full_name, details)
    VALUES (?, ?, ?)
  `);

  const insertLead = db.prepare(`
    INSERT OR IGNORE INTO leads (username, full_name, bio)
    VALUES (?, ?, ?)
  `);

  const importMany = db.transaction((rows) => {
    let imported = 0, skipped = 0;
    for (const row of rows) {
      const username = (row[usernameCol] || '').replace('@', '').trim();
      if (!username) { skipped++; continue; }
      const fullName = row[fullNameCol] || '';
      const bio = row[bioCol] || '';
      const result = insertContact.run(username, fullName, bio);
      insertLead.run(username, fullName, bio);
      result.changes ? imported++ : skipped++;
    }
    return { imported, skipped };
  });

  const { imported, skipped } = importMany(rows);
  res.json({ success: true, imported, skipped, total: rows.length });
});

export default router;
