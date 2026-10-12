// Периодические задачи. Каждая под Redis-локом — при нескольких инстансах выполняется один раз.
import { query } from '../db.js';
import { withLock } from '../redis.js';
import { searchSchema, searchVacancies } from '../services/hh.js';
import { enqueue, escapeHtml } from '../services/notify.js';
import { applyPaymentStatus, invalidateSubscription } from '../services/subscription.js';
import { getTransaction } from '../services/platega.js';

const MIN = 60_000;
const mskHour = () => (new Date().getUTCHours() + 3) % 24;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fmtSalary = (s: { from: number | null; to: number | null; currency: string } | null) => {
  if (!s) return '';
  const n = (x: number) => x.toLocaleString('ru-RU');
  const cur = s.currency === 'RUR' ? '₽' : s.currency;
  if (s.from && s.to) return `${n(s.from)}–${n(s.to)} ${cur}`;
  return s.from ? `от ${n(s.from)} ${cur}` : s.to ? `до ${n(s.to)} ${cur}` : '';
};

/** Раз в сутки (10:00–21:00 МСК): новые вакансии по последнему поиску пользователя. */
async function vacancyDigest() {
  if (mskHour() < 10 || mskHour() >= 21) return;
  const { rows } = await query<{ id: number; saved_search: unknown; last_digest_at: Date | null }>(
    `SELECT id, saved_search, last_digest_at FROM users
     WHERE notify_new_vacancies AND saved_search IS NOT NULL AND NOT bot_blocked
       AND (last_digest_at IS NULL OR last_digest_at < now() - interval '20 hours')
     ORDER BY last_digest_at NULLS FIRST LIMIT 200`,
  );
  for (const u of rows) {
    const parsed = searchSchema.safeParse(u.saved_search);
    await query(`UPDATE users SET last_digest_at = now() WHERE id = $1`, [u.id]);
    if (!parsed.success || !parsed.data.text) continue;
    const since = u.last_digest_at ?? new Date(Date.now() - 24 * 60 * MIN);
    try {
      const res = await searchVacancies(
        { ...parsed.data, page: 0, orderBy: 'publication_time' },
        since.toISOString(),
      );
      if (!res.found) continue;
      const list = res.items.slice(0, 5)
        .map((v) => `• ${escapeHtml(v.title)}${v.company ? ` — ${escapeHtml(v.company)}` : ''}${v.salary ? `, ${fmtSalary(v.salary)}` : ''}`)
        .join('\n');
      await enqueue(u.id, 'new_vacancies', { count: res.found, query: parsed.data.text, list });
    } catch (e) {
      console.error('digest', u.id, (e as Error).message);
    }
    await sleep(300); // бережём лимиты hh.ru
  }
}

/** Вакансия в избранном 3+ дня, а отклика нет — одно напоминание. */
async function favoriteReminders() {
  if (mskHour() < 10 || mskHour() >= 21) return;
  const { rows } = await query<{ user_id: number; vacancy_id: number; title: string; days: number }>(
    `UPDATE favorites f SET reminded_at = now()
     FROM vacancies v, users u
     WHERE v.id = f.vacancy_id AND u.id = f.user_id
       AND f.reminded_at IS NULL AND f.created_at < now() - interval '3 days'
       AND NOT v.archived AND u.notify_reminders AND NOT u.bot_blocked
       AND NOT EXISTS (SELECT 1 FROM user_actions a
                       WHERE a.user_id = f.user_id AND a.vacancy_id = f.vacancy_id AND a.action = 'apply')
     RETURNING f.user_id, f.vacancy_id, v.title, extract(day FROM now() - f.created_at)::int AS days`,
  );
  for (const r of rows) {
    await enqueue(r.user_id, 'favorite_reminder', { title: r.title, days: r.days, vacancyId: r.vacancy_id },
      { dedupKey: `fav:${r.user_id}:${r.vacancy_id}` });
  }
}

/** За сутки до конца оплаченного периода; и перевод истёкших подписок в expired. */
async function subscriptionLifecycle() {
  const { rows: expiring } = await query<{ id: number; user_id: number; expires_at: Date }>(
    `SELECT DISTINCT ON (user_id) id, user_id, expires_at FROM subscriptions
     WHERE status = 'active' ORDER BY user_id, expires_at DESC`,
  );
  for (const s of expiring) {
    const left = s.expires_at.getTime() - Date.now();
    if (left > 0 && left < 24 * 60 * MIN) {
      const { rowCount } = await query(
        `UPDATE subscriptions SET expiry_notified = true WHERE id = $1 AND NOT expiry_notified`, [s.id]);
      if (rowCount) await enqueue(s.user_id, 'sub_expiring', { expiresAt: s.expires_at.toISOString() },
        { dedupKey: `sub_expiring:${s.id}` });
    }
  }

  const { rows: expired } = await query<{ id: number; user_id: number }>(
    `UPDATE subscriptions SET status = 'expired', updated_at = now()
     WHERE status = 'active' AND expires_at <= now() RETURNING id, user_id`,
  );
  for (const s of expired) {
    await invalidateSubscription(s.user_id);
    const { rowCount } = await query(
      `SELECT 1 FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > now()`, [s.user_id]);
    if (!rowCount) await enqueue(s.user_id, 'sub_expired', {}, { dedupKey: `sub_expired:${s.id}` });
  }
}

/** Страховка от потерянных вебхуков: опрос статуса «зависших» платежей. */
async function reconcilePayments() {
  const { rows } = await query<{ provider_tx_id: string }>(
    `SELECT provider_tx_id FROM subscriptions
     WHERE status = 'pending' AND provider_tx_id IS NOT NULL
       AND created_at BETWEEN now() - interval '24 hours' AND now() - interval '2 minutes'
     LIMIT 50`,
  );
  for (const r of rows) {
    try {
      const t = await getTransaction(r.provider_tx_id);
      if (t.status !== 'PENDING') await applyPaymentStatus(r.provider_tx_id, t.status);
    } catch (e) {
      console.error('reconcile', r.provider_tx_id, (e as Error).message);
    }
  }
  await query(`UPDATE subscriptions SET status = 'canceled', updated_at = now()
               WHERE status = 'pending' AND created_at < now() - interval '24 hours'`);
}

const every = (name: string, ms: number, fn: () => Promise<void>) =>
  setInterval(() => withLock(name, ms, fn).catch((e) => console.error(name, e)), ms);

export function startScheduler() {
  return [
    every('reconcile', 2 * MIN, reconcilePayments),
    every('subscriptions', 10 * MIN, subscriptionLifecycle),
    every('digest', 30 * MIN, vacancyDigest),
    every('favorites', 60 * MIN, favoriteReminders),
  ];
}
