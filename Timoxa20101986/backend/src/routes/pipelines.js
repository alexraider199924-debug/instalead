import { Router } from 'express';

const router = Router();

// List all pipelines with stages and contact counts
router.get('/', (req, res) => {
  const db = req.db;
  const pipelines = db.prepare('SELECT * FROM pipelines ORDER BY created_at ASC').all();
  const result = pipelines.map(p => {
    const stages = db.prepare('SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position ASC').all(p.id);
    const contactCount = db.prepare('SELECT COUNT(*) as cnt FROM pipeline_contacts WHERE pipeline_id = ?').get(p.id).cnt;
    return { ...p, stages, contactCount };
  });
  res.json(result);
});

// Create pipeline
router.post('/', (req, res) => {
  const db = req.db;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const result = db.prepare('INSERT INTO pipelines (name) VALUES (?)').run(name);
  const pipeline = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(pipeline);
});

// Update pipeline name
router.put('/:id', (req, res) => {
  const db = req.db;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  db.prepare('UPDATE pipelines SET name = ? WHERE id = ?').run(name, req.params.id);
  const pipeline = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(req.params.id);
  if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
  res.json(pipeline);
});

// Delete pipeline
router.delete('/:id', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM pipelines WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Get stages with contacts for a pipeline. Each contact carries an
// outreach_status derived from its campaign history (replied/sent/…), so the
// board can badge, e.g., leads who already answered.
router.get('/:id/stages', (req, res) => {
  const db = req.db;
  const stages = db.prepare('SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position ASC').all(req.params.id);
  const result = stages.map(stage => {
    const rows = db.prepare(`
      SELECT c.*, pc.id as pipeline_contact_id,
        o.o_replied, o.o_sent, o.o_failed, o.o_replied_at, o.o_sent_at
      FROM pipeline_contacts pc
      JOIN contacts c ON c.id = pc.contact_id
      LEFT JOIN (
        SELECT l.username AS o_username,
          MAX(cl.replied) AS o_replied,
          MAX(CASE WHEN cl.status IN ('sent','sending') THEN 1 ELSE 0 END) AS o_sent,
          MAX(CASE WHEN cl.status = 'failed' THEN 1 ELSE 0 END) AS o_failed,
          MAX(cl.sent_at) AS o_sent_at,
          MAX(cl.replied_at) AS o_replied_at
        FROM campaign_leads cl
        JOIN leads l ON l.id = cl.lead_id
        GROUP BY l.username
      ) o ON o.o_username = c.username
      WHERE pc.stage_id = ?
    `).all(stage.id);
    const contacts = rows.map(r => {
      const outreach_status = r.o_replied ? 'replied' : r.o_sent ? 'sent' : r.o_failed ? 'failed' : null;
      const { o_replied, o_sent, o_failed, o_replied_at, o_sent_at, ...rest } = r;
      return { ...rest, outreach_status, outreach_at: r.o_replied_at || r.o_sent_at || null };
    });
    return { ...stage, contacts };
  });
  res.json(result);
});

// Add stage to pipeline
router.post('/:id/stages', (req, res) => {
  const db = req.db;
  const { name, color, position } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM pipeline_stages WHERE pipeline_id = ?').get(req.params.id).maxPos;
  const pos = position !== undefined ? position : maxPos + 1;

  const result = db.prepare('INSERT INTO pipeline_stages (pipeline_id, name, color, position) VALUES (?, ?, ?, ?)').run(
    req.params.id, name, color || '#6b7280', pos
  );
  const stage = db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(stage);
});

// Update stage
router.put('/stages/:stageId', (req, res) => {
  const db = req.db;
  const { name, color, position } = req.body;
  const stage = db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(req.params.stageId);
  if (!stage) return res.status(404).json({ error: 'Stage not found' });

  db.prepare('UPDATE pipeline_stages SET name = ?, color = ?, position = ? WHERE id = ?').run(
    name !== undefined ? name : stage.name,
    color !== undefined ? color : stage.color,
    position !== undefined ? position : stage.position,
    req.params.stageId
  );
  const updated = db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(req.params.stageId);
  res.json(updated);
});

// Delete stage
router.delete('/stages/:stageId', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM pipeline_stages WHERE id = ?').run(req.params.stageId);
  res.json({ success: true });
});

// Add contact to stage
router.post('/stages/:stageId/contacts', (req, res) => {
  const db = req.db;
  const { contact_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });

  const stage = db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(req.params.stageId);
  if (!stage) return res.status(404).json({ error: 'Stage not found' });

  try {
    const result = db.prepare('INSERT INTO pipeline_contacts (pipeline_id, stage_id, contact_id) VALUES (?, ?, ?)').run(
      stage.pipeline_id, req.params.stageId, contact_id
    );
    const pc = db.prepare('SELECT * FROM pipeline_contacts WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(pc);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Contact already in this pipeline' });
    throw e;
  }
});

// Add a lead to a stage by username in one shot: find or create the contact,
// then place it on the board. If it's already on this pipeline, just move it to
// the target stage. Keeps the "quick add by @username" flow a single call.
router.post('/stages/:stageId/add-lead', (req, res) => {
  const db = req.db;
  let { username, full_name } = req.body;
  username = (username || '').replace('@', '').trim();
  if (!username) return res.status(400).json({ error: 'username is required' });

  const stage = db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(req.params.stageId);
  if (!stage) return res.status(404).json({ error: 'Stage not found' });

  // Find or create the contact.
  let contact = db.prepare('SELECT * FROM contacts WHERE username = ?').get(username);
  if (!contact) {
    const r = db.prepare('INSERT INTO contacts (username, full_name) VALUES (?, ?)').run(username, full_name || null);
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
  }

  // Already on this pipeline? Move it here rather than erroring.
  const existing = db.prepare('SELECT * FROM pipeline_contacts WHERE pipeline_id = ? AND contact_id = ?')
    .get(stage.pipeline_id, contact.id);
  if (existing) {
    db.prepare('UPDATE pipeline_contacts SET stage_id = ? WHERE id = ?').run(req.params.stageId, existing.id);
    return res.json({ contact, moved: true });
  }

  db.prepare('INSERT INTO pipeline_contacts (pipeline_id, stage_id, contact_id) VALUES (?, ?, ?)')
    .run(stage.pipeline_id, req.params.stageId, contact.id);
  res.status(201).json({ contact, added: true });
});

// Move contact to a different stage
router.put('/pipeline-contacts/:pcId', (req, res) => {
  const db = req.db;
  const { stage_id } = req.body;
  if (!stage_id) return res.status(400).json({ error: 'stage_id is required' });

  db.prepare('UPDATE pipeline_contacts SET stage_id = ? WHERE id = ?').run(stage_id, req.params.pcId);
  const pc = db.prepare('SELECT * FROM pipeline_contacts WHERE id = ?').get(req.params.pcId);
  if (!pc) return res.status(404).json({ error: 'Pipeline contact not found' });
  res.json(pc);
});

// Remove contact from pipeline
router.delete('/pipeline-contacts/:pcId', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM pipeline_contacts WHERE id = ?').run(req.params.pcId);
  res.json({ success: true });
});

export default router;
