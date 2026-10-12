import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { pool } from './db.js';
import { kv } from './redis.js';
import { errorHandler } from './errors.js';
import { telegramAuth } from './middleware/telegramAuth.js';
import { profileRouter } from './routes/profile.js';
import { vacanciesRouter } from './routes/vacancies.js';
import { billingRouter } from './routes/billing.js';
import { supportRouter } from './routes/support.js';
import { webhooksRouter } from './routes/webhooks.js';
import { setupBot } from './bot/bot.js';
import { startNotificationWorker } from './jobs/notificationWorker.js';
import { startScheduler } from './jobs/scheduler.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
// CSP под Mini App: SDK Telegram, шрифты Google, аватар из t.me.
// frame-ancestors — Telegram Web/Desktop открывают приложение во фрейме; без этого оно не загрузится.
app.use(helmet({
  frameguard: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://telegram.org'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
    },
  },
}));
app.use(express.json({ limit: '100kb' }));

app.get('/health', async (_req, res) => {
  await Promise.all([pool.query('SELECT 1'), kv.ping()]);
  res.json({ ok: true });
});

// Вебхуки — без CORS и без initData, у каждого своя проверка подлинности
app.use('/webhooks', webhooksRouter);

// API Mini App: только с origin приложения и только с валидным initData
app.use(
  '/api',
  cors({
    origin: config.WEBAPP_URL,
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['X-Quota-Remaining', 'X-Quota-Reset'],
    maxAge: 600,
  }),
  telegramAuth,
  profileRouter,
  vacanciesRouter,
  billingRouter,
  supportRouter,
);

// Mini App из той же программы (один контейнер на Amvera). Собранный фронт лежит в webapp/dist.
const webappDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../webapp/dist');
if (existsSync(webappDist)) {
  app.use('/assets', express.static(path.join(webappDist, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(webappDist, { index: false, maxAge: 0 }));
  // любые остальные GET — страница приложения (навигация внутри SPA)
  app.get(/^\/(?!api|webhooks|health).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(webappDist, 'index.html'));
  });
}

app.use(errorHandler);

const server = app.listen(config.PORT, () => console.log(`api on :${config.PORT}`));

const timers: NodeJS.Timeout[] = [];
if (config.RUN_JOBS) {
  if (config.PUBLIC_URL.startsWith('https://')) await setupBot().catch((e) => console.error('setupBot', e));
  timers.push(startNotificationWorker(), ...startScheduler());
}

const shutdown = async () => {
  timers.forEach(clearInterval);
  server.close();
  await Promise.allSettled([pool.end(), kv.quit()]);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
