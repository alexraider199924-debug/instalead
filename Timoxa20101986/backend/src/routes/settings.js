import { Router } from 'express';
import { listBackups, restoreFromBackup, exportDb, importDb, listAllDbFiles, restoreLegacyFile } from '../db/workspaceManager.js';
import { callOpenRouter, isValidModelId } from '../services/aiService.js';

const router = Router();

router.get('/', (req, res) => {
  const db = req.db;
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  // Profile enrichment is intentionally browser-DOM only. Keep the legacy setting
  // readable for compatibility, but never expose API mode as an active option.
  settings.enrichment_method = 'dom';
  // Mask API keys
  if (settings.anthropic_api_key) settings.anthropic_api_key = settings.anthropic_api_key ? '***masked***' : '';
  if (settings.openai_api_key) settings.openai_api_key = settings.openai_api_key ? '***masked***' : '';
  if (settings.openrouter_api_key) settings.openrouter_api_key = settings.openrouter_api_key ? '***masked***' : '';
  res.json(settings);
});

router.put('/', (req, res) => {
  const db = req.db;
  const allowed = ['app_name', 'currency', 'openrouter_api_key', 'openrouter_model', 'inbox_agent_enabled', 'enrichment_method'];
  if (req.body.openrouter_model !== undefined && !isValidModelId(req.body.openrouter_model)) {
    return res.status(400).json({ error: 'Некорректный ID модели. Ожидается формат vendor/model, например stealth/space-bunny-alpha' });
  }
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  db.transaction(() => {
    for (const key of allowed) {
      if (key === 'enrichment_method') continue;
      if (req.body[key] !== undefined && req.body[key] !== '***masked***') {
        update.run(key, req.body[key]);
      }
    }
    update.run('enrichment_method', 'dom');
  })();

  res.json({ success: true });
});

// Проверка ключа и модели без запуска реальной генерации: минимальный запрос
// к OpenRouter с тем же кодом вызова, что и у персонализации. Позволяет сразу
// понять, ушла ли ошибка 403 после смены ключа или модели.
router.post('/test-openrouter', async (req, res) => {
  const db = req.db;
  const body = req.body || {};

  const typedKey = body.openrouter_api_key && body.openrouter_api_key !== '***masked***'
    ? String(body.openrouter_api_key).trim()
    : '';
  const savedKey = String(db.prepare("SELECT value FROM settings WHERE key = 'openrouter_api_key'").get()?.value || '').trim();
  const apiKey = typedKey || savedKey;
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: 'Укажите API ключ OpenRouter' });
  }

  const savedModel = db.prepare("SELECT value FROM settings WHERE key = 'openrouter_model'").get()?.value;
  const model = String(body.openrouter_model || savedModel || '').trim();
  if (!model) {
    return res.status(400).json({ ok: false, error: 'Укажите модель в формате vendor/model' });
  }
  if (!isValidModelId(model)) {
    return res.status(400).json({ ok: false, error: `Некорректный ID модели: ${model}. Ожидается формат vendor/model, например stealth/space-bunny-alpha` });
  }

  try {
    const reply = await callOpenRouter(db, 'Отвечай только одним словом.', 'Ответь: ok', 16, { apiKey, model });
    res.json({ ok: true, model, reply: String(reply).slice(0, 200) });
  } catch (e) {
    console.error(`[OpenRouter] Test failed for ${model}: ${e.message}`);
    res.json({ ok: false, model, error: e.message });
  }
});

router.get('/check-keys', (req, res) => {
  const db = req.db;
  const rows = db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)').all('anthropic_api_key', 'openai_api_key');
  const result = Object.fromEntries(rows.map(r => [r.key, !!r.value]));
  res.json(result);
});

router.get('/backups', (req, res) => {
  const backups = listBackups(req.workspace);
  res.json({ backups });
});

router.get('/export', (req, res) => {
  try {
    const buffer = exportDb(req.workspace);
    const filename = `instalead_${req.workspace}_${new Date().toISOString().slice(0, 10)}.db`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

router.post('/import', async (req, res) => {
  try {
    if (!req.files?.database) return res.status(400).json({ error: 'No file uploaded' });
    await importDb(req.workspace, req.files.database.data);
    res.json({ success: true, message: 'Database restored from uploaded file' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/backups/:filename/restore', async (req, res) => {
  try {
    await restoreFromBackup(req.workspace, req.params.filename);
    res.json({ success: true, message: 'Restored from backup' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  return next();
}

router.get('/diagnostics/files', requireAdmin, (req, res) => {
  try {
    res.json(listAllDbFiles(req.workspace));
  } catch (e) {
    res.status(500).json({ error: 'Failed to list database files' });
  }
});

router.post('/diagnostics/restore-legacy', requireAdmin, async (req, res) => {
  try {
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const result = await restoreLegacyFile(req.workspace, filename);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'Restore failed' });
  }
});

export default router;
