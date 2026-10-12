import { Router } from 'express';
import { webhookCallback } from 'grammy';
import { z } from 'zod';
import { config } from '../config.js';
import { bot } from '../bot/bot.js';
import { getTransaction, verifyCallbackHeaders } from '../services/platega.js';
import { applyPaymentStatus } from '../services/subscription.js';
import { AppError } from '../errors.js';

export const webhooksRouter = Router();

// Telegram проверяет секрет сам через заголовок X-Telegram-Bot-Api-Secret-Token
webhooksRouter.post('/telegram', webhookCallback(bot, 'express', { secretToken: config.BOT_WEBHOOK_SECRET }));

const callbackSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELED', 'CHARGEBACKED']),
  amount: z.number().optional(),
  currency: z.string().optional(),
  paymentMethod: z.number().optional(),
}).passthrough();

/**
 * Callback Platega об изменении статуса транзакции.
 * 1) проверка X-MerchantId / X-Secret;
 * 2) статус берётся не из тела, а из GET /transaction/{id} — подделанное тело ничего не даст;
 * 3) applyPaymentStatus идемпотентен — повторные callback'и безопасны.
 * Ответ 200 = принято; 5xx = Platega повторит.
 */
webhooksRouter.post('/platega', async (req, res) => {
  if (!verifyCallbackHeaders(req.get('x-merchantid'), req.get('x-secret'))) {
    res.status(401).json({ ok: false });
    return;
  }
  const body = callbackSchema.parse(req.body);
  const actual = await getTransaction(body.id);
  if (actual.status === 'PENDING') {
    res.json({ ok: true, ignored: 'pending' });
    return;
  }
  try {
    await applyPaymentStatus(body.id, actual.status);
  } catch (e) {
    if (e instanceof AppError && e.code === 'NOT_FOUND') {
      res.json({ ok: true, ignored: 'unknown transaction' });
      return;
    }
    throw e;
  }
  res.json({ ok: true });
});
