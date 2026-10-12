// Отправка уведомлений из outbox. Несколько инстансов безопасны: FOR UPDATE SKIP LOCKED.
// Лимит Telegram ~30 сообщений/с на бота — берём пачку 25 раз в секунду.
import { GrammyError } from 'grammy';
import { query } from '../db.js';
import { bot } from '../bot/bot.js';
import { render } from '../services/notify.js';

const BATCH = 25;
const MAX_ATTEMPTS = 5;

async function tick() {
  const { rows } = await query<{ id: number; type: string; payload: Record<string, unknown>; attempts: number; telegram_id: number; user_id: number }>(
    `UPDATE notifications n SET status = 'sending', attempts = n.attempts + 1
     FROM users u
     WHERE n.id IN (
       SELECT id FROM notifications
       WHERE status = 'pending' AND scheduled_at <= now()
       ORDER BY scheduled_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     AND u.id = n.user_id
     RETURNING n.id, n.type, n.payload, n.attempts, n.user_id, u.telegram_id`,
    [BATCH],
  );

  await Promise.all(rows.map(async (n) => {
    try {
      const { text, keyboard } = render(n.type, n.payload);
      await bot.api.sendMessage(n.telegram_id, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      await query(`UPDATE notifications SET status = 'sent', sent_at = now() WHERE id = $1`, [n.id]);
    } catch (e) {
      const err = e as Error;
      if (e instanceof GrammyError && e.error_code === 403) {
        // Пользователь заблокировал бота — больше не пишем
        await query(`UPDATE users SET bot_blocked = true WHERE id = $1`, [n.user_id]);
        await query(`UPDATE notifications SET status = 'skipped', error = $2 WHERE id = $1`, [n.id, err.message]);
        return;
      }
      const retryAfter = e instanceof GrammyError ? (e.parameters.retry_after ?? 0) : 0;
      const final = n.attempts >= MAX_ATTEMPTS;
      await query(
        `UPDATE notifications SET status = $2, error = $3,
           scheduled_at = now() + make_interval(secs => $4) WHERE id = $1`,
        [n.id, final ? 'failed' : 'pending', err.message.slice(0, 500), Math.max(retryAfter, 2 ** n.attempts * 10)],
      );
    }
  }));
}

export function startNotificationWorker() {
  // Возврат «зависших» в sending после падения процесса
  void query(`UPDATE notifications SET status = 'pending' WHERE status = 'sending' AND created_at < now() - interval '5 minutes'`);
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (e) { console.error('notification worker', e); } finally { running = false; }
  }, 1000);
}
