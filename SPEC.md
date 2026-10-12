# ТвойПодбор — спецификация

Telegram Mini App для поиска работы: вакансии hh.ru, резюме, генерация отклика, избранное, PRO-подписка через Platega.io, уведомления в чат с ботом.

Код в репозитории рабочий: backend проходит `tsc` и тесты, Mini App собирается и проверена в браузере на моках (375×812). Этот документ описывает решения; источник истины — код.

---

## 0. Допущения

| Тема | Решение | Почему |
|---|---|---|
| Источник вакансий | Публичный API hh.ru (`/vacancies`, `/vacancies/{id}`, `/suggests/areas`), кэш выдачи в Redis на 10 мин, вакансии — в таблице `vacancies` | Выбрано вами. Обязателен заголовок `HH-User-Agent`. Токен приложения dev.hh.ru — опционально |
| Фильтр «формат работы» | Параметр hh `schedule` (`fullDay`, `remote`, `flexible`, `shift`, `flyInFlyOut`) | hh в 2025 ввёл `work_format`; `schedule` пока работает. Перед запуском сверить с api.hh.ru/openapi/redoc |
| «Ответы работодателей» | Статус отклика пользователь ведёт сам (applied → invited → interview → offer / declined). Шаблон уведомления `employer_reply` есть, но автоматического источника в v1 нет | Ответы работодателей с hh доступны только через OAuth соискателя (`/negotiations`). Это v2 |
| Отклик отправляется | Пользователь копирует текст и отправляет на hh сам | Автоотклик требует OAuth соискателя и согласования с hh |
| Генератор отклика | `LLM_PROVIDER=template` — шаблонный генератор без LLM (бесплатно, без ключей). `openai_compat` — любой OpenAI-совместимый API (OpenRouter `:free`-модели, Groq). При ошибке LLM — фолбэк на шаблон | «Бесплатно на старте, потом поменяю» — меняется одной env-переменной |
| Что такое «запрос» | Новый поиск (page = 0) и генерация отклика. Листание, карточки, избранное, резюме — без лимита | Ваш выбор: «поиск + генерация» |
| Сутки лимита | 00:00–23:59 МСК (`TZ_OFFSET_HOURS=3`) | Аудитория — РФ |
| Неуспешный запрос | Ответ 4xx/5xx (ошибка параметров, вакансия удалена, hh.ru лёг) — запрос возвращается в лимит | Списываем только за результат |
| Тарифы | Неделя 149 ₽ · Месяц 399 ₽ · 3 месяца 990 ₽. Цены — в `backend/src/config.ts` | Ваш выбор. Без автопродления в v1 — нет спорных списаний. У Platega есть API подписок (`/subscription`), его можно подключить позже |
| Продление | Новая оплата начинается с конца текущего оплаченного периода | Чтобы досрочное продление не сгорало |
| Способы оплаты | СБП (2), карта РФ (11), крипта (13) | Коды из документации Platega |
| Callback Platega | Проверка `X-MerchantId` + `X-Secret`, затем статус перезапрашивается `GET /transaction/{id}` | Официальная схема подписи callback в открытой документации не описана. Повторный запрос делает подделку тела бесполезной |
| Резюме | Одно на пользователя. Поля: имя, желаемая должность, город, контакты (телефон, email, telegram), опыт (компания, должность, с, по, достижения), навыки, образование (вуз, степень, год), портфолио (название, ссылка), о себе | Минимум для генерации отклика |
| Статистика пути | «Подошло» / «Не моё» — последнее решение по вакансии; «в избранном» — текущее количество; плюс воронка по статусам откликов | «Принято / отклонено / отложено» из ТЗ |
| Тема оформления | Всегда тёмная, тема Telegram игнорируется | Брендовый стиль dark tech |
| Язык | Только русский | — |

---

## 1. Схема базы данных (PostgreSQL 16)

Файл: [`backend/migrations/001_init.sql`](backend/migrations/001_init.sql). Помимо 7 обязательных таблиц добавлена `support_tickets`. Платежи хранятся в `subscriptions`: одна строка = одна покупка.

```sql
-- 001_init.sql — базовая схема «ТвойПодбор»


-- Пользователи Telegram
CREATE TABLE users (
  id                 BIGSERIAL PRIMARY KEY,
  telegram_id        BIGINT       NOT NULL UNIQUE,
  username           TEXT,
  first_name         TEXT,
  last_name          TEXT,
  language_code      VARCHAR(8),
  is_premium         BOOLEAN      NOT NULL DEFAULT false,
  -- последний поиск: на его основе считается рассылка «новые подходящие вакансии»
  saved_search       JSONB,
  notify_new_vacancies BOOLEAN    NOT NULL DEFAULT true,
  notify_reminders   BOOLEAN      NOT NULL DEFAULT true,
  last_digest_at     TIMESTAMPTZ,
  bot_blocked        BOOLEAN      NOT NULL DEFAULT false,  -- пользователь заблокировал бота (403)
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_digest ON users (last_digest_at)
  WHERE notify_new_vacancies AND saved_search IS NOT NULL AND NOT bot_blocked;

-- Кэш вакансий из внешних источников (hh.ru)
CREATE TABLE vacancies (
  id             BIGSERIAL PRIMARY KEY,
  source         VARCHAR(16)  NOT NULL DEFAULT 'hh',
  external_id    TEXT         NOT NULL,
  title          TEXT         NOT NULL,
  company        TEXT,
  city           TEXT,
  salary_from    INTEGER,
  salary_to      INTEGER,
  salary_currency VARCHAR(8),
  salary_gross   BOOLEAN,
  experience     VARCHAR(32),          -- noExperience | between1And3 | between3And6 | moreThan6
  schedule       VARCHAR(32),          -- fullDay | remote | flexible | shift | flyInFlyOut
  employment     VARCHAR(32),          -- full | part | project | probation
  key_skills     TEXT[]       NOT NULL DEFAULT '{}',
  description    TEXT,                 -- plain text, HTML вырезан
  url            TEXT         NOT NULL,
  published_at   TIMESTAMPTZ,
  archived       BOOLEAN      NOT NULL DEFAULT false,
  raw            JSONB,
  fetched_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX idx_vacancies_published ON vacancies (published_at DESC);

-- Резюме: одно на пользователя
CREATE TABLE user_resumes (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT       NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name     TEXT         NOT NULL DEFAULT '',
  desired_position TEXT      NOT NULL DEFAULT '',
  city          TEXT,
  contacts      JSONB        NOT NULL DEFAULT '{}',  -- {phone, email, telegram}
  experience    JSONB        NOT NULL DEFAULT '[]',  -- [{company, position, from:"2021-03", to:"2024-01"|null, achievements}]
  skills        TEXT[]       NOT NULL DEFAULT '{}',
  education     JSONB        NOT NULL DEFAULT '[]',  -- [{institution, degree, year}]
  portfolio     JSONB        NOT NULL DEFAULT '[]',  -- [{title, url}]
  about         TEXT         NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Журнал действий пользователя (история + источник статистики)
CREATE TABLE user_actions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vacancy_id    BIGINT       REFERENCES vacancies(id) ON DELETE SET NULL,
  action        VARCHAR(24)  NOT NULL CHECK (action IN (
                  'view', 'accept', 'reject', 'favorite', 'unfavorite',
                  'apply', 'generate_letter', 'status_change', 'search')),
  -- для apply/status_change: applied | invited | interview | offer | declined
  status        VARCHAR(16),
  meta          JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_actions_user_time ON user_actions (user_id, created_at DESC);
CREATE INDEX idx_actions_user_action ON user_actions (user_id, action);
CREATE INDEX idx_actions_vacancy ON user_actions (vacancy_id);

-- Избранное
CREATE TABLE favorites (
  user_id       BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vacancy_id    BIGINT       NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  note          TEXT,
  reminded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, vacancy_id)
);
CREATE INDEX idx_favorites_created ON favorites (created_at);

-- Подписки. Одна строка = одна покупка (платёж Platega).
-- Активная подписка: status = 'active' AND now() BETWEEN starts_at AND expires_at.
CREATE TABLE subscriptions (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan           VARCHAR(16)  NOT NULL CHECK (plan IN ('week', 'month', 'quarter')),
  status         VARCHAR(16)  NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'active', 'expired', 'canceled', 'refunded')),
  amount         NUMERIC(10,2) NOT NULL,
  currency       VARCHAR(8)   NOT NULL DEFAULT 'RUB',
  payment_method SMALLINT     NOT NULL,             -- код Platega: 2 СБП, 11 карта, 13 крипта ...
  provider       VARCHAR(16)  NOT NULL DEFAULT 'platega',
  provider_tx_id UUID         UNIQUE,               -- transactionId Platega
  provider_status VARCHAR(16),                      -- PENDING | CONFIRMED | CANCELED | CHARGEBACKED
  payment_url    TEXT,
  starts_at      TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  expiry_notified BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_subs_user_active ON subscriptions (user_id, expires_at DESC) WHERE status = 'active';
CREATE INDEX idx_subs_pending ON subscriptions (created_at) WHERE status = 'pending';

-- Очередь исходящих уведомлений (outbox). Воркер забирает через FOR UPDATE SKIP LOCKED.
CREATE TABLE notifications (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          VARCHAR(32)  NOT NULL,   -- ключ из notification_templates
  payload       JSONB        NOT NULL DEFAULT '{}',
  status        VARCHAR(12)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts      SMALLINT     NOT NULL DEFAULT 0,
  dedup_key     TEXT         UNIQUE,     -- защита от дублей (например, sub_expiring:<sub_id>)
  scheduled_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  error         TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_queue ON notifications (scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);

-- Обращения в поддержку (дополнительная таблица)
CREATE TABLE support_tickets (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic         VARCHAR(16)  NOT NULL CHECK (topic IN ('payment', 'bug', 'search', 'idea', 'other')),
  message       TEXT         NOT NULL,
  status        VARCHAR(12)  NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_tickets_status ON support_tickets (status, created_at);
```

