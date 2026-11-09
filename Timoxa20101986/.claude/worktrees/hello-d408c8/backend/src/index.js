import express from 'express';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import { startScheduler } from './services/schedulerService.js';
import leadsRouter from './routes/leads.js';
import campaignsRouter from './routes/campaigns.js';
import aiRouter from './routes/ai.js';
import extensionRouter from './routes/extension.js';
import settingsRouter from './routes/settings.js';
import analyticsRouter from './routes/analytics.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 } }));

app.use('/api/leads', leadsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/extension', extensionRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/analytics', analyticsRouter);

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`[Server] InstaWorm Backend запущен на http://localhost:${PORT}`);
  startScheduler();
});
