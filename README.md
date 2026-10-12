# ТвойПодбор

Telegram Mini App для поиска работы: вакансии hh.ru, резюме, генерация откликов, PRO-подписка через Platega.io, уведомления в чат с ботом.

Запуск на Amvera — [AMVERA.md](AMVERA.md). Полное описание — [SPEC.md](SPEC.md): допущения, схема БД, API, интеграция с Platega, тексты, промпты для макетов, деплой.

## Быстрый старт

```bash
cp .env.example .env            # заполнить BOT_TOKEN, PLATEGA_*, HH_USER_AGENT
docker compose up -d postgres redis
cd backend && npm i && npm run migrate:dev && npm run dev
cd webapp && npm i && npm run dev   # http://localhost:5173, вне Telegram — на моках
```

Проверки: `cd backend && npm run typecheck && npm test`, `cd webapp && npm run build`, контраст палитры — `node scripts/contrast.mjs`.