**Как читается состояние:**
- активная подписка — `status = 'active' AND expires_at > now()`; оплачено до `max(expires_at)`;
- лимит запросов в БД не хранится: он в Redis, ключ `quota:{user_id}:{YYYY-MM-DD}`, истекает в полночь МСК;
- `notifications` — outbox: API пишет строку, воркер отправляет. `dedup_key` защищает от повторов.

---

## 2. Структура проекта

```
ТвойПодбор/
├── SPEC.md                      этот документ
├── README.md                    быстрый старт
├── .env.example                 все переменные окружения с комментариями
├── docker-compose.yml           прод-стек: caddy, api, webapp, postgres, redis, migrate
├── Caddyfile                    HTTPS (Let's Encrypt) и проксирование на api / webapp
├── .github/workflows/deploy.yml CI: typecheck, тесты, сборка; CD: образы в GHCR → SSH-деплой
├── scripts/
│   └── contrast.mjs             проверка WCAG-контраста палитры
├── shared/
│   └── copy.ru.json             все тексты: кнопки, экраны, ошибки, уведомления, FAQ (общий для бота и Mini App)
├── backend/                     Node.js + Express 5 + TypeScript
│   ├── Dockerfile
│   ├── migrations/001_init.sql  схема БД
│   └── src/
│       ├── index.ts             сборка Express, CORS, роуты, запуск воркеров, graceful shutdown
│       ├── config.ts            валидация env (zod), тарифы, коды методов оплаты
│       ├── db.ts                пул pg, хелпер транзакций
│       ├── redis.ts             клиент Redis, распределённый лок для фоновых задач
│       ├── migrate.ts           накатывает migrations/*.sql
│       ├── errors.ts            AppError, коды ошибок, обработчик ошибок
│       ├── copy.ts              загрузка shared/copy.ru.json
│       ├── middleware/
│       │   ├── telegramAuth.ts       проверка initData (HMAC-SHA256), upsert пользователя
│       │   ├── telegramAuth.test.ts  тесты подписи, подмены, просрочки
│       │   └── quota.ts              списание запроса, 402 при лимите, возврат при 5xx
│       ├── routes/
│       │   ├── profile.ts       /me, настройки, резюме, история
│       │   ├── vacancies.ts     поиск, карточка, решения, статусы, избранное, генерация отклика
│       │   ├── billing.ts       тарифы, оформление, статус платежа
│       │   ├── support.ts       FAQ, обращения
│       │   └── webhooks.ts      вебхуки Telegram и Platega
│       ├── services/
│       │   ├── hh.ts            клиент hh.ru, кэш выдачи, upsert вакансий
│       │   ├── quota.ts         суточный лимит в Redis (Lua, атомарно)
│       │   ├── subscription.ts  оформление, применение статусов оплаты, кэш подписки
│       │   ├── platega.ts       клиент Platega: создание транзакции, статус, проверка callback
│       │   ├── notify.ts        постановка уведомлений в outbox, рендер шаблонов
│       │   └── coverLetter/
│       │       ├── index.ts         выбор провайдера + фолбэк
│       │       ├── types.ts         интерфейс провайдера, тип резюме
│       │       ├── template.ts      бесплатный генератор без LLM
│       │       └── openaiCompat.ts  OpenAI-совместимый /chat/completions
│       ├── bot/bot.ts           grammY: /start, /pro, /support, кнопка меню, setWebhook
│       └── jobs/
│           ├── notificationWorker.ts  отправка outbox (25 сообщений/с, ретраи, 403 → bot_blocked)
│           └── scheduler.ts           дайджест вакансий, напоминания, жизненный цикл подписок, сверка платежей
└── webapp/                      React 18 + Vite + TypeScript
    ├── Dockerfile, nginx.conf   сборка и раздача статики
    ├── index.html               подключение telegram-web-app.js, шрифты
    └── src/
        ├── main.tsx             инициализация Telegram, монтирование
        ├── App.tsx              стек экранов, BackButton, deep-link, перехват 402 → экран лимита
        ├── nav.tsx              маршруты, контекст навигации, разбор start_param
        ├── api.ts               fetch с `Authorization: tma <initData>`, типы ответов
        ├── mock.ts              моки API для вёрстки вне Telegram (только dev)
        ├── tg.ts                обёртка Telegram.WebApp: кнопки, попапы, хаптика, ссылки, буфер
        ├── copy.ts              доступ к текстам, форматирование сумм и дат
        ├── styles.css           токены палитры, карточки, кнопки, сетка, таймер
        ├── components/
        │   ├── ui.tsx           Header, TabBar, BottomCta (MainButton/SecondaryButton), Countdown, QuotaBar…
        │   └── VacancyCard.tsx  карточка вакансии в выдаче
        └── screens/
            ├── Search.tsx       поиск и фильтры
            ├── Vacancy.tsx      карточка вакансии, решения, статус отклика
            ├── CoverLetter.tsx  генератор отклика
            ├── Favorites.tsx    избранное
            ├── Profile.tsx      профиль, статистика, воронка, история
            ├── Resume.tsx       редактор резюме
            ├── Subscription.tsx тарифы, лимит с таймером, ожидание оплаты, статус PRO
            └── Support.tsx      FAQ и форма обращения
```

---

## 3. API

Базовый URL: `https://api.example.com`. Все `/api/*` требуют заголовок `Authorization: tma <Telegram.WebApp.initData>`. CORS разрешён только для `WEBAPP_URL`.

**Формат ошибки** (одинаковый для всех методов):
```json
{ "error": { "code": "LIMIT_EXCEEDED", "message": "Daily free limit reached", "limit": 5, "resetAt": "2026-10-11T21:00:00.000Z", "redirect": "subscription" } }
```
Коды: `AUTH_REQUIRED` 401, `AUTH_INVALID` 401, `AUTH_EXPIRED` 401, `VALIDATION` 400, `NOT_FOUND` 404, `RESUME_REQUIRED` 409, `LIMIT_EXCEEDED` 402, `PAYMENT_FAILED` 502, `UPSTREAM_UNAVAILABLE` 503, `INTERNAL` 500. Текст для пользователя — `error_messages[code]` в copy.ru.json.

**Заголовки лимита** в ответах платных методов: `X-Quota-Remaining: 3 | unlimited`, `X-Quota-Reset: <ISO>`.

