import { Router } from 'express';
import { getMoscowISO } from '../services/schedulerService.js';

const router = Router();

router.get('/', (req, res) => {
  const db = req.db;
  const { label, search } = req.query;
  let query = 'SELECT * FROM inbox_conversations WHERE 1=1';
  const params = [];

  if (label) {
    query += ' AND label = ?';
    params.push(label);
  }
  if (search) {
    query += ' AND (contact_username LIKE ? OR contact_name LIKE ? OR last_message LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  const total = db.prepare(query.replace('SELECT *', 'SELECT COUNT(*) as cnt')).get(...params).cnt;
  // Same order Instagram Direct uses: most recent thread activity first.
  query += ' ORDER BY COALESCE(last_activity_at, 0) DESC, updated_at DESC';

  const conversations = db.prepare(query).all(...params);
  res.json({ conversations, total });
});

router.post('/', (req, res) => {
  const db = req.db;
  const { contact_username, contact_name, last_message, label } = req.body;
  if (!contact_username) return res.status(400).json({ error: 'contact_username is required' });

  const result = db.prepare(`
    INSERT INTO inbox_conversations (contact_username, contact_name, last_message, label)
    VALUES (?, ?, ?, ?)
  `).run(contact_username, contact_name || null, last_message || null, label || 'needs_reply');
  const conversation = db.prepare('SELECT * FROM inbox_conversations WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(conversation);
});

router.put('/:id', (req, res) => {
  const db = req.db;
  const { label, last_message, unread, contact_name } = req.body;
  const existing = db.prepare('SELECT * FROM inbox_conversations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Conversation not found' });

  db.prepare(`
    UPDATE inbox_conversations SET label = ?, last_message = ?, unread = ?, contact_name = ?, updated_at = ?
    WHERE id = ?
  `).run(
    label !== undefined ? label : existing.label,
    last_message !== undefined ? last_message : existing.last_message,
    unread !== undefined ? (unread ? 1 : 0) : existing.unread,
    contact_name !== undefined ? contact_name : existing.contact_name,
    getMoscowISO(),
    req.params.id
  );
  const conversation = db.prepare('SELECT * FROM inbox_conversations WHERE id = ?').get(req.params.id);
  res.json(conversation);
});

router.delete('/:id', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM inbox_conversations WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/stats', (req, res) => {
  const db = req.db;
  const labels = ['needs_reply', 'waiting', 'needs_followup', 'no_action', 'do_not_contact'];
  const stats = {};
  for (const label of labels) {
    stats[label] = db.prepare('SELECT COUNT(*) as cnt FROM inbox_conversations WHERE label = ?').get(label).cnt;
  }
  stats.total = db.prepare('SELECT COUNT(*) as cnt FROM inbox_conversations').get().cnt;
  stats.unread = db.prepare('SELECT COUNT(*) as cnt FROM inbox_conversations WHERE unread = 1').get().cnt;
  res.json(stats);
});

router.get('/:id/messages', (req, res) => {
  const db = req.db;
  const messages = db.prepare(
    'SELECT * FROM inbox_messages WHERE conversation_id = ? ORDER BY COALESCE(ig_timestamp, 0) ASC, id ASC'
  ).all(req.params.id);
  res.json(messages);
});

router.post('/:id/messages', (req, res) => {
  const db = req.db;
  const { text, sender, pending_send } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  // Stamp the row on the same microsecond scale Instagram uses so a locally
  // composed message sorts correctly against synced history right away.
  const nowMicros = Date.now() * 1000;
  const nowIso = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO inbox_messages (conversation_id, sender, text, pending_send, created_at, ig_timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.params.id, sender || 'me', text, pending_send ? 1 : 0, nowIso, nowMicros);

  db.prepare(
    'UPDATE inbox_conversations SET last_message = ?, last_activity_at = ?, updated_at = ? WHERE id = ?'
  ).run(sender === 'them' ? text : 'You: ' + text, nowMicros, nowIso, req.params.id);

  const message = db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(result.lastInsertRowid);
  res.json(message);
});

export default router;
