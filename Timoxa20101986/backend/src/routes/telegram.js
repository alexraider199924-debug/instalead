import { Router } from 'express';
import { createLinkCode, listLinks, unlinkTelegram } from '../services/telegramLinkService.js';
import { getBotInfo, isBotEnabled } from '../services/telegramBot.js';

const router = Router();

router.get('/status', async (req, res) => {
  const links = await listLinks(req.workspace);
  res.json({
    enabled: isBotEnabled(),
    bot: getBotInfo(),
    links,
    workspace: req.workspace,
  });
});

router.post('/link-code', async (req, res) => {
  if (!isBotEnabled()) {
    return res.status(503).json({
      error: 'Телеграм-бот не настроен на сервере. Добавьте TELEGRAM_BOT_TOKEN в backend/.env и перезапустите сервер.',
    });
  }
  try {
    // user_id 0 covers a single-tenant install that has not enabled auth yet:
    // there is no signed-in user to attribute the code to, but the workspace
    // is still the thing being bound.
    const out = await createLinkCode(req.user?.id ?? 0, req.workspace);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/links/:telegramId', async (req, res) => {
  const links = await listLinks(req.workspace);
  // Scoped to the caller's workspace so one tenant cannot unlink another's chat.
  if (!links.some(l => l.telegram_id === String(req.params.telegramId))) {
    return res.status(404).json({ error: 'Привязка не найдена' });
  }
  const removed = await unlinkTelegram(req.params.telegramId);
  res.json({ success: removed });
});

export default router;