```yaml
GET /health:
  summary: Проверка Postgres и Redis (без авторизации)
  200: { ok: true }

# ---------- Профиль ----------
GET /api/me:
  summary: Пользователь, лимит, подписка, статистика пути
  200:
    user: { telegram_id: 123456789, username: "alex", first_name: "Алекс", notify_new_vacancies: true, notify_reminders: true, created_at: "2026-09-01T10:00:00Z" }
    quota: { unlimited: false, limit: 5, used: 2, remaining: 3, resetAt: "2026-10-11T21:00:00.000Z" }
    subscription: null            # или { plan: "month", expiresAt: "2026-11-10T12:00:00.000Z" }
    stats: { accepted: 14, rejected: 31, favorites: 6, applied: 9, viewed: 76, letters: 11,
             funnel: { applied: 6, invited: 2, interview: 1 } }

PATCH /api/me/settings:
  body: { notify_new_vacancies?: boolean, notify_reminders?: boolean }
  204: —

GET /api/resume:
  200: { resume: Resume | null }

PUT /api/resume:
  body: Resume
    # { full_name*, desired_position, city, contacts: {phone, email, telegram},
    #   experience: [{company*, position*, from*: "2022-03", to: "2024-01"|null, achievements}],
    #   skills: ["React"], education: [{institution*, degree, year}], portfolio: [{title*, url*}], about }
  200: { resume: Resume & { updated_at } }

GET /api/history:
  query: { cursor?: number, limit?: 1..50 = 30 }
  200:
    items: [{ id: 812, action: "apply", status: "applied", meta: {}, created_at: "…", vacancy_id: 42, title: "Node.js Backend Engineer", company: "Тинькофф" }]
    nextCursor: 790 | null

# ---------- Вакансии ----------
GET /api/vacancies/search:          # ПЛАТНЫЙ при page = 0
  query: { text, area?: "1", salary?: 150000, onlyWithSalary?: bool,
           experience?: noExperience|between1And3|between3And6|moreThan6,
           schedule?: fullDay|remote|flexible|shift|flyInFlyOut,
           orderBy?: relevance|publication_time|salary_desc, page?: 0..99 }
  200:
    items: [{ id: 42, title: "Node.js Backend Engineer", company: "Тинькофф", city: "Санкт-Петербург",
              salary: { from: 300000, to: null, currency: "RUR", gross: false },
              schedule: "flexible", experience: "between3And6",
              snippet: "Node.js, PostgreSQL, Kafka…", publishedAt: "2026-10-10T09:12:00+0300" }]
    found: 1284
    pages: 20
    page: 0
  402: LIMIT_EXCEEDED
  503: UPSTREAM_UNAVAILABLE      # любой 4xx/5xx возвращает запрос в лимит

GET /api/areas:
  query: { q: "Каз" }
  200: { items: [{ id: "88", text: "Казань" }] }

GET /api/vacancies/{id}:            # пишет действие view
  200:
    vacancy: { id, title, company, city, salary, experience, schedule, employment,
               keySkills: ["Node.js", "PostgreSQL"], description: "plain text", url: "https://hh.ru/vacancy/…",
               publishedAt, archived: false }
    isFavorite: true
    lastAction: { action: "apply", status: "applied" } | null

POST /api/vacancies/{id}/decision:
  body: { decision: accept | reject }
  204: —

POST /api/vacancies/{id}/status:
  body: { status: applied | invited | interview | offer | declined }
  204: —

# ---------- Избранное ----------
GET /api/favorites:
  200: { items: [{ id, title, company, city, salary_from, salary_to, salary_currency, archived, note, added_at }] }
PUT /api/favorites/{id}:
  body: { note?: string }
  204: —
DELETE /api/favorites/{id}:
  204: —

# ---------- Генератор отклика ----------
POST /api/cover-letter:             # ПЛАТНЫЙ. Резюме проверяется до списания
  body: { vacancyId: 42, tone: formal | friendly | short }
  200: { text: "Здравствуйте!\n\nМеня заинтересовала…", provider: "template", vacancyUrl: "https://hh.ru/vacancy/…" }
  409: RESUME_REQUIRED
  402: LIMIT_EXCEEDED

# ---------- Подписка ----------
GET /api/subscription:
  200:
    active: { plan: "month", expiresAt: "…" } | null
    quota: Quota
    plans: [{ id: "week", title: "Неделя", days: 7, price: 149, perDay: 21.3 }, …]
    methods: ["sbp", "card", "crypto"]
    history: [{ id, plan, status, amount, currency, starts_at, expires_at, created_at }]

POST /api/subscription/checkout:
  body: { plan: week | month | quarter, method: sbp | card | crypto }
  201: { subscriptionId: 57, paymentUrl: "https://pay.platega.io/…", expiresIn: "00:15:00" }
  502: PAYMENT_FAILED

GET /api/subscription/payments/{id}:   # кнопка «Проверить оплату» и автоопрос из Mini App
  200: { id: 57, plan: "month", status: pending | active | canceled | refunded, provider_status: "CONFIRMED", expires_at: "…" }

# ---------- Поддержка ----------
GET /api/support/faq:
  200: { items: [{ q, a }] }
POST /api/support/tickets:
  body: { topic: payment | bug | search | idea | other, message: 10..2000 символов }
  201: { id: 101 }

# ---------- Вебхуки (без initData) ----------
POST /webhooks/telegram:
  header: X-Telegram-Bot-Api-Secret-Token = BOT_WEBHOOK_SECRET
  body: Telegram Update

POST /webhooks/platega:
  headers: { X-MerchantId, X-Secret }
  body: { id: "uuid", amount: 399, currency: "RUB", status: CONFIRMED | CANCELED | CHARGEBACKED, paymentMethod: 2 }
  200: { ok: true } | { ok: true, ignored: "…" }
  401: неверные заголовки
  5xx: Platega повторит callback
```

---

## 4. Код

Ниже — ключевые фрагменты. Полные файлы — по ссылкам.

### 4.1. Сервер: проверка initData

[`backend/src/middleware/telegramAuth.ts`](backend/src/middleware/telegramAuth.ts)

```ts
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
```

### 4.2. Сервер: суточный лимит в Redis

Атомарность через Lua: проверка и инкремент — одна операция, поэтому параллельные запросы не проскочат лимит.
[`backend/src/services/quota.ts`](backend/src/services/quota.ts)

```ts
// Суточный лимит бесплатных запросов (поиск + генерация отклика) в Redis.
import { config } from '../config.js';
import { redis } from '../redis.js';
import { getActiveSubscription } from './subscription.js';

// Атомарно: если счётчик < лимита — INCR и выставить истечение на полночь; иначе -1.
const CONSUME_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur >= tonumber(ARGV[1]) then return -1 end
cur = redis.call('INCR', KEYS[1])
if cur == 1 then redis.call('EXPIREAT', KEYS[1], ARGV[2]) end
return cur`;

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
  const [sub, usedRaw] = await Promise.all([getActiveSubscription(userId), redis.get(key(userId, day))]);
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
  const res = (await redis.eval(
    CONSUME_LUA, 1, key(userId, day), config.FREE_DAILY_LIMIT, Math.floor(resetAt.getTime() / 1000),
  )) as number;
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
  const k = key(userId, day);
  const v = await redis.decr(k);
  if (v < 0) await redis.set(k, 0, 'KEEPTTL');
}
```

[`backend/src/middleware/quota.ts`](backend/src/middleware/quota.ts) — применение к роутам и редирект на подписку:

```ts
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
```

Подключение:
```ts
// поиск: платная только первая страница
vacanciesRouter.get('/vacancies/search', requireQuota((req) => !Number(req.query.page)), handler);
// генерация: сначала резюме, потом списание
vacanciesRouter.post('/cover-letter', loadResume, requireQuota(), handler);
```

### 4.3. Монетизация: Platega.io

**Где и как вызывается API**

| Шаг | Где | Вызов Platega |
|---|---|---|
| Пользователь жмёт «Оплатить» | `POST /api/subscription/checkout` → `createCheckout()` | `POST /transaction/process` |
| Platega сообщает о смене статуса | `POST /webhooks/platega` | callback → затем `GET /transaction/{id}` |
| Пользователь жмёт «Проверить оплату» | `GET /api/subscription/payments/{id}` | `GET /transaction/{id}`, если у нас ещё pending |
| Callback потерялся | `scheduler.reconcilePayments` каждые 2 мин | `GET /transaction/{id}` для pending от 2 мин до 24 ч |

**Параметры `POST /transaction/process`**: заголовки `X-MerchantId`, `X-Secret`; тело — `paymentMethod` (2 СБП / 11 карта / 13 крипта), `paymentDetails: {amount, currency: "RUB"}`, `description`, `return` (deep-link `t.me/<bot>/<app>?startapp=paid_<id>`), `failedUrl`, `orderId` (наш `subscriptions.id`), `payload`, `metadata: {userId: <telegram_id>, userName}` (нужен антифроду Platega). Ответ: `transactionId`, `redirect` (ссылка на оплату), `status`, `expiresIn`.

**Обработка статусов**

| Статус Platega | Наша подписка | Действие |
|---|---|---|
| `PENDING` | `pending` | ничего, ждём |
| `CONFIRMED` | `pending → active` | `starts_at = max(now, конец текущей подписки)`, `expires_at = starts_at + days`; сброс кэша; уведомление `payment_success` |
| `CANCELED` | `pending → canceled` | уведомление `payment_failed` |
| `CHARGEBACKED` | `active → refunded` | `expires_at = now()`; уведомление `subscription_revoked` |
| любой повтор | без изменений | идемпотентно (`SELECT … FOR UPDATE` + проверка текущего статуса) |

[`backend/src/services/platega.ts`](backend/src/services/platega.ts)

```ts
// Клиент Platega.io. Документация: https://docs.platega.io
// Авторизация всех запросов — заголовки X-MerchantId + X-Secret.
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';

export type PlategaStatus = 'PENDING' | 'CONFIRMED' | 'CANCELED' | 'CHARGEBACKED';

export interface CreateTransactionInput {
  paymentMethod: number; // 2 СБП QR, 11 карты РФ, 13 крипта, 14 SberPay
  amount: number;
  currency: 'RUB';
  description: string;
  returnUrl: string; // куда вернуть после успешной оплаты
  failedUrl: string;
  orderId: string; // наш subscriptions.id
  payload?: string; // вернётся в статусе транзакции
  userId: string; // metadata.userId — нужен антифроду Platega
  userName?: string;
}

export interface CreateTransactionResult {
  transactionId: string;
  redirect: string; // ссылка на форму оплаты
  status: PlategaStatus;
  expiresIn?: string; // "HH:MM:SS"
}

