import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { copy } from '../copy.js';
import { bot } from '../bot/bot.js';
import { enqueue, escapeHtml } from '../services/notify.js';

export const supportRouter = Router();

supportRouter.get('/support/faq', (_req, res) => {
  res.json({ items: copy.faq });
});

supportRouter.post('/support/tickets', async (req, res) => {
  const { topic, message } = z.object({
    topic: z.enum(['payment', 'bug', 'search', 'idea', 'other']),
    message: z.string().trim().min(10).max(2000),
  }).parse(req.body);

  const { rows } = await query<{ id: number }>(
    `INSERT INTO support_tickets (user_id, topic, message) VALUES ($1, $2, $3) RETURNING id`,
    [req.user.id, topic, message],
  );
  const id = rows[0]!.id;

  if (config.SUPPORT_CHAT_ID) {
    // Ответ оператор пишет пользователю напрямую по telegram_id из сообщения
    await bot.api.sendMessage(
      config.SUPPORT_CHAT_ID,
      `<b>Тикет #${id}</b> · ${topic}\nuser tg_id: <code>${req.user.telegramId}</code>\n\n${escapeHtml(message)}`,
      { parse_mode: 'HTML' },
    ).catch((e) => console.error('support forward', e));
  }
  await enqueue(req.user.id, 'support_received', { id });
  res.status(201).json({ id });
});
