// Авторизация Mini App по initData.
// Клиент шлёт заголовок: Authorization: tma <Telegram.WebApp.initData>
// Алгоритм: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { AppError } from '../errors.js';

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user: { id: number; telegramId: number };
      startParam?: string;
    }
  }
}

// secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token) — считаем один раз.
const secretKey = createHmac('sha256', 'WebAppData').update(config.BOT_TOKEN).digest();

export function validateInitData(raw: string, ttlSec = config.INIT_DATA_TTL_SEC, now = Date.now()) {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new AppError(401, 'AUTH_INVALID');
  params.delete('hash');

  // data_check_string: все поля, кроме hash, отсортированы по ключу, через \n
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new AppError(401, 'AUTH_INVALID');

  // Защита от повторного использования старой подписанной строки
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > ttlSec) throw new AppError(401, 'AUTH_EXPIRED');

  const userJson = params.get('user');
  if (!userJson) throw new AppError(401, 'AUTH_INVALID');
  return { user: JSON.parse(userJson) as TgUser, startParam: params.get('start_param') ?? undefined };
}

export const telegramAuth: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.get('authorization') ?? '';
    const [scheme, initData] = [header.slice(0, 4), header.slice(4)];
    if (scheme !== 'tma ' || !initData) throw new AppError(401, 'AUTH_REQUIRED');

    const { user, startParam } = validateInitData(initData);
    const { rows } = await query<{ id: number }>(
      `INSERT INTO users (telegram_id, username, first_name, last_name, language_code, is_premium)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (telegram_id) DO UPDATE SET
         username = EXCLUDED.username, first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name, language_code = EXCLUDED.language_code,
         is_premium = EXCLUDED.is_premium, last_seen_at = now()
       RETURNING id`,
      [user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null,
       user.language_code ?? null, user.is_premium ?? false],
    );
    req.user = { id: rows[0]!.id, telegramId: user.id };
    req.startParam = startParam;
    next();
  } catch (e) {
    next(e);
  }
};
