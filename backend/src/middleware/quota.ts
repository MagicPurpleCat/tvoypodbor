import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors.js';
import { consume, refund, getQuota } from '../services/quota.js';
import { enqueue } from '../services/notify.js';

/**
 * Списывает один запрос из суточного лимита. При превышении — 402 LIMIT_EXCEEDED,
 * клиент по этому коду открывает экран подписки.
 * Списывается только успешный запрос: при ответе 4xx/5xx (кривые параметры, вакансия удалена,
 * hh.ru лёг) запрос возвращается в лимит.
 */
export const requireQuota =
  (shouldCount: (req: Request) => boolean = () => true): RequestHandler =>
  async (req, res, next) => {
    try {
      if (!shouldCount(req)) return next();
      const state = await consume(req.user.id);
      if (!state) {
        const q = await getQuota(req.user.id);
        // Напомнить в чат, когда лимит обновится (один раз за сутки)
        await enqueue(req.user.id, 'limit_reset', { limit: q.limit }, {
          dedupKey: `limit_reset:${req.user.id}:${q.resetAt}`,
          scheduledAt: new Date(q.resetAt),
        });
        throw new AppError(402, 'LIMIT_EXCEEDED', 'Daily free limit reached', {
          limit: q.limit,
          resetAt: q.resetAt,
          redirect: 'subscription',
        });
      }
      res.setHeader('X-Quota-Remaining', state.unlimited ? 'unlimited' : String(state.remaining));
      res.setHeader('X-Quota-Reset', state.resetAt);
      if (!state.unlimited) {
        res.on('finish', () => {
          if (res.statusCode >= 400) void refund(req.user.id);
        });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
