import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import { startScheduler } from './services/schedulerService.js';
import { startTelegramBot } from './services/telegramBot.js';
import { getDB, loadAllWorkspaces } from './db/workspaceManager.js';
import { getAuthDB } from './db/authDb.js';
import {
  resolveSessionUser,
  claimWorkspace,
  getExtensionDevice,
  touchExtensionDevice
} from './services/authService.js';
import authRouter from './routes/auth.js';
import leadsRouter from './routes/leads.js';
import campaignsRouter from './routes/campaigns.js';
import aiRouter from './routes/ai.js';
import extensionRouter from './routes/extension.js';
import settingsRouter from './routes/settings.js';
import analyticsRouter from './routes/analytics.js';
import contactsRouter from './routes/contacts.js';
import pipelinesRouter from './routes/pipelines.js';
import inboxRouter from './routes/inbox.js';
import aiAgentsRouter from './routes/ai-agents.js';
import accountsRouter from './routes/accounts.js';
import leadFinderRouter from './routes/lead-finder.js';
import leadSearchRouter from './routes/lead-search.js';
import contactEnrichRouter from './routes/contact-enrich.js';
import telegramRouter from './routes/telegram.js';

const app = express();
const PORT = process.env.PORT || 3002;
const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || 'https://instalead.ru,http://localhost:5173')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);
const rateBuckets = new Map();
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || origin.startsWith('chrome-extension://')) return callback(null, true);
    return callback(new Error('Origin is not allowed'));
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 } }));

function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const current = rateBuckets.get(key);
    if (!current || current.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.set('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}

app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'login' }));
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: 'register' }));
app.use('/api/ai', rateLimit({ windowMs: 60 * 1000, max: 30, keyPrefix: 'ai' }));

app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use('/api', (req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !allowedOrigins.has(origin) && !origin.startsWith('chrome-extension://')) return res.status(403).json({ error: 'Origin is not allowed' });
  return next();
});

function isPublicAuthPath(req) {
  const p = req.path;
  if (req.method === 'POST' && (p === '/extension/pair/claim' || p === '/extension/login')) return true;
  if (req.method === 'POST' && (p === '/auth/login' || p === '/auth/register' || p === '/auth/logout')) return true;
  return false;
}

app.use('/api', async (req, res, next) => {
  try {
    if (isPublicAuthPath(req)) return next();
    const deviceToken = req.get('x-extension-token');
    const device = deviceToken ? await getExtensionDevice(deviceToken) : null;
    if (device) {
      req.user = { id: device.user_id, email: device.email, role: device.role, banned: false, approved: true, workspace: device.workspace };
      req.workspace = device.workspace;
      req.db = await getDB(device.workspace);
      await touchExtensionDevice(deviceToken, req.body?.username || req.body?.ig_username || null);
      return next();
    }
    const resolved = await resolveSessionUser(req);
    if (resolved?.banned) {
      if (!isPublicAuthPath(req)) {
        return res.status(403).json({ error: 'This account is banned' });
      }
    } else if (resolved?.user) {
      req.user = resolved.user;
    }

    if (req.path.startsWith('/auth/')) return next();

    if (!req.user) return res.status(401).json({ error: 'Sign in required' });

    // A browser workspace is never selected from the URL or client header.
    // The signed-in platform user owns exactly one canonical workspace.
    const ws = req.user.workspace || 'default';
    req.workspace = ws;
    req.db = await getDB(ws);
    next();
  } catch (e) {
    console.error('[Auth] Failed to attach session', e.message);
    res.status(500).json({ error: 'Workspace error' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/extension', extensionRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/pipelines', pipelinesRouter);
app.use('/api/inbox', inboxRouter);
app.use('/api/ai-agents', aiAgentsRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/lead-finder', leadFinderRouter);
app.use('/api/lead-search', leadSearchRouter);
app.use('/api/contact-enrich', contactEnrichRouter);
app.use('/api/telegram', telegramRouter);

// Desktop build: serve the compiled React UI from the same local origin.
// In development Vite continues to serve the frontend separately.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDist, 'index.html'), err => {
    if (err) next();
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error(`[HTTP] ${req.method} ${req.originalUrl}:`, err.stack || err.message || err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status < 500 ? (err.message || 'Request failed') : 'Internal server error' });
});

await getAuthDB();
await loadAllWorkspaces();

app.listen(PORT, () => {
  console.log(`[Server] Instalead Backend running at http://localhost:${PORT}`);
  startScheduler();
  // No-op without TELEGRAM_BOT_TOKEN — an install without Telegram starts
  // exactly as it did before.
  startTelegramBot().catch(e => console.error('[TelegramBot] Не удалось запустить:', e.message));
});
