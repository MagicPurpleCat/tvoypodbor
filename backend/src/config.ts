import { z } from 'zod';

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    PUBLIC_URL: z.string().url(), // https://api.example.com — база для вебхуков
    // Mini App; не задан — та же программа, что и API (один контейнер)
    WEBAPP_URL: z.string().url().optional(),
    DATABASE_URL: z.string(),
    REDIS_URL: z.string().optional(), // не задан — лимиты и кэш в памяти процесса (один инстанс)
    TZ_OFFSET_HOURS: z.coerce.number().default(3), // сутки лимита считаются по МСК
    // false — инстанс только обслуживает API (воркеры запущены отдельным контейнером)
    RUN_JOBS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

    BOT_TOKEN: z.string().min(30),
    BOT_USERNAME: z.string(), // без @
    BOT_WEBHOOK_SECRET: z.string().min(16), // X-Telegram-Bot-Api-Secret-Token
    WEBAPP_SHORT_NAME: z.string().default('app'), // t.me/<bot>/<short_name>
    INIT_DATA_TTL_SEC: z.coerce.number().default(86400),
    SUPPORT_CHAT_ID: z.string().optional(), // куда пересылать обращения

    FREE_DAILY_LIMIT: z.coerce.number().default(5),

    PLATEGA_BASE_URL: z.string().url().default('https://app.platega.io'),
    // необязательны: без них бот работает, оплата отвечает PAYMENT_FAILED
    PLATEGA_MERCHANT_ID: z.string().uuid().optional(),
    PLATEGA_SECRET: z.string().min(8).optional(),

    HH_USER_AGENT: z.string(), // "TvoyPodbor/1.0 (you@example.com)" — обязателен для api.hh.ru
    HH_APP_TOKEN: z.string().optional(), // токен приложения dev.hh.ru (client_credentials)

    LLM_PROVIDER: z.enum(['template', 'openai_compat']).default('template'),
    LLM_BASE_URL: z.string().url().optional(), // https://openrouter.ai/api/v1 | https://api.groq.com/openai/v1
    LLM_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().optional(),
  })
  .transform((e) => ({ ...e, WEBAPP_URL: e.WEBAPP_URL ?? e.PUBLIC_URL }))
  // пустые строки из .env («KEY=») считаем незаданными, иначе optional-поля упадут на проверке формата
  .parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));

export const config = env;

export type PlanId = 'week' | 'month' | 'quarter';

// Цены — здесь, не в БД: меняются редко и деплоем.
export const PLANS: Record<PlanId, { title: string; days: number; price: number }> = {
  week: { title: 'Неделя', days: 7, price: 149 },
  month: { title: 'Месяц', days: 30, price: 399 },
  quarter: { title: '3 месяца', days: 90, price: 990 },
};

// Коды методов оплаты Platega (POST /transaction/process → paymentMethod)
export const PAYMENT_METHODS = { sbp: 2, card: 11, crypto: 13 } as const;
export type PaymentMethodKey = keyof typeof PAYMENT_METHODS;

export const webAppLink = (startParam?: string) =>
  `https://t.me/${env.BOT_USERNAME}/${env.WEBAPP_SHORT_NAME}${startParam ? `?startapp=${startParam}` : ''}`;
