import { Router } from 'express';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { getMoscowISO } from '../services/schedulerService.js';

const router = Router();

router.get('/', (req, res) => {
  const db = req.db;
  const { search, status, page = 1, limit = 50 } = req.query;
  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = [];

  if (search) {
    query += ' AND (username LIKE ? OR full_name LIKE ? OR email LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  const total = db.prepare(query.replace('SELECT *', 'SELECT COUNT(*) as cnt')).get(...params).cnt;
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), (Number(page) - 1) * Number(limit));

  const leads = db.prepare(query).all(...params);
  res.json({ leads, total, page: Number(page), limit: Number(limit) });
});

router.post('/', (req, res) => {
  const db = req.db;
  const { username, full_name, email, bio, niche, notes } = req.body;
  if (!username) return res.status(400).json({ error: 'username обязателен' });

  try {
    const result = db.prepare(`
      INSERT INTO leads (username, full_name, email, bio, niche, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username.replace('@', '').trim(), full_name, email, bio, niche, notes);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(lead);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Лид с таким username уже существует' });
    throw e;
  }
});

router.put('/:id', (req, res) => {
  const db = req.db;
  const { username, full_name, email, bio, niche, notes, status } = req.body;
  db.prepare(`
    UPDATE leads SET username=?, full_name=?, email=?, bio=?, niche=?, notes=?, status=?, updated_at=?
    WHERE id=?
  `).run(username, full_name, email, bio, niche, notes, status, getMoscowISO(), req.params.id);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  res.json(lead);
});

router.delete('/:id', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM campaign_leads WHERE lead_id = ?').run(req.params.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/bulk-delete', (req, res) => {
  const db = req.db;
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'ids обязательны' });
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM campaign_leads WHERE lead_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM leads WHERE id IN (${placeholders})`).run(...ids);
  res.json({ success: true, deleted: ids.length });
});

router.post('/import/preview', (req, res) => {
  const db = req.db;
  if (!req.files?.file) return res.status(400).json({ error: 'Файл не загружен' });

  const file = req.files.file;
  const ext = file.name.split('.').pop().toLowerCase();
  let rows = [];

  try {
    if (ext === 'csv') {
      const text = file.data.toString('utf8');
      rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    } else if (['xlsx', 'xls'].includes(ext)) {
      const wb = XLSX.read(file.data, { type: 'buffer' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } else {
      return res.status(400).json({ error: 'Поддерживаются только CSV, XLSX, XLS файлы' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Ошибка парсинга файла: ' + e.message });
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const preview = rows.slice(0, 5);

  res.json({ columns, preview, total_rows: rows.length });
});

router.post('/import', (req, res) => {
  const db = req.db;
  if (!req.files?.file) {
    const { leads: leadsData } = req.body;
    if (!leadsData?.length) return res.status(400).json({ error: 'No data to import' });

    const insert = db.prepare(`
      INSERT OR IGNORE INTO leads (username, full_name, bio)
      VALUES (?, ?, ?)
    `);

    const importMany = db.transaction((data) => {
      let imported = 0, skipped = 0;
      for (const row of data) {
        const username = (row.username || '').replace('@', '').trim();
        if (!username) { skipped++; continue; }
        const result = insert.run(username, row.full_name || '', row.bio || '');
        result.changes ? imported++ : skipped++;
      }
      return { imported, skipped };
    });

    const { imported, skipped } = importMany(leadsData);
    return res.json({ success: true, imported, skipped, total: leadsData.length });
  }

  const file = req.files.file;
  const ext = file.name.split('.').pop().toLowerCase();
  const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};
  let rows = [];

  try {
    if (ext === 'csv') {
      const text = file.data.toString('utf8');
      rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    } else if (['xlsx', 'xls'].includes(ext)) {
      const wb = XLSX.read(file.data, { type: 'buffer' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } else {
      return res.status(400).json({ error: 'Поддерживаются только CSV, XLSX, XLS файлы' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Ошибка парсинга файла: ' + e.message });
  }

  const usernameCol = mapping.username || 'username';
  const fullNameCol = mapping.full_name || 'full_name';
  const bioCol = mapping.bio || 'bio';

  const insert = db.prepare(`
    INSERT OR IGNORE INTO leads (username, full_name, bio)
    VALUES (?, ?, ?)
  `);

  const importMany = db.transaction((rows) => {
    let imported = 0, skipped = 0;
    for (const row of rows) {
      const username = (row[usernameCol] || '').replace('@', '').trim();
      if (!username) { skipped++; continue; }
      const result = insert.run(
        username,
        row[fullNameCol] || '',
        row[bioCol] || ''
      );
      result.changes ? imported++ : skipped++;
    }
    return { imported, skipped };
  });

  const { imported, skipped } = importMany(rows);
  res.json({ success: true, imported, skipped, total: rows.length });
});

export default router;
