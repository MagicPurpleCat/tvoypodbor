// Ключ-значение для лимитов, кэша и локов.
// REDIS_URL задан — Redis (несколько инстансов, данные переживают рестарт).
// Не задан — память процесса: годится для одного инстанса (например, Amvera без Redis),
// но при перезапуске счётчики лимитов обнуляются.
import { Redis } from 'ioredis';
import { config } from './config.js';

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
  /** SET NX с TTL в мс; true — ключ взят. */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Если значение < limit — +1 и истечение в expireAtSec (при первом инкременте). Иначе -1. */
  incrCapped(key: string, limit: number, expireAtSec: number): Promise<number>;
  /** -1, но не ниже нуля; TTL сохраняется. */
  decrFloor0(key: string): Promise<void>;
  ping(): Promise<void>;
  quit(): Promise<void>;
}

const INCR_CAPPED_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur >= tonumber(ARGV[1]) then return -1 end
cur = redis.call('INCR', KEYS[1])
if cur == 1 then redis.call('EXPIREAT', KEYS[1], ARGV[2]) end
return cur`;

function redisKv(url: string): KV {
  const r = new Redis(url, { maxRetriesPerRequest: 3 });
  return {
    get: (k) => r.get(k),
    set: async (k, v, ttl) => { await r.set(k, v, 'EX', ttl); },
    del: async (k) => { await r.del(k); },
    setNx: async (k, v, ttlMs) => (await r.set(k, v, 'PX', ttlMs, 'NX')) === 'OK',
    incrCapped: async (k, limit, exp) => (await r.eval(INCR_CAPPED_LUA, 1, k, limit, exp)) as number,
    decrFloor0: async (k) => { if ((await r.decr(k)) < 0) await r.set(k, 0, 'KEEPTTL'); },
    ping: async () => { await r.ping(); },
    quit: async () => { await r.quit(); },
  };
}

function memoryKv(): KV {
  const m = new Map<string, { v: string; exp: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (e && e.exp <= Date.now()) { m.delete(k); return undefined; }
    return e;
  };
  // чистка просроченного раз в 10 минут, чтобы кэш поиска не копился
  setInterval(() => { for (const k of m.keys()) live(k); }, 600_000).unref();
  return {
    get: async (k) => live(k)?.v ?? null,
    set: async (k, v, ttl) => { m.set(k, { v, exp: Date.now() + ttl * 1000 }); },
    del: async (k) => { m.delete(k); },
    setNx: async (k, v, ttlMs) => {
      if (live(k)) return false;
      m.set(k, { v, exp: Date.now() + ttlMs });
      return true;
    },
    incrCapped: async (k, limit, exp) => {
      const e = live(k);
      const cur = Number(e?.v ?? 0);
      if (cur >= limit) return -1;
      m.set(k, { v: String(cur + 1), exp: e?.exp ?? exp * 1000 });
      return cur + 1;
    },
    decrFloor0: async (k) => {
      const e = live(k);
      if (e) e.v = String(Math.max(0, Number(e.v) - 1));
    },
    ping: async () => {},
    quit: async () => {},
  };
}

export const kv: KV = config.REDIS_URL ? redisKv(config.REDIS_URL) : memoryKv();
if (!config.REDIS_URL) console.warn('REDIS_URL не задан — лимиты и кэш в памяти процесса');

// Распределённый лок для фоновых задач: при нескольких инстансах задача выполнится один раз.
export async function withLock(key: string, ttlMs: number, fn: () => Promise<void>) {
  if (!(await kv.setNx(`lock:${key}`, '1', ttlMs))) return;
  try {
    await fn();
  } finally {
    await kv.del(`lock:${key}`);
  }
}
