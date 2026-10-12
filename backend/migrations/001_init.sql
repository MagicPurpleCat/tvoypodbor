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

