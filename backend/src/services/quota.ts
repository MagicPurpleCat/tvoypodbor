// Суточный лимит бесплатных запросов (поиск + генерация отклика).
import { config } from '../config.js';
import { kv } from '../redis.js';
import { getActiveSubscription } from './subscription.js';

const OFFSET_MS = config.TZ_OFFSET_HOURS * 3600_000;

/** Ключ текущих суток и момент сброса (полночь по МСК). */
export function dayWindow(now = Date.now()) {
  const local = new Date(now + OFFSET_MS);
  const day = local.toISOString().slice(0, 10);
  const nextMidnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  return { day, resetAt: new Date(nextMidnightLocal - OFFSET_MS) };
}

const key = (userId: number, day: string) => `quota:${userId}:${day}`;

export interface QuotaState {
  unlimited: boolean;
  limit: number;
  used: number;
  remaining: number | null; // null — безлимит (подписка)
  resetAt: string;
}

export async function getQuota(userId: number): Promise<QuotaState> {
  const { day, resetAt } = dayWindow();
  const [sub, usedRaw] = await Promise.all([getActiveSubscription(userId), kv.get(key(userId, day))]);
  const used = Number(usedRaw ?? 0);
  const limit = config.FREE_DAILY_LIMIT;
  return {
    unlimited: Boolean(sub),
    limit,
    used,
    remaining: sub ? null : Math.max(0, limit - used),
    resetAt: resetAt.toISOString(),
  };
}

/** Списать один запрос. Возвращает null, если лимит исчерпан. */
export async function consume(userId: number): Promise<QuotaState | null> {
  if (await getActiveSubscription(userId)) return getQuota(userId);
  const { day, resetAt } = dayWindow();
  // атомарно: проверка лимита и инкремент одной операцией, истечение — в полночь по МСК
  const res = await kv.incrCapped(key(userId, day), config.FREE_DAILY_LIMIT, Math.floor(resetAt.getTime() / 1000));
  if (res < 0) return null;
  return {
    unlimited: false,
    limit: config.FREE_DAILY_LIMIT,
    used: res,
    remaining: config.FREE_DAILY_LIMIT - res,
    resetAt: resetAt.toISOString(),
  };
}

/** Вернуть запрос, если операция упала не по вине пользователя (hh.ru недоступен и т.п.). */
export async function refund(userId: number) {
  const { day } = dayWindow();
  await kv.decrFloor0(key(userId, day));
}