export interface TransactionInfo {
  id: string;
  status: PlategaStatus;
  paymentDetails?: { amount: number; currency: string } | string;
  payload?: string;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.PLATEGA_BASE_URL}${path}`, {
    method,
    headers: {
      'X-MerchantId': config.PLATEGA_MERCHANT_ID,
      'X-Secret': config.PLATEGA_SECRET,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`platega ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    throw new AppError(502, 'PAYMENT_FAILED', 'Payment provider error');
  }
  return (await res.json()) as T;
}

/** POST /transaction/process — создать платёж, получить ссылку на оплату. */
export function createTransaction(i: CreateTransactionInput) {
  return call<CreateTransactionResult>('POST', '/transaction/process', {
    paymentMethod: i.paymentMethod,
    paymentDetails: { amount: i.amount, currency: i.currency },
    description: i.description,
    return: i.returnUrl,
    failedUrl: i.failedUrl,
    orderId: i.orderId,
    payload: i.payload,
    metadata: { userId: i.userId, userName: i.userName ?? '' },
  });
}

/** GET /transaction/{id} — актуальный статус (повторная проверка вебхука и опрос «зависших» платежей). */
export function getTransaction(id: string) {
  return call<TransactionInfo>('GET', `/transaction/${encodeURIComponent(id)}`);
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Callback Platega приходит с теми же X-MerchantId / X-Secret.
 * Этого недостаточно как единственной защиты, поэтому обработчик вебхука
 * дополнительно перезапрашивает статус через getTransaction().
 */
export function verifyCallbackHeaders(merchantId?: string, secret?: string) {
  return Boolean(merchantId && secret && eq(merchantId, config.PLATEGA_MERCHANT_ID) && eq(secret, config.PLATEGA_SECRET));
}
```

[`backend/src/services/subscription.ts`](backend/src/services/subscription.ts) — создание платежа и применение статуса:

```ts
import { PLANS, PAYMENT_METHODS, webAppLink, type PlanId, type PaymentMethodKey } from '../config.js';
import { query, tx } from '../db.js';
import { redis } from '../redis.js';
import { AppError } from '../errors.js';
import { createTransaction, type PlategaStatus } from './platega.js';
import { enqueue } from './notify.js';

export interface ActiveSubscription {
  plan: PlanId;
  expiresAt: string; // до какого момента оплачено (с учётом продлений)
}

const cacheKey = (userId: number) => `sub:${userId}`;

export async function getActiveSubscription(userId: number): Promise<ActiveSubscription | null> {
  const cached = await redis.get(cacheKey(userId));
  if (cached) return cached === 'none' ? null : (JSON.parse(cached) as ActiveSubscription);

  const { rows } = await query<{ plan: PlanId; paid_until: Date }>(
    `SELECT
       (SELECT plan FROM subscriptions s2 WHERE s2.user_id = $1 AND s2.status = 'active'
          AND now() BETWEEN s2.starts_at AND s2.expires_at LIMIT 1) AS plan,
       max(expires_at) AS paid_until
     FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
    [userId],
  );
  const r = rows[0];
  const sub = r?.plan && r.paid_until ? { plan: r.plan, expiresAt: r.paid_until.toISOString() } : null;
  await redis.set(cacheKey(userId), sub ? JSON.stringify(sub) : 'none', 'EX', 60);
  return sub;
}

export const invalidateSubscription = (userId: number) => redis.del(cacheKey(userId));

export async function createCheckout(
  user: { id: number; telegramId: number; username?: string | null },
  plan: PlanId,
  method: PaymentMethodKey,
) {
  const p = PLANS[plan];
  const { rows } = await query<{ id: number }>(
    `INSERT INTO subscriptions (user_id, plan, amount, payment_method) VALUES ($1, $2, $3, $4) RETURNING id`,
    [user.id, plan, p.price, PAYMENT_METHODS[method]],
  );
  const subId = rows[0]!.id;

  try {
    const t = await createTransaction({
      paymentMethod: PAYMENT_METHODS[method],
      amount: p.price,
      currency: 'RUB',
      description: `ТвойПодбор PRO — ${p.title}`,
      returnUrl: webAppLink(`paid_${subId}`),
      failedUrl: webAppLink(`payfail_${subId}`),
      orderId: String(subId),
      payload: String(subId),
      userId: String(user.telegramId),
      userName: user.username ? `@${user.username}` : undefined,
    });
    await query(
      `UPDATE subscriptions SET provider_tx_id = $2, provider_status = $3, payment_url = $4, updated_at = now() WHERE id = $1`,
      [subId, t.transactionId, t.status, t.redirect],
    );
    return { subscriptionId: subId, paymentUrl: t.redirect, expiresIn: t.expiresIn ?? null };
  } catch (e) {
    await query(`UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE id = $1`, [subId]);
    throw e;
  }
}

/**
 * Применить статус Platega к подписке. Идемпотентно: повторный CONFIRMED ничего не меняет.
 * Новая подписка начинается после окончания текущей (продление стакается).
 */
export async function applyPaymentStatus(transactionId: string, status: PlategaStatus) {
  const changed = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, user_id, plan, status FROM subscriptions WHERE provider_tx_id = $1 FOR UPDATE`,
      [transactionId],
    );
    const sub = rows[0] as { id: number; user_id: number; plan: PlanId; status: string } | undefined;
    if (!sub) throw new AppError(404, 'NOT_FOUND', 'Unknown transaction');

    await c.query(`UPDATE subscriptions SET provider_status = $2, updated_at = now() WHERE id = $1`, [sub.id, status]);

    if (status === 'CONFIRMED' && sub.status === 'pending') {
      // Блокируем все подписки пользователя, чтобы параллельные оплаты не наложились.
      await c.query(`SELECT 1 FROM subscriptions WHERE user_id = $1 FOR UPDATE`, [sub.user_id]);
      const { rows: base } = await c.query(
        `SELECT greatest(now(), coalesce(max(expires_at), now())) AS starts_at
         FROM subscriptions WHERE user_id = $1 AND status = 'active'`,
        [sub.user_id],
      );
      const { rows: upd } = await c.query(
        `UPDATE subscriptions SET status = 'active', starts_at = $2,
           expires_at = $2::timestamptz + make_interval(days => $3), updated_at = now()
         WHERE id = $1 RETURNING expires_at`,
        [sub.id, base[0].starts_at, PLANS[sub.plan].days],
      );
      return { userId: sub.user_id, event: 'payment_success' as const, plan: sub.plan, expiresAt: upd[0].expires_at as Date };
    }
    if (status === 'CANCELED' && sub.status === 'pending') {
      await c.query(`UPDATE subscriptions SET status = 'canceled' WHERE id = $1`, [sub.id]);
      return { userId: sub.user_id, event: 'payment_failed' as const, plan: sub.plan };
    }
    if (status === 'CHARGEBACKED' && sub.status === 'active') {
      await c.query(`UPDATE subscriptions SET status = 'refunded', expires_at = now() WHERE id = $1`, [sub.id]);
      return { userId: sub.user_id, event: 'subscription_revoked' as const, plan: sub.plan };
    }
    return null;
  });

  if (!changed) return;
  await invalidateSubscription(changed.userId);
  await enqueue(changed.userId, changed.event, {
    plan: PLANS[changed.plan].title,
    expiresAt: changed.event === 'payment_success' ? changed.expiresAt.toISOString() : undefined,
  }, { dedupKey: `${changed.event}:${transactionId}` });
}

export async function getSubscriptionHistory(userId: number) {
  const { rows } = await query(
    `SELECT id, plan, status, amount, currency, starts_at, expires_at, created_at
     FROM subscriptions WHERE user_id = $1 AND status <> 'pending' ORDER BY created_at DESC LIMIT 20`,
    [userId],
  );
  return rows;
}

export async function getPaymentStatus(userId: number, subId: number) {
  const { rows } = await query(
    `SELECT id, plan, status, provider_status, expires_at FROM subscriptions WHERE id = $1 AND user_id = $2`,
    [subId, userId],
  );
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND');
  return rows[0];
}
```

Обработчик вебхука, [`backend/src/routes/webhooks.ts`](backend/src/routes/webhooks.ts):

```ts
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
```

### 4.4. Клиент (React)

**Запросы и перехват лимита** — [`webapp/src/api.ts`](webapp/src/api.ts) (фрагмент):

```ts
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + '/api' + path, {
    method,
    headers: {
      Authorization: `tma ${tg?.initData ?? ''}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error ?? {};
    const e = new ApiError(res.status, err.code ?? 'INTERNAL', err);
    // App слушает событие и открывает экран подписки с таймером
    if (e.code === 'LIMIT_EXCEEDED') limitEvents.dispatchEvent(new CustomEvent('limit', { detail: err }));
    throw e;
  }
  return data as T;
}
```

**Нативные кнопки Telegram** — `BottomCta` из [`webapp/src/components/ui.tsx`](webapp/src/components/ui.tsx): в Telegram — `MainButton` (зелёный, с shine-эффектом) и `SecondaryButton` (фиолетовый), вне Telegram — HTML-аналог.

```tsx
export function BottomCta({ text, onClick, loading, disabled, secondary }: CtaProps) {
  const cb = useRef(onClick);
  cb.current = onClick;

  useEffect(() => {
    if (!tg) return;
    const h = () => cb.current();
    tg.MainButton.onClick(h);
    return () => { tg!.MainButton.offClick(h); tg!.MainButton.hide(); };
  }, []);

  useEffect(() => {
    if (!tg) return;
    tg.MainButton.setParams({
      text, color: COLORS.cta, text_color: COLORS.ctaText, is_visible: true,
      is_active: !disabled && !loading, has_shine_effect: !disabled,
    });
    loading ? tg.MainButton.showProgress(false) : tg.MainButton.hideProgress();
  }, [text, loading, disabled]);
  // … SecondaryButton аналогично, фолбэк-разметка вне Telegram
}
```

Также используются: `BackButton` (стек экранов в `App.tsx`), `showConfirm` (удаление из избранного), `showAlert` (ошибки оплаты), `enableClosingConfirmation` (несохранённое резюме), `HapticFeedback`, `openLink` (оплата, hh.ru), `disableVerticalSwipes`, `setHeaderColor`/`setBackgroundColor`/`setBottomBarColor`. Инлайн-кнопки `web_app` — в сообщениях бота.

**Экран поиска** — [`webapp/src/screens/Search.tsx`](webapp/src/screens/Search.tsx):

```tsx
import { useEffect, useLayoutEffect, useState } from 'react';
import { api, type SearchParams, type VacancyCard as V } from '../api';
import { B, C, T, fmt } from '../copy';
import { useNav } from '../nav';
import { haptic } from '../tg';
import { VacancyCard } from '../components/VacancyCard';
import { Empty, ErrorBox, QuotaBar, Skeleton } from '../components/ui';

const CITIES = [{ id: '1', text: 'Москва' }, { id: '2', text: 'Санкт-Петербург' }, { id: '113', text: 'Вся Россия' }];

// Состояние живёт вне компонента: «назад» с карточки возвращает ту же выдачу и скролл.
const store = {
  params: { text: '', area: '113' } as SearchParams & { areaName?: string },
  items: [] as V[],
  found: null as number | null,
  page: 0,
  pages: 0,
  scrollY: 0,
};

export function Search() {
  const { push, refreshMe } = useNav();
  const [params, setParams] = useState(store.params);
  const [items, setItems] = useState(store.items);
  const [found, setFound] = useState(store.found);
  const [showFilters, setShowFilters] = useState(false);
  const [cityQuery, setCityQuery] = useState('');
  const [citySuggest, setCitySuggest] = useState<{ id: string; text: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // сохранить скролл в layout-cleanup (до того как App прокрутит новый экран наверх), восстановить — после
  useLayoutEffect(() => () => { store.scrollY = window.scrollY; }, []);
  useEffect(() => { window.scrollTo(0, store.scrollY); }, []);
  useEffect(() => { store.params = params; }, [params]);

  // автодополнение города (hh /suggests/areas), с задержкой
  useEffect(() => {
    if (cityQuery.trim().length < 2) return setCitySuggest([]);
    const t = setTimeout(() => api.areas(cityQuery).then((r) => setCitySuggest(r.items)).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [cityQuery]);

  const set = <K extends keyof typeof params>(k: K, v: (typeof params)[K]) => {
    haptic.select();
    setParams((p) => ({ ...p, [k]: v }));
  };

  async function run(page = 0) {
    setLoading(true);
    setError(null);
    try {
      const { areaName: _, ...p } = params;
      const r = await api.search({ ...p, page });
      const next = page ? [...store.items, ...r.items] : r.items;
      Object.assign(store, { items: next, found: r.found, page: r.page, pages: r.pages });
      setItems(next);
      setFound(r.found);
      if (!page) { haptic.success(); setShowFilters(false); refreshMe(); }
    } catch (e) {
      setError(e);
      haptic.error();
    } finally {
      setLoading(false);
    }
  }

  const activeFilters = [params.salary, params.experience, params.schedule].filter(Boolean).length;

  return (
    <div className="stack">
      <div className="card stack">
        <input
          className="input"
          placeholder={C.search_placeholder}
          value={params.text}
          onChange={(e) => setParams((p) => ({ ...p, text: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          enterKeyHint="search"
        />
        <div className="chips">
          {CITIES.map((c) => (
            <button key={c.id} className={`chip ${params.area === c.id ? 'on' : ''}`} onClick={() => set('area', c.id)}>{c.text}</button>
          ))}
          {params.areaName && !CITIES.some((c) => c.id === params.area) && <button className="chip on">{params.areaName}</button>}
          <button className={`chip ${activeFilters ? 'on' : ''}`} onClick={() => setShowFilters((s) => !s)}>
            {B.filters}{activeFilters ? ` · ${activeFilters}` : ''}
          </button>
        </div>

        {showFilters && (
          <div className="stack">
            <div>
              <label className="label">{C.city}</label>
              <input className="input" value={cityQuery} onChange={(e) => setCityQuery(e.target.value)} placeholder="Казань" />
              {citySuggest.length > 0 && (
                <div className="chips" style={{ marginTop: 8 }}>
                  {citySuggest.map((c) => (
                    <button key={c.id} className="chip" onClick={() => { setParams((p) => ({ ...p, area: c.id, areaName: c.text })); setCityQuery(''); }}>{c.text}</button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="label">{C.salary_from}</label>
              <input className="input" inputMode="numeric" value={params.salary ?? ''} placeholder="150 000"
                onChange={(e) => set('salary', Number(e.target.value.replace(/\D/g, '')) || undefined)} />
            </div>
            <div>
              <label className="label">Опыт</label>
              <div className="chips">
                {Object.entries(C.experience).map(([k, label]) => (
                  <button key={k} className={`chip ${(params.experience ?? 'any') === k ? 'on' : ''}`}
                    onClick={() => set('experience', k === 'any' ? undefined : k)}>{label}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Формат</label>
              <div className="chips">
                {Object.entries(C.schedule).map(([k, label]) => (
                  <button key={k} className={`chip ${(params.schedule ?? 'any') === k ? 'on' : ''}`}
                    onClick={() => set('schedule', k === 'any' ? undefined : k)}>{label}</button>
                ))}
              </div>
            </div>
            <button className="btn btn-ghost sm" onClick={() => setParams({ text: params.text, area: '113' })}>{B.reset_filters}</button>
          </div>
        )}

        <button className="btn btn-cta block" onClick={() => run()} disabled={loading}>
          {loading && !store.page ? '…' : B.search}
        </button>
        <QuotaBar />
      </div>

      {error ? <ErrorBox error={error} onRetry={() => run()} /> : null}

      {found !== null && <h2>{fmt(T.results, { count: found.toLocaleString('ru-RU') })}</h2>}
      {loading && !items.length && <Skeleton />}
      {found === 0 && <Empty>{C.empty_results}</Empty>}
      {items.map((v) => <VacancyCard key={v.id} v={v} onOpen={() => push({ name: 'vacancy', id: v.id })} />)}

      {items.length > 0 && store.page + 1 < store.pages && (
        <button className="btn btn-sec block" onClick={() => run(store.page + 1)} disabled={loading}>
          {loading ? '…' : B.load_more}
        </button>
      )}
    </div>
  );
}
```

**Экран профиля** — [`webapp/src/screens/Profile.tsx`](webapp/src/screens/Profile.tsx) (основной компонент):

```tsx
export function Profile() {
  const { me, push, refreshMe } = useNav();
  useEffect(refreshMe, []);
  if (!me) return <Skeleton h={100} />;

  const { stats, quota, subscription } = me;
  const funnelMax = Math.max(1, ...FUNNEL.map(([k]) => stats.funnel[k] ?? 0));
  const daysLeft = subscription ? Math.ceil((new Date(subscription.expiresAt).getTime() - Date.now()) / 86400000) : 0;

  return (
    <div className="stack">
      <div className="row between">
        <h1>{me.user.first_name ?? T.profile}</h1>
        <button className="btn btn-ghost sm" onClick={() => push({ name: 'resume' })}>{T.resume}</button>
      </div>

      {/* статистика пути — крупные белые цифры */}
      <div className="stats">
        {([['accepted', C.stats_accepted], ['rejected', C.stats_rejected], ['favorites', C.stats_favorites], ['applied', C.stats_applied]] as const)
          .map(([k, label]) => (
            <div key={k} className="card stat">
              <div className="value">{stats[k]}</div>
              <div className="caption">{label}</div>
            </div>
          ))}
      </div>

      <div className="card stack">
        <h3>Воронка откликов</h3>
        {FUNNEL.map(([k, label]) => (
          <div key={k} className="stack" style={{ gap: 4 }}>
            <div className="row between small"><span>{label}</span><span className="num">{stats.funnel[k] ?? 0}</span></div>
            <div className="progress"><i style={{ width: `${((stats.funnel[k] ?? 0) / funnelMax) * 100}%` }} /></div>
          </div>
        ))}
      </div>

      {/* лимит / подписка: критическое значение — красным */}
      {subscription ? (
        <div className="card accent row between card-click" onClick={() => push({ name: 'subscription' })}>
          <div className="stack" style={{ gap: 2 }}>
            <span className="status" style={{ fontWeight: 700 }}>{fmt(C.pro_active_until, { date: formatDate(subscription.expiresAt) })}</span>
            <span className={`small ${daysLeft <= 1 ? 'warn' : ''}`}>{fmt(C.pro_days_left, { days: daysLeft })}</span>
          </div>
          <span className="small">{B.extend_pro} →</span>
        </div>
      ) : (
        <div className={`card stack ${quota.remaining === 0 ? 'danger' : ''}`}>
          <div className="row between">
            <span>Бесплатные запросы</span>
            <span className={`num ${quota.remaining === 0 ? 'warn' : ''}`} style={{ fontSize: 20 }}>{quota.remaining}/{quota.limit}</span>
          </div>
          <div className={`progress ${quota.remaining === 0 ? 'warn' : ''}`}>
            <i style={{ width: `${(quota.used / quota.limit) * 100}%` }} />
          </div>
          {quota.remaining === 0 && <Countdown to={quota.resetAt} onDone={refreshMe} />}
          <button className="btn btn-cta" onClick={() => push({ name: 'subscription' })}>{B.get_pro}</button>
        </div>
      )}

      <RecentHistory />

      <button className="btn btn-ghost" onClick={() => push({ name: 'support' })}>{B.support}</button>
    </div>
  );
}
```

---

## 5. Палитра и контраст

Токены — [`webapp/src/styles.css`](webapp/src/styles.css). Проверка: `node scripts/contrast.mjs`.

| Роль | Цвет | Где применяется |
|---|---|---|
| Фон | `#07080B` + сетка `#2B2F3A` 45% | body |
| Карточки | `#1E2028 → #1A1C23` | все контейнеры |
| CTA, ключевые суммы | `#00FF9D → #00D46B` | главная кнопка экрана, зарплата в карточке, цена выбранного тарифа |
| Вторичное, статусы, прогресс | `#4A55E2 → #636CFF`, текст `#8F96FF` | вторичные кнопки, чипы фильтров, прогресс-бары, бейджи |
| Ошибки, лимиты, дедлайны | `#FF5E5E → #FF3B3B` | таймер, исчерпанный лимит, «вакансия закрыта», отказ |
| Текст | `#FFFFFF` — заголовки и цифры; `#A0A0A0` — остальное | — |

| Пара | Контраст | Итог |
|---|---|---|
| `#FFFFFF` на `#07080B` | 20,03 | ✓ |
| `#A0A0A0` на `#1A1C23` | 6,51 | ✓ |
| `#A0A0A0` на `#22252E` | 5,85 | ✓ |
| `#07080B` на `#00D46B` (текст CTA) | 10,14 | ✓ |
| `#00FF9D` на `#1A1C23` | 12,79 | ✓ |
| `#FFFFFF` на `#4A55E2` | 5,69 | ✓ |
| `#FFFFFF` на `#636CFF` | 4,10 | ✗ для обычного текста |
| `#FFFFFF` на середине градиента `#5660F0` | 4,85 | ✓ |
| `#8F96FF` на `#1A1C23` | 6,46 | ✓ |
| `#FF5E5E` на `#1A1C23` | 5,68 | ✓ |

Конец фиолетового градиента `#636CFF` с белым текстом не проходит 4.5:1. Поэтому текст вторичных кнопок всегда центрирован (попадает на середину градиента), а фиолетовый текст на тёмном фоне выводится осветлённым `#8F96FF`. Белый текст на красном не используется — на красных плашках текст тёмный (`#07080B`, 6,69).

---

## 6. Тексты и UX-копии

Файл: [`shared/copy.ru.json`](shared/copy.ru.json) — его читают и бот, и Mini App. Кроме пяти ключей из ТЗ есть `screen_copy` (подписи, пустые состояния, тексты экрана подписки). Шаблоны уведомлений — HTML-разметка Telegram; `{param}` подставляется с экранированием, `start` — экран, который откроет кнопка.

```json
{
  "button_texts": {
    "search": "Найти вакансии",
    "search_again": "Искать ещё",
    "filters": "Фильтры",
    "reset_filters": "Сбросить",
    "apply_filters": "Применить",
    "details": "Подробнее",
    "accept": "Подходит",
    "reject": "Не моё",
    "favorite_add": "В избранное",
    "favorite_remove": "Убрать из избранного",
    "open_on_hh": "Открыть на hh.ru",
    "mark_applied": "Отклик отправлен",
    "generate_letter": "Сгенерировать отклик",
    "regenerate": "Другой вариант",
    "copy": "Копировать",
    "copied": "Скопировано",
    "edit_resume": "Редактировать резюме",
    "save_resume": "Сохранить",
    "add_experience": "+ Место работы",
    "add_education": "+ Образование",
    "add_portfolio": "+ Ссылка на работу",
    "get_pro": "Снять лимит",
    "pay": "Оплатить {price} ₽",
    "pay_sbp": "СБП",
    "pay_card": "Карта",
    "pay_crypto": "Крипта",
    "check_payment": "Проверить оплату",
    "extend_pro": "Продлить",
    "support": "Поддержка",
    "send_ticket": "Отправить",
    "load_more": "Показать ещё",
    "open_app": "Открыть ТвойПодбор",
    "retry": "Повторить",
    "back": "Назад"
  },

  "screen_titles": {
    "search": "Поиск",
    "results": "Найдено: {count}",
    "vacancy": "Вакансия",
    "profile": "Профиль",
    "resume": "Резюме",
    "history": "История",
    "cover_letter": "Отклик",
    "favorites": "Избранное",
    "subscription": "PRO-доступ",
    "subscription_status": "Подписка",
    "payment_pending": "Ждём оплату",
    "payment_success": "PRO активен",
    "limit_reached": "Лимит на сегодня исчерпан",
    "support": "Поддержка",
    "faq": "Частые вопросы"
  },

  "screen_copy": {
    "search_placeholder": "Должность, навык или компания",
    "salary_from": "Зарплата от, ₽",
    "city": "Город",
    "experience": { "any": "Любой опыт", "noExperience": "Без опыта", "between1And3": "1–3 года", "between3And6": "3–6 лет", "moreThan6": "6+ лет" },
    "schedule": { "any": "Любой формат", "fullDay": "Офис", "remote": "Удалёнка", "flexible": "Гибкий", "shift": "Сменный", "flyInFlyOut": "Вахта" },
    "salary_none": "З/п не указана",
    "quota_left": "Бесплатно сегодня: {remaining} из {limit}",
    "quota_unlimited": "PRO · без лимита",
    "stats_accepted": "Подошло",
    "stats_rejected": "Отклонено",
    "stats_favorites": "В избранном",
    "stats_applied": "Откликов",
    "empty_results": "Ничего не нашли. Уберите часть фильтров или поменяйте запрос.",
    "empty_favorites": "Пусто. Жмите «В избранное» на карточке вакансии — она появится здесь.",
    "empty_history": "Истории пока нет. Найдите первую вакансию.",
    "resume_required": "Отклик собирается из резюме. Заполните хотя бы имя, опыт и навыки — 2 минуты.",
    "letter_hint": "Проверьте текст перед отправкой: генератор берёт только факты из резюме.",
    "limit_body": "5 бесплатных запросов в день закончились. Новые будут через:",
    "limit_formula": "1 поиск = 1 запрос · 1 отклик = 1 запрос · PRO = без ограничений",
    "plan_week": "Неделя",
    "plan_month": "Месяц",
    "plan_quarter": "3 месяца",
    "plan_per_day": "{perDay} ₽/день",
    "plan_badge_best": "−{pct}% к неделе",
    "pro_active_until": "PRO до {date}",
    "pro_days_left": "Осталось {days} дн.",
    "payment_pending_body": "Оплатите в открывшемся окне. Статус обновится автоматически.",
    "payment_success_body": "Лимиты сняты до {date}.",
    "support_topic": { "payment": "Оплата", "bug": "Ошибка в приложении", "search": "Поиск вакансий", "idea": "Предложение", "other": "Другое" },
    "support_placeholder": "Опишите проблему. Если это оплата — укажите дату и сумму.",
    "support_sent": "Обращение #{id} принято. Ответим в чате с ботом в течение 24 часов."
  },

  "error_messages": {
    "AUTH_REQUIRED": "Откройте приложение через бота — так мы узнаем, что это вы.",
    "AUTH_INVALID": "Не удалось подтвердить вход. Закройте и откройте приложение заново.",
    "AUTH_EXPIRED": "Сессия устарела. Перезапустите приложение из чата с ботом.",
    "VALIDATION": "Проверьте заполненные поля.",
    "NOT_FOUND": "Вакансия больше недоступна — работодатель её закрыл.",
    "LIMIT_EXCEEDED": "Бесплатные запросы на сегодня закончились.",
    "RESUME_REQUIRED": "Сначала заполните резюме — без него отклик не собрать.",
    "UPSTREAM_UNAVAILABLE": "hh.ru не отвечает. Запрос не списан, попробуйте через минуту.",
    "PAYMENT_FAILED": "Платёж не создан. Деньги не списаны — попробуйте другой способ оплаты.",
    "PAYMENT_CANCELED": "Оплата отменена. Деньги не списаны.",
    "OFFLINE": "Нет соединения с интернетом.",
    "INTERNAL": "Что-то сломалось на нашей стороне. Уже чиним."
  },

  "notification_templates": {
    "new_vacancies": {
      "text": "<b>{count} новых вакансий</b> по запросу «{query}»\n\n{list}",
      "buttons": [{ "text": "Смотреть все", "start": "search" }]
    },
    "employer_reply": {
      "text": "<b>Ответ работодателя</b>\n«{title}» · {company}\nСтатус: <b>{status}</b>",
      "buttons": [{ "text": "Открыть вакансию", "start": "vacancy_{vacancyId}" }]
    },
    "favorite_reminder": {
      "text": "«{title}» лежит в избранном {days} дн. Вакансии на hh закрываются в среднем за 2–3 недели — откликнитесь, пока открыта.",
      "buttons": [{ "text": "Сгенерировать отклик", "start": "letter_{vacancyId}" }]
    },
    "limit_reset": {
      "text": "Лимит обновлён: снова {limit} бесплатных запросов.",
      "buttons": [{ "text": "Искать", "start": "search" }]
    },
    "sub_expiring": {
      "text": "PRO закончится <b>{expiresAt}</b>. Потом — снова 5 запросов в день.",
      "buttons": [{ "text": "Продлить", "start": "subscription" }]
    },
    "sub_expired": {
      "text": "PRO закончился. Доступно 5 бесплатных запросов в день.",
      "buttons": [{ "text": "Вернуть PRO", "start": "subscription" }]
    },
    "payment_success": {
      "text": "<b>Оплата прошла.</b> PRO «{plan}» активен до {expiresAt}.",
      "buttons": [{ "text": "Открыть", "start": "search" }]
    },
    "payment_failed": {
      "text": "Оплата PRO «{plan}» не прошла. Деньги не списаны.",
      "buttons": [{ "text": "Попробовать снова", "start": "subscription" }]
    },
    "subscription_revoked": {
      "text": "Платёж за PRO «{plan}» отозван банком, доступ отключён. Вопросы — в поддержку.",
      "buttons": [{ "text": "Поддержка", "start": "support" }]
    },
    "support_received": {
      "text": "Обращение #{id} принято. Ответ придёт сюда в течение 24 часов.",
      "buttons": []
    },
    "bot_start": {
      "text": "<b>ТвойПодбор</b> — вакансии с hh.ru, резюме и готовые отклики в одном окне.\n\n5 запросов в день бесплатно.",
      "buttons": [{ "text": "Открыть ТвойПодбор", "start": "search" }]
    }
  },

  "faq": [
    {
      "q": "Откуда вакансии?",
      "a": "Из открытого API hh.ru. Обновляем выдачу каждые 10 минут, описание вакансии — при открытии карточки."
    },
    {
      "q": "Что считается запросом?",
      "a": "Новый поиск (первая страница) и генерация отклика. Листание результатов, открытие карточек, избранное и резюме — бесплатно и без лимита."
    },
    {
      "q": "Когда обновляется лимит?",
      "a": "Каждый день в 00:00 по Москве. Таймер на экране лимита показывает точное время."
    },
    {
      "q": "Отклик отправляется работодателю автоматически?",
      "a": "Нет. Вы копируете текст и отправляете его сами на hh.ru — так отклик точно уйдёт с вашего аккаунта."
    },
    {
      "q": "Как оплатить PRO?",
      "a": "СБП, банковской картой РФ или криптой через Platega. После оплаты доступ включается автоматически, обычно за минуту."
    },
    {
      "q": "Оплата прошла, а PRO не включился",
      "a": "Нажмите «Проверить оплату» на экране подписки. Если через 15 минут статус не изменился — напишите в поддержку, указав дату и сумму."
    },
    {
      "q": "Подписка продлевается сама?",
      "a": "Нет, автосписаний нет. За сутки до окончания пришлём напоминание."
    },
    {
      "q": "Можно вернуть деньги?",
      "a": "Да, если PRO не использовался (ни одного запроса после оплаты). Напишите в поддержку с темой «Оплата»."
    },
    {
      "q": "Кто видит моё резюме?",
      "a": "Только вы. Оно хранится у нас и используется только для генерации откликов. Удалить данные — через поддержку."
    }
  ]
}
```

**Когда отправляется уведомление**

| Шаблон | Триггер |
|---|---|
| `new_vacancies` | раз в сутки 10:00–21:00 МСК, если по последнему поиску есть новые вакансии |
| `favorite_reminder` | вакансия 3+ дня в избранном, отклика нет, вакансия не закрыта (одно напоминание) |
| `limit_reset` | пользователь упёрся в лимит → сообщение в 00:00 МСК |
| `sub_expiring` | за 24 часа до конца оплаченного периода |
| `sub_expired` | период закончился, новой подписки нет |
| `payment_success` / `payment_failed` / `subscription_revoked` | смена статуса платежа |
| `support_received` | создано обращение |
| `employer_reply` | v2, после OAuth hh |
| `bot_start` | команда /start |

---

## 7. Промпты для генерации UI-экранов

Промпты на английском — генераторы изображений лучше понимают английский. Русский текст на экране генераторы часто искажают: для макетов лучше брать генерацию как референс стиля, а финальный текст ставить в Figma.

**Общая часть для всех четырёх** (добавлять в конец каждого промпта):
> Mobile app UI screenshot, Telegram Mini App, 9:19.5 portrait, iPhone 15 frame, flat front view, crisp vector UI, Inter and JetBrains Mono typography, 8px grid. Color roles strictly: background #07080B near-black with a cold tint; cards #1A1C23 with a subtle top-to-bottom inner gradient from #1E2028; thin 1px grid lines and borders #2B2F3A; primary CTA neon green gradient #00FF9D→#00D46B with dark #07080B label and soft green glow; secondary actions and progress bars indigo gradient #4A55E2→#636CFF; warnings and limits warm red #FF5E5E→#FF3B3B; headings and key numbers pure white #FFFFFF; all other text light gray #A0A0A0. Maximum three bright accents on screen, 80% of the area neutral dark. All text must be sharp and legible on the dark background, contrast at least 4.5:1, no text over gradients or glow, no blur on text. No people, no 3D illustrations, no stock icons, no lens flares.

**1. Поиск вакансий**
- Стиль: crypto-promo dark tech, приборная панель, плотная сетка.
- Палитра: фон #07080B, карточки #1A1C23, CTA #00FF9D→#00D46B, фильтры #4A55E2→#636CFF.
- Ключевые элементы: шапка (логотип «ТП» слева, счётчик «3/5» и аватар справа), поле поиска, ряд чипов-фильтров, зелёная кнопка «Найти вакансии», прогресс лимита, 3 карточки вакансий.
- Читаемость: белые заголовки и зарплаты моноширинным, серый вторичный текст ≥ 4.5:1.
> Job search screen of a dark fintech-style app. Top bar: small neon-green square logo with "ТП" on the left, a pill showing "3/5" requests and a round avatar on the right. Below: a large graphite card with a dark search input, a horizontal row of rounded filter chips where the active ones are outlined in indigo #636CFF with indigo text, a full-width glowing neon-green gradient button "Найти вакансии", and a thin indigo progress bar labeled "Бесплатно сегодня: 3 из 5". Under it a "Найдено: 1 284" heading and three stacked graphite vacancy cards, each with a white job title, gray company and city, salary in white monospace digits, two small tags (one indigo "Удалёнка", one gray "3–6 лет") and an indigo "Подробнее →" link. Bottom tab bar with three icons, the active one neon green. Faint #2B2F3A grid visible in the background behind the cards.

**2. Профиль + статистика**
- Стиль: dashboard, крупные цифры, минимум текста.
- Палитра: цифры белые, карточки #1A1C23, прогресс #4A55E2→#636CFF, лимит #FF5E5E→#FF3B3B.
- Ключевые элементы: сетка 2×2 из карточек статистики, воронка откликов из 4 полос, карточка лимита в красной рамке с таймером, зелёная кнопка «Снять лимит».
- Читаемость: цифры 30px+ белым моноширинным, подписи капсом серым.
> Profile and statistics screen. Header with user name "Алекс" in bold white and a small ghost button "Резюме". A 2×2 grid of graphite stat cards, each with one huge white monospace number (14, 31, 6, 9) and a small uppercase gray caption ("ПОДОШЛО", "ОТКЛОНЕНО", "В ИЗБРАННОМ", "ОТКЛИКОВ"). Below: a card "Воронка откликов" with four labeled horizontal progress bars in indigo gradient with white counts on the right. Then a card with a thin warm-red border: "Бесплатные запросы" with a red monospace "0/5", a red progress bar fully filled, a countdown "05 : 42 : 17" in red monospace cells, and a full-width neon-green gradient button "Снять лимит". Dashboard feel, generous spacing, no decorative clutter.

**3. Генератор отклика**
- Стиль: минималистичная карточка-редактор, фокус на действии.
- Палитра: «Копировать» #00FF9D→#00D46B, предупреждение #FF5E5E, сетка #2B2F3A приглушённая.
- Ключевые элементы: чипы тона, красная плашка «Остался 1 бесплатный запрос», карточка с текстом письма, нижняя панель с фиолетовой «Другой вариант» и зелёной «Копировать».
- Читаемость: текст письма серым на графите, межстрочный 1.5, без текста поверх свечения.
> Cover letter generator screen. Title "Отклик" in white. A row of three tone chips, the first ("Деловой") outlined in indigo. A slim warning bar with a warm-red 1px border and red text "Остался 1 бесплатный запрос на сегодня" plus a small ghost button "Снять лимит". A tall minimalist graphite card containing a plain-text Russian cover letter in light gray (#A0A0A0), comfortable line height, bullet points, with a thin divider and a small gray hint below. Fixed bottom bar: a medium indigo gradient button "Другой вариант" on the left and a wider glowing neon-green gradient button "Копировать" with dark label on the right — the green button is the clear focal point. Background shows a muted #2B2F3A technical grid fading toward the bottom.

**4. Подписка / лимит**
- Стиль: агрессивный конверсионный экран, срочность.
- Палитра: таймер #FF5E5E→#FF3B3B, формула белым, CTA #00FF9D→#00D46B, бейдж выгоды #4A55E2→#636CFF.
- Ключевые элементы: логотип слева и баланс «0/5» справа, карточка «Лимит на сегодня исчерпан» с таймером ЧЧ:ММ:СС, формула «1 поиск = 1 запрос…», три тарифа (выбран средний, зелёная рамка), бейдж «−48% к неделе», чипы СБП / Карта / Крипта, формула «399 ₽ ÷ 30 дн = 13,3 ₽/день», кнопка «Оплатить 399 ₽».
- Читаемость: цифры таймера 30px в красном на тёмной ячейке, формулы белым моноширинным в пунктирной рамке.
> Subscription paywall screen with urgency. Top corners: neon-green "ТП" logo left, a pill with a red "0/5" counter and avatar right. A graphite card with a warm-red border: white heading "Лимит на сегодня исчерпан", gray subtitle, and a large countdown timer split into three dark cells "23 : 50 : 05" with red monospace digits and tiny gray labels "ЧАС МИН СЕК". Below, a dashed-border box with a white monospace formula "1 поиск = 1 запрос · 1 отклик = 1 запрос · PRO = без ограничений". Three stacked plan cards: "Неделя 149 ₽", "Месяц 399 ₽" (selected: neon-green border, price in neon green), "3 месяца 990 ₽" with a small indigo badge "−48% к неделе" overlapping its top edge; each card shows "₽/день" in gray. A row of payment chips "СБП" (active, indigo), "Карта", "Крипта". A white monospace line "399 ₽ ÷ 30 дн = 13,3 ₽/день" with the result in green. Full-width glowing neon-green gradient button "Оплатить 399 ₽" at the bottom. Technical grid in the background.

---

## 8. Запуск

### Локально

1. Установить Node.js 20+, Docker.
2. `cp .env.example .env`, заполнить `BOT_TOKEN`, `PLATEGA_*`, `HH_USER_AGENT`, `BOT_WEBHOOK_SECRET` (`openssl rand -hex 32`).
3. Поднять базы: `docker compose up -d postgres redis` (для локального доступа добавьте `ports: ["5432:5432"]` и `["6379:6379"]`).
4. Миграции: `cd backend && npm i && npm run migrate:dev`.
5. API: `npm run dev` (порт 3000). Тесты: `npm test`.
6. Mini App: `cd webapp && npm i && npm run dev` → http://localhost:5173. Вне Telegram подключаются моки, реальный API не нужен.
7. Проверка внутри Telegram: пробросить оба порта наружу по HTTPS (`cloudflared tunnel --url http://localhost:5173` и отдельно для 3000), прописать адреса в `PUBLIC_URL` / `WEBAPP_URL`, перезапустить API — вебхук и кнопка меню выставятся сами.

### Telegram

8. @BotFather → `/newbot` → получить `BOT_TOKEN`, имя → `BOT_USERNAME`.
9. @BotFather → `/newapp` → выбрать бота, указать URL `https://app.example.com`, short name (например `app`) → `WEBAPP_SHORT_NAME`. Прямая ссылка: `https://t.me/<bot>/app`.
10. Вебхук, кнопка меню «Вакансии» и команды `/start`, `/pro`, `/support` выставляются автоматически при старте API (`setupBot()`), если `PUBLIC_URL` на https.
11. Для пересылки обращений: создать чат операторов, добавить бота, id чата → `SUPPORT_CHAT_ID`.

### Platega.io

12. Личный кабинет → Merchant ID → `PLATEGA_MERCHANT_ID`, API-ключ → `PLATEGA_SECRET`.
13. В настройках магазина указать callback URL: `https://api.example.com/webhooks/platega`.
14. Включить методы оплаты: СБП, карты, крипта. Уточнить у менеджера Platega, обязателен ли `metadata.userId` для вашей категории — мы передаём его всегда.
15. Тестовый платёж на минимальную сумму: временно поставить цену недели 10 ₽ в `config.ts` → оплатить → в логах API callback, в БД `subscriptions.status = 'active'`, в чате — `payment_success`.

### hh.ru

16. `HH_USER_AGENT` в формате `НазваниеПриложения/версия (контакт)` — без него hh отвечает 400/403.
17. Опционально: зарегистрировать приложение на dev.hh.ru, получить токен приложения (`grant_type=client_credentials`) → `HH_APP_TOKEN` (лимиты выше).

### Прод (VPS + Docker)

18. Сервер с Docker и открытыми 80/443. DNS: A-записи `api.example.com` и `app.example.com` → IP сервера.
19. На сервер в `/opt/tvoypodbor`: `docker-compose.yml`, `Caddyfile`, `.env` (с `API_DOMAIN`, `APP_DOMAIN`, `POSTGRES_PASSWORD`).
20. Первый запуск вручную: `docker compose build` → `docker compose run --rm migrate` → `docker compose up -d`. Caddy сам получит сертификаты.
21. Проверка: `curl https://api.example.com/health` → `{"ok":true}`; `/start` в боте → кнопка открывает Mini App.

### CI/CD (GitHub Actions)

22. Secrets репозитория: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH=/opt/tvoypodbor`. Variable: `PUBLIC_URL=https://api.example.com` (вшивается в сборку Mini App).
23. Пуш в `main`: typecheck + тесты + сборка → образы в GHCR с тегом коммита → SSH на сервер → `pull` → `migrate` → `up -d`. PR запускают только проверки.
24. Новая миграция = новый файл `backend/migrations/002_*.sql`; применяется при деплое автоматически.

### Генератор откликов на LLM (когда понадобится)

25. Бесплатно: OpenRouter → ключ → `LLM_PROVIDER=openai_compat`, `LLM_BASE_URL=https://openrouter.ai/api/v1`, `LLM_MODEL=<модель с суффиксом :free>`. Groq — аналогично, `https://api.groq.com/openai/v1`. Платный провайдер — те же три переменные. Если LLM недоступен, срабатывает шаблонный генератор.

---

## 9. Риски и что проверить до запуска

- **hh.ru API.** Условия использования публичного API для коммерческих сервисов меняются; перед запуском сверить актуальные правила на dev.hh.ru и параметр формата работы (`schedule` / `work_format`).
- **Callback Platega.** Схема аутентификации callback (`X-MerchantId`/`X-Secret`) взята из примеров SDK, в открытой документации её нет. Защита не зависит от неё полностью: статус всегда перезапрашивается через API. Уточнить у менеджера Platega и при наличии подписи — добавить проверку в `verifyCallbackHeaders`.
- **Возвраты.** В FAQ обещан возврат, если PRO не использовался. Процесс ручной: оператор проверяет `user_actions` после `starts_at` и делает возврат в ЛК Platega.
- **Бесплатные LLM.** Лимиты и список `:free`-моделей у OpenRouter/Groq меняются; фолбэк на шаблон закрывает сбои, но качество текста будет ниже.
- **Персональные данные.** Резюме — персональные данные, сервер нужен в РФ (152-ФЗ), плюс политика обработки ПДн и согласие при первом сохранении резюме. В текущей версии экрана согласия нет.
